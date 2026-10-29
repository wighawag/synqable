---
'synqable': minor
---

New: `persisted()`, on the store and on the write handle, to await that your writes are on storage. It resolves once a save that includes every write made before the call has succeeded, and rejects with the storage adapter's error when the save that included them failed and no further save is queued. It is not confused by saves other writes trigger, it does not poll, and it retries when the last save failed and nothing is queued, so calling it again is how to retry. A write held by the debounce is saved at once.

```ts
const writer = await store.ready(); // or: await multiStore.ready()
writer.set('secret', secret, {immediate: true});
await writer.persisted(); // rejects if the secret did not reach storage
```

It replaces the 0.2.1 workaround of awaiting `flush()` and then reading `storageStatus$`'s `storageError`, which was wrong two ways: `flush()` waits by polling every 10 ms, so a save for another write that started and failed inside one of those gaps made a stored write look lost; and with nothing pending it reported whatever error an earlier save left.

`writer.persisted()` is the one handle method `stop()` does not revoke: a write accepted before `stop()` (an account switch) is still saved, and it still waits for that save, so a handle from a multi-account store answers for its own account across a switch. A stopped store never starts a new save (it would race the next store for the account), so when that last save fails the rejection is final. The multi-account store has no `persisted()` of its own: "the current store" may no longer be the one written to.

Unchanged: the mutators, `flush()` (it still resolves when the save failed; its docs now say so), and the `storageStatus$` contract. The minor bump is because `SyncableStore` and `StoreWriter` gain a method, so code that implements either interface itself (a wrapper around a handle, say) must add `persisted`.
