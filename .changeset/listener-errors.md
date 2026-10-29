---
'synqable': patch
---

Fixed: a listener that throws no longer leaves the store half done. Measured on 0.3.0, every one of these is now fixed:

- A data listener (`settings:changed`, `tasks:added` and so on) that threw on a write stopped the mutator before it scheduled the save and the sync: the write stayed in memory, was never saved or pushed, and a `persisted()` from another caller resolved without it. The write is now saved and synced first; the mutator still throws the listener's error.
- A `$store:storage` listener that threw on `saving` left `isSaving` stuck on: every later save was skipped, `flush()` timed out, `persisted()` hung, and the error surfaced as an unhandled rejection. The save now completes, and the error is reported (it never threw out of the mutator, and still does not).
- A `$store:sync` listener that threw on `pending` stopped the write from being synced (and threw out of the mutator); one that threw on `started` was taken for a sync failure and retried after the backoff.
- A data listener that threw during a sync merge kept the merged data off storage and was taken for a sync failure; during a change from another tab (storage watch) it stopped the remaining listeners and surfaced in the adapter's callback.
- A `$store:state` listener that threw on `loading` made `load()` reject with the store stuck loading, so `ready()` never settled and `retryLoad()` refused.

How it behaves now: the store commits its own state before it notifies, and every listener runs even when an earlier one throws. A write or `load()` still throws the first listener error to its caller, after every listener ran, and reports any further ones (`load()` finishes first, so the store is `ready` when it rejects, as a throwing `ready` listener already did). Events with no caller to throw to (storage and sync status events, `storageStatus$` and `syncStatus$` subscribers, merge data events) report the error through `reportError` where it exists (in Deno and Bun an unhandled one can end the process, as the unhandled rejection it replaces could), and `console.error` otherwise. A multi-account store now reports a listener error from an account's load instead of swallowing it in its `load().catch(() => {})`. One visible ordering change: the save and the sync are now scheduled before listeners are notified, so on a write the `saving` event of an immediate save and the sync `pending` event come before the data event, and on a sync merge the `saving` event comes before the merge's data events. No API or type changes.
