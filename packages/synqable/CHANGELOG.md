# synqable

## 0.3.0

### Minor Changes

- 9e9d2f9: New: `persisted()`, on the store and on the write handle, to await that your writes are on storage. It resolves once a save that includes every write made before the call has succeeded, and rejects with the storage adapter's error when the save that included them failed and no further save is queued. It is not confused by saves other writes trigger, it does not poll, and it retries when the last save failed and nothing is queued, so calling it again is how to retry. A write held by the debounce is saved at once.

  ```ts
  const writer = await store.ready(); // or: await multiStore.ready()
  writer.set('secret', secret, {immediate: true});
  await writer.persisted(); // rejects if the secret did not reach storage
  ```

  It replaces the 0.2.1 workaround of awaiting `flush()` and then reading `storageStatus$`'s `storageError`, which was wrong two ways: `flush()` waits by polling every 10 ms, so a save for another write that started and failed inside one of those gaps made a stored write look lost; and with nothing pending it reported whatever error an earlier save left.

  `writer.persisted()` is the one handle method `stop()` does not revoke: a write accepted before `stop()` (an account switch) is still saved, and it still waits for that save, so a handle from a multi-account store answers for its own account across a switch. A stopped store never starts a new save (it would race the next store for the account), so when that last save fails the rejection is final. The multi-account store has no `persisted()` of its own: "the current store" may no longer be the one written to.

  Unchanged: the mutators, `flush()` (it still resolves when the save failed; its docs now say so), and the `storageStatus$` contract. The minor bump is because `SyncableStore` and `StoreWriter` gain a method, so code that implements either interface itself (a wrapper around a handle, say) must add `persisted`.

## 0.2.1

### Patch Changes

