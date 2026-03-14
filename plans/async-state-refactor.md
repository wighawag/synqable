# AsyncState Refactor: isLoading + loadError Pattern

## Overview

Refactor `AsyncState<T>` from a discriminated union with `'loading'` status to an orthogonal state model with `isLoading` boolean and `loadError` field. This matches the existing `storageStatus` and `syncStatus` patterns.

## Current vs Proposed Design

### Current Design
```typescript
type AsyncState<T> =
  | { status: 'idle'; account: undefined }
  | { status: 'loading'; account: `0x${string}` }
  | { status: 'ready'; account: `0x${string}`; data: T };
```

### Proposed Design
```typescript
type AsyncState<T> =
  | { status: 'idle'; account: undefined; isLoading: false; loadError: null }
  | { status: 'idle'; account: `0x${string}`; isLoading: true; loadError: null }   // Loading
  | { status: 'idle'; account: `0x${string}`; isLoading: false; loadError: Error } // Load failed
  | { status: 'ready'; account: `0x${string}`; isLoading: false; loadError: null; data: T };
```

Or simplified as a single object with conditional properties:
```typescript
interface AsyncStateBase {
  status: 'idle' | 'ready';
  account: `0x${string}` | undefined;
  isLoading: boolean;
  loadError: Error | null;
}

type AsyncState<T> = AsyncStateBase & (
  | { status: 'idle' }
  | { status: 'ready'; data: T }
);
```

## Files to Modify

### 1. packages/synqable/src/main/types.ts

**Changes:**
- Update `AsyncState<T>` type definition at line 244-247
- Consider updating `StateEvent` type at line 153 - may want to emit 'loading-started' / 'loading-complete' / 'load-error' events instead of status changes

### 2. packages/synqable/src/main/createSyncableStore.ts

**Changes:**
- Update initial `asyncState` at line 61 to include `isLoading: false, loadError: null`
- Update `load()` function at lines 449-508:
  - Wrap storage load in try-catch
  - Set `isLoading: true` when starting load
  - Set `loadError` on failure, `isLoading: false` when complete
- Update state transitions throughout

### 3. packages/synqable/test/multi-account.test.ts

**Changes:**
- Update checks for `state.status === 'loading'` to `state.isLoading === true`
- Restore the load failure test to verify `state.loadError` is set on failure

### 4. packages/synqable/test/syncable-store.test.ts

**Changes:**
- Update all checks for `state.status === 'loading'` to `state.isLoading === true`
- Add tests for `loadError` being set on storage failures

## State Transitions

```mermaid
stateDiagram-v2
    [*] --> idle_not_loading: Initial
    idle_not_loading --> idle_loading: load called
    idle_loading --> ready: load success
    idle_loading --> idle_error: load failure
    idle_error --> idle_loading: retryLoad called
    ready --> [*]: stop called
    idle_error --> [*]: stop called
    
    state idle_not_loading {
        status: idle
        isLoading: false
        loadError: null
    }
    
    state idle_loading {
        status: idle
        isLoading: true
        loadError: null
    }
    
    state idle_error {
        status: idle
        isLoading: false
        loadError: Error
    }
    
    state ready {
        status: ready
        isLoading: false
        loadError: null
        data: T
    }
```

## Benefits

1. **Consistent with existing patterns** - Matches `storageStatus.isSaving`/`storageError` and `syncStatus.isSyncing`/`syncError`
2. **Better error handling** - Load errors are captured in state instead of being unhandled rejections
3. **Retry-friendly** - UI can show "Retry" button based on `loadError` presence
4. **Simpler state machine** - Just `idle → ready`, loading is an overlay

## Migration Notes

- Breaking change: Code checking `state.status === 'loading'` must change to `state.isLoading`
- Tests need updating to use new state shape
- Multi-account manager can remain fire-and-forget since SyncableStore now handles errors internally
