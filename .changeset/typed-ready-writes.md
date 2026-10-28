---
'synqable': minor
---

Writes need a handle that only a loaded store can give, so a write before the load no longer compiles.

**Breaking:** the mutators (`set`, `update`, `patch`, `addItem`, `setItem`, `updateItem`, `patchItem`, `removeItem`) move off `SyncableStore` onto a write handle, `StoreWriter<S>`. Get it with `store.writer()` (synchronous: the handle if loaded now, `undefined` otherwise) or `await store.ready()` (resolves once loaded; rejects with a `StoreUnavailableError` on a load error or when the store is stopped first, never hangs). The multi-account store has the same `writer()` and `ready()` for the current account, and its `ready()` also rejects when the account switches or disconnects before the load (`reason: 'account-switched'`) and at once when there is no account (`'no-account'`). The handle carries `account` and `read()` (the current data, deeply readonly). The runtime `Store is not ready` check stays as a defence.

**Breaking:** a failed load is now its own status, `error`, in `AsyncState`, `StoreLifecycleState` and the `$store:state` event (`{type: 'error', error}`), with the error kept as `loadError`. `idle` always has `loadError: null`. `retryLoad()` is allowed from `error` only.

**Breaking:** `stop()` is terminal and revokes the handle. Every handle method then throws a `StoreUnavailableError` with `reason: 'stopped'`. Before, a write through a stopped store was saved and pushed anyway and then silently overwritten by the next store for that account (measured; see `plans/typed-ready-writes.md`). `load()` after `stop()` now throws, and a load still in flight when `stop()` is called (an account switch during loading) no longer becomes `ready` or installs its listeners after they were torn down.

New exports: `StoreWriter`, `StoreUnavailableError`, `StoreUnavailableReason`.

## Migrating from 0.0.13

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
   const w = await store.ready(); // rejects: 'load-failed' (cause: the load error) or 'stopped'
   w.set('secret', value, {immediate: true});
   ```

   On a multi-account store, `multi.get()?.addItem(...)` becomes `multi.writer()?.addItem(...)`, and `await multi.ready()` waits for the current account, rejecting with `'account-switched'`, `'no-account'`, `'stopped'` or `'load-failed'`. A handle is bound to its account: re-obtain it after a switch rather than keeping one across it, since a revoked handle throws.

4. **Catch `StoreUnavailableError`** where you caught `Store is not ready`, and discriminate on `error.reason`.

5. **A failed load is `status === 'error'`.** Replace `status === 'idle' && loadError` (on `get()` or `state$`) with `status === 'error'`, and a `$store:state` listener's `{type: 'idle', error}` with `{type: 'error', error}`. A `switch` over `status` gains the `'error'` case.

6. **Do not reuse a stopped store.** Create a new one (the multi-account store already does on every switch).