- fd2a2e9: A single-account store's `idle` state now always carries its own `account`, in `get()` and in `state$`: from creation, and after `retryLoad()` (previously a fresh store reported `account: undefined` until its load started). As a result, `idle` with `account: undefined` now means exactly "no account connected": only a multi-account store with no current account produces it (before any account, or after a disconnect), and while an account is connected every value of the multi-account `state$` carries that account, including the brief `idle` between a connect or switch and the start of the new store's load. Consumers can therefore tell "no account" from "an account whose data is about to load" from `state$` alone, without also subscribing to the multi-account store. Nothing breaks: the types are unchanged (`idle`'s `account` is still `` `0x${string}` | undefined ``), and the only behaviour change is that a value which used to be `undefined` is now the store's account.

## 0.2.0

### Minor Changes

- 5584e90: Writes need a handle that only a loaded store can give, so a write before the load no longer compiles.

  **Breaking:** the mutators (`set`, `update`, `patch`, `addItem`, `setItem`, `updateItem`, `patchItem`, `removeItem`) move off `SyncableStore` onto a write handle, `StoreWriter<S>`. Get it with `store.writer()` (synchronous: the handle if loaded now, `undefined` otherwise) or `await store.ready()` (resolves once loaded; rejects with a `StoreUnavailableError` on a load error or when the store is stopped first, rather than hanging; it does not start the load). The multi-account store has the same `writer()` and `ready()` for the current account, and its `ready()` also rejects when the account switches or disconnects before the load (`reason: 'account-switched'`) and at once when there is no account (`'no-account'`). The handle carries `account` and `read()` (the current data, deeply readonly). The runtime `Store is not ready` check stays as a defence.

  **Breaking:** a failed load is now its own status, `error`, in `AsyncState`, `StoreLifecycleState` and the `$store:state` event (`{type: 'error', error}`), with the error kept as `loadError`. `idle` always has `loadError: null`. `retryLoad()` is allowed from `error` only.

  **Breaking:** `stop()` is terminal and revokes the handle. Every handle method then throws a `StoreUnavailableError` with `reason: 'stopped'`. Before, a write through a stopped store was saved and pushed anyway and then silently overwritten by the next store for that account (measured; see `plans/typed-ready-writes.md`). `load()` after `stop()` now rejects, a load still in flight when `stop()` is called (an account switch during loading) no longer becomes `ready` or installs its listeners after they were torn down, and a stopped store no longer syncs.

  **Fixed:** `stop()` dropped a pending debounced save, so a write made within `debounceMs` of an account switch was lost. It is now saved. A `state$` listener that throws on `ready` no longer turns a loaded store into a failed one (the error propagates out of `load()`, the store stays `ready`), and a listener that calls `stop()` on `ready` tears down every listener the load installed.

  New exports: `StoreWriter`, `StoreUnavailableError`, `StoreUnavailableReason`.

  **Migrating from 0.0.13**

  This covers 0.1.0 as well, for callers moving straight from 0.0.13. Map fields merge exactly as before, so stored data needs no migration.
  1. **`permanent` is now `value`** (0.1.0). `permanent<T>()` becomes `value<T>()`, and the types follow: `PermanentField` to `ValueField`, `PermanentKeys` to `ValueKeys`, `ExtractPermanent` to `ExtractValue`, `mergePermanent` to `mergeValue`. Stored data is unchanged.
  2. **`update()` is gone on value fields** (0.1.0). Replace `update('field', partial)` on a value field with `patch('field', (current) => ({...current, ...partial}))` or a full `set`. If the field's properties are edited independently on different devices, make it a `record<T>()` instead, where `update` stamps only the properties supplied (no migration needed for that conversion). Keep `value` when the properties carry a joint invariant.
  3. **Write through the handle.** Each pattern maps directly:

     ```ts
     // before: awaited the load, then wrote on the store
     await store.load();
     store.set('settings', next);
     // after
     await store.load();
     store.writer()!.set('settings', next); // or: (await store.ready()).set(...)

     // before: guarded by hand, threw "Store is not ready" otherwise
     const state = store.get();
     if (state.status === 'ready') store.addItem('ops', id, op, {deleteAt});
     // after: the guard is the handle
     const writer = store.writer();
     if (writer) writer.addItem('ops', id, op, {deleteAt});

     // before: read the snapshot, then patch on the store (two checks)
     const s = store.get();
     if (s.status === 'ready' && s.data.ops[id]) store.patchItem('ops', id, fn);
     // after: one handle for both
     const w = store.writer();
     if (w && w.read().ops[id]) w.patchItem('ops', id, fn);

     // a writer that must wait for the load (and must not proceed without it)
     const secretWriter = await store.ready(); // rejects: 'load-failed' (cause: the load error) or 'stopped'
     secretWriter.set('secret', value, {immediate: true});
     ```

     On a multi-account store, `multi.get()?.addItem(...)` becomes `multi.writer()?.addItem(...)`, and `await multi.ready()` waits for the current account, rejecting with `'account-switched'`, `'no-account'`, `'stopped'` or `'load-failed'`. A handle is bound to its account: re-obtain it after a switch rather than keeping one across it, since a revoked handle throws.

  4. **Catch `StoreUnavailableError`** where you caught `Store is not ready`, and discriminate on `error.reason`.
  5. **A failed load is `status === 'error'`.** Replace `status === 'idle' && loadError` (on `get()` or `state$`) with `status === 'error'`, and a `$store:state` listener's `{type: 'idle', error}` with `{type: 'error', error}`. A `switch` over `status` gains the `'error'` case.
  6. **Do not reuse a stopped store.** Create a new one (the multi-account store already does on every switch).

### Patch Changes

- 2d4174f: Add brand assets: a theme-agnostic vector mark, a simplified icon for small sizes, and a 1280x640 social card carrying the wordmark and tagline. The README now leads with the card, and `media/build.sh` regenerates every derived asset deterministically with a drift check across the three copies of the mark geometry.

## 0.1.0

### Minor Changes

- ad9a400: Field types are now defined by merge granularity, and a third type is added.

  **Breaking:** `permanent<T>()` is renamed to `value<T>()`. The exported type names follow: `PermanentField` -> `ValueField`, `PermanentKeys` -> `ValueKeys`, `ExtractPermanent` -> `ExtractValue`, `mergePermanent` -> `mergeValue`.

  **Breaking:** `update()` is no longer available on value fields. A partial update cannot merge independently on a field that resolves as one unit, so the method was claiming a granularity the merge did not provide. Use `set()` or `patch()`, or make the field a `record`.

  **New:** `record<T>()`, a fixed set of named properties each merged independently by timestamp. Two devices editing different properties of the same struct now keep both edits, where a `value` field would discard one.

  | type          | merge granularity | key set              | deletion         |
  | ------------- | ----------------- | -------------------- | ---------------- |
  | `value<T>()`  | the whole value   | single value         | never deleted    |
  | `record<T>()` | per property      | fixed, heterogeneous | never deleted    |
  | `map<T>()`    | per key           | open, homogeneous    | `deleteAt` + TTL |

  Record fields emit the same field-level `:changed` event as value fields, so existing subscribers and `watchField` are unaffected. Converting a field from `value` to `record` needs no migration: the old field-level timestamp is used as the floor for properties that lack their own.

  Choose between `value` and `record` by asking whether the properties carry a joint invariant. `value<{start, end}>()` with `start <= end` must stay a value field: merging the properties independently can converge on a range that existed on no device. Prefer `value` when unsure.

  `record<T>()` rejects arrays and primitives at the schema with an explanatory type error, and rejects exotic objects (`Date`, `Map`, class instances) at merge time with a runtime error. None of them have independently mergeable properties; all belong in a `value` field.

  **Fixed:** `cleanup` rebuilt `$itemTimestamps` for map fields only, which would have wiped record per-property timestamps on every load and every merge.

## 0.0.13

### Patch Changes

- fix types

## 0.0.12

### Patch Changes

- add ignoreMissing option to not throw on removing item already removed

## 0.0.11

### Patch Changes

- 935a57b: use object-hash for tie-brak

## 0.0.10

### Patch Changes

- logging for storage

## 0.0.9

### Patch Changes

- 1813233: patch

## 0.0.8

### Patch Changes

- fix map empty

## 0.0.7

### Patch Changes

- fix

## 0.0.6

### Patch Changes

- fixmap unset

## 0.0.5

### Patch Changes

- new api for multi-account

## 0.0.4

### Patch Changes

- new api

## 0.0.3

### Patch Changes

- new release

## 0.0.2

### Patch Changes

- add readme

## 0.0.1

### Patch Changes

- first release
