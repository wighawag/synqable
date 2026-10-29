# ADR: Writes need a handle that only a loaded store can give

**Status:** accepted

## Context

A store's mutators (`set`, `update`, `addItem`, `setItem`, `updateItem`, `patch`, `patchItem`, `removeItem`) were methods of `SyncableStore` itself, so they were reachable on a store that had not loaded, and threw `Store is not ready` at runtime. Loading is asynchronous for every adapter (encryption goes through `crypto.subtle`, which has no synchronous form, and sync arrives after `ready`), it is per account, and it repeats on every account switch. "Not loaded yet" is therefore an ordinary state that every caller must handle, and the types did not make them.

Gating the UI is not enough. The consumer that asked for this (jolly-roger's account data, which will hold a commit-reveal game's secret) has writers no click drives: timers that auto-commit or auto-reveal, and a fallback on cycle ticks. A write lost before the store has loaded costs the player their stake.

Two measurements on 0.1.0 (scripts run as throwaway vitest files, not kept):

1. **A write after `stop()` is not refused.** The store stays `ready`, the write lands in memory, the storage save fires anyway (the debounce timer is re-armed after `stop()` cleared it), and the sync push fires too.
2. **Across an account switch that write is lost silently.** Account A's store is captured, the account switches to B and back to A, and a fresh store for A loads. A write through the captured (stopped) store reaches A's storage, but the fresh store never sees it (nothing watches a same-tab save), and the fresh store's next save replaces the whole blob, erasing it. No error is raised anywhere.

## Decision

**The mutators move off the store onto a write handle, `StoreWriter<S>`, that only a loaded store hands out.** A caller that has not proved the store is loaded has no expression of type `StoreWriter<S>`, so the compiler rejects the write. There are two ways to obtain it:

- `store.writer(): StoreWriter<S> | undefined` is synchronous: the handle when the store is loaded now, `undefined` otherwise. For a writer that has its own fallback (the transaction writer's in-flight ledger).
- `store.ready(): Promise<StoreWriter<S>>` resolves to the handle once loaded. It rejects with a `StoreUnavailableError` on a load error (`reason: 'load-failed'`, the load error as `cause`), and rejects rather than hangs when the store is stopped before it loads (`'stopped'`). For a writer that must wait (the submission's commit).

The multi-account store offers the same two methods for the current account. Its `ready()` rejects with `'account-switched'` when the account changes (or disconnects) before the current store loads, `'stopped'` when its last subscriber leaves, and `'no-account'` at once when there is no current store, rather than waiting for an account that may never come.

**One handle per store, revoked by `stop()`.** The handle is created when the store becomes ready and is the same object for the store's lifetime. `stop()` revokes it: every mutator then throws a `StoreUnavailableError` with `reason: 'stopped'`, so a handle held across an account switch fails loudly instead of measurement 2. `stop()` is also terminal now: `load()` after it rejects, a load still in flight when it is called no longer reaches `ready` (it used to, and installed its storage watch and global listeners after they had been torn down), a stopped store no longer syncs (a merge saved by it would race the fresh store for the same account), and `writer()` returns `undefined`. A write accepted before `stop()` is still saved: `stop()` used to drop the pending debounced save, losing a write made within `debounceMs` of an account switch, which is the same silent loss as measurement 2 from the other side (found in review).

**Ready is announced last.** On a successful load the store becomes `ready`, installs its storage watch and global listeners, resolves pending `ready()` calls and starts the first sync, and only then emits the `ready` event. So a listener that calls `stop()` on `ready` tears down what is really installed, and a listener that throws on `ready` propagates out of `load()` without turning a loaded store into `error` (it used to, because the emit sat inside the load's `try`).

The runtime `Store is not ready` check stays inside every mutator as a defence, for a caller that casts its way past the types.

**A distinct `error` status** replaces `idle` with `loadError`, in `AsyncState`, `StoreLifecycleState` and the `$store:state` event. The error object stays on it as `loadError`, and `idle` now always has `loadError: null`. `retryLoad()` is allowed from `error` only.

The handle also carries `account` (which account it writes to) and `read()` (the current data, deeply readonly), so a read-modify-write needs one narrowing, not two. `read()` through a revoked handle throws like a write: a handle is a claim that its store is live. It is a method rather than a `data` getter because a getter that throws breaks anything that inspects the handle (a debugger, a test matcher walking its properties), which the first version of this change measured.

Reads do not change: `get()` narrows on `status === 'ready'` for `data` as before, and `watchField`, `watchItem`, `watchItemIds` and `state$` are untouched.

## Rejected

- **A synchronous load.** Impossible with encryption: `crypto.subtle` is asynchronous only.
- **Queueing writes made before the load.** It makes "written" mean "will be written". A secret must be durably stored before the transaction that depends on it is sent, and a queued write is not stored.
- **Runtime throws only.** Unchecked: the failure surfaces in production, in a timer, after the stake is sent.
- **Mutators on the `ready` arm of `get()`'s union.** `get()` returns a deeply readonly snapshot that is replaced on every write; putting mutators on it mixes a value with a capability, makes the handle change identity on every write, and gives no place to hang revocation. A separate handle is a stable object that can be revoked.
- **A `stopped` status in `AsyncState`.** It would change every read (R7). `writer()` returning `undefined` and `ready()` rejecting are the signal a writer needs; a reader of a stopped store still sees its last data, as before.
- **`ready()` calling `load()`.** Loading stays explicit (the single-account design's decision); the multi-account store already loads for you.

## Consequences

- **Breaking:** `store.set(...)` and the other mutators no longer exist on `SyncableStore`; callers go through `store.writer()` or `await store.ready()`. `status === 'idle' && loadError` becomes `status === 'error'`; the `$store:state` event `{type: 'idle', error}` becomes `{type: 'error', error}`.
- A writer obtained once and kept stays valid until `stop()`, so code that writes repeatedly can hold it; code that may outlive an account switch must re-obtain it, and is told so by the throw.
- `flush()` stays on the store, not the handle. Note that `flush()` resolves even when the save fails (the failure is reported through `storageStatus$`), so a caller that needs "durably stored" must check `storageStatus$`'s `storageError` after it. Left as is here; it is a separate change. (Done in 0.3.0 as `persisted()` on the store and the handle, which settles on the save that includes the caller's writes; `flush()` is unchanged.)
