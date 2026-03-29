# Unified Debounce + Queue Pattern for Storage and Sync

## Problem Statement

In `createSyncableStore.ts`, storage and sync operations have inconsistent patterns:

| Aspect | Storage (Current) | Sync (Current) |
|--------|------------------|----------------|
| Debounce | ❌ None | ✅ Yes (`debounceMs`) |
| Queue protection | ✅ Yes (`storageSavePending`) | ❌ None |
| Concurrent protection | ✅ Implicit via queue | ❌ Missing |

### Issues Identified

1. **Storage**: No debounce means every mutation triggers immediate disk I/O
2. **Sync**: No queue protection means concurrent syncs can occur from:
   - `handleVisibilityChange` (line 486-489)
   - `handleOnline` (line 495-500)
   - `syncIntervalTimer` (line 512-516)
   - `load()` (line 585-587)
   - `syncNow()` (line 930)

---

## Proposed Solution

Unify both operations to use the same pattern:

```
Mutation → Schedule (debounce) → Perform → Queue if busy → Process pending
```

### Configuration Changes

#### In `types.ts`

```typescript
export interface SyncConfig {
    /** Debounce delay for server sync (default: 1000ms) */
    debounceMs?: number;
    
    /** Debounce delay for local storage (default: 100ms) */
    storageDebounceMs?: number;
    
    // ... existing fields
}

export interface MutationOptions {
    /** 
     * Force immediate storage save, bypassing debounce.
     * Use for critical data that must persist immediately.
     */
    immediate?: boolean;
}
```

#### In `createSyncableStore.ts` - Updated Interface

```typescript
export interface SyncableStore<S extends Schema> {
    /** Set a permanent field value */
    set<K extends PermanentKeys<S>>(
        field: K, 
        value: ExtractPermanent<S[K]>, 
        options?: MutationOptions
    ): void;

    /** Patch a permanent field with partial updates */
    patch<K extends PermanentKeys<S>>(
        field: K, 
        value: DeepPartial<ExtractPermanent<S[K]>>, 
        options?: MutationOptions
    ): void;

    /** Add an item to a map field */
    add<K extends MapKeys<S>>(
        field: K,
        key: string,
        value: ExtractMapItem<S[K]>,
        options: { deleteAt: number; immediate?: boolean }
    ): void;

    /** Update an existing map item */
    update<K extends MapKeys<S>>(
        field: K, 
        key: string, 
        value: ExtractMapItem<S[K]>, 
        options?: MutationOptions
    ): void;

    /** Remove an item from a map field */
    remove<K extends MapKeys<S>>(
        field: K, 
        key: string, 
        options?: RemovalMutationOptions
    ): void;
    
    // ... rest unchanged
}
```

---

## Implementation Details

### Key Insight: Boolean Flags Only

Since `internalStorage` is a **reference** that's mutated in place, and the account is fixed for the lifetime of the store, we don't need to store data in pending state. Just boolean flags!

**Why this is correct:**
- The CRDT-style `$timestamps` capture when each field was modified
- Merge logic uses timestamps, not save/sync order
- If a race condition causes a later state to be saved, that's actually **more correct**
- Saving later state is always safe - it includes all prior changes

### State Variables (Simplified)

```typescript
// Storage state - just booleans!
let storageDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let storageSavePending = false;  // Just a flag, no data
let isStorageSaving = false;
let currentStoragePromise: Promise<void> | null = null;

// Sync state - just a boolean!
let syncPending = false;
```

### Storage Implementation (Simplified)

```typescript
const storageDebounceMs = syncConfig?.storageDebounceMs ?? 100;

function scheduleStorageSave(immediate = false): void {
    storageSavePending = true;
    
    if (immediate) {
        // Clear any pending debounce and execute now
        if (storageDebounceTimer) {
            clearTimeout(storageDebounceTimer);
            storageDebounceTimer = undefined;
        }
        performStorageSave();
        return;
    }
    
    // Debounce: reset timer on each call
    if (storageDebounceTimer) {
        clearTimeout(storageDebounceTimer);
    }
    
    storageDebounceTimer = setTimeout(() => {
        storageDebounceTimer = undefined;
        performStorageSave();
    }, storageDebounceMs);
}

async function performStorageSave(): Promise<void> {
    if (!storageSavePending) return;
    
    // If already saving, just ensure flag is set - will be processed after
    if (isStorageSaving) {
        return;
    }
    
    isStorageSaving = true;
    storageSavePending = false;
    mutableStorageStatus.isSaving = true;
    emitStorageEvent({ type: 'saving' });
    
    try {
        // Use internalStorage reference directly - always has latest state
        await storage.save(storageKey, internalStorage);
        mutableStorageStatus.lastSavedAt = clock();
        mutableStorageStatus.storageError = null;
    } catch (error) {
        mutableStorageStatus.storageError = error as Error;
        emitStorageEvent({ type: 'failed', error: error as Error });
    } finally {
        isStorageSaving = false;
        
        // Process any changes that came in during save
        if (storageSavePending) {
            await performStorageSave();
        } else {
            mutableStorageStatus.isSaving = false;
            emitStorageEvent({
                type: 'saved',
                timestamp: mutableStorageStatus.lastSavedAt ?? clock()
            });
        }
    }
}
```

### Sync Implementation (Simplified)

```typescript
async function performSync(retryCount = 0): Promise<void> {
    if (!syncAdapter || !internalStorage || asyncState.status !== 'ready') return;

    // Prevent concurrent syncs - just set flag
    if (mutableSyncStatus.isSyncing) {
        syncPending = true;
        return;
    }

    try {
        mutableSyncStatus.isSyncing = true;
        if (retryCount === 0) {
            emitSyncEvent({ type: 'started' });
        }

        // Use internalStorage reference directly - always has latest state
        const pullResponse = await syncAdapter.pull(account);
        
        // ... existing merge logic using internalStorage ...
        
        if (shouldPush) {
            // internalStorage always has latest state
            await syncAdapter.push(account, internalStorage, newCounter);
        }
        
        syncDirty = false;
        mutableSyncStatus.lastSyncedAt = clock();
        mutableSyncStatus.hasPendingSync = false;
        mutableSyncStatus.syncError = null;
        mutableSyncStatus.isSyncing = false;
        emitSyncEvent({ type: 'completed', timestamp: clock() });
        
    } catch (error) {
        if (retryCount < maxRetries) {
            const backoffDelay = retryBackoffMs * Math.pow(2, retryCount);
            setTimeout(() => {
                performSync(retryCount + 1);
            }, backoffDelay);
            return; // Don't process pending yet, retry will handle it
        } else {
            mutableSyncStatus.syncError = error as Error;
            mutableSyncStatus.isSyncing = false;
            emitSyncEvent({ type: 'failed', error: error as Error });
        }
    }
    
    // Process any sync requested during this one
    if (syncPending) {
        syncPending = false;
        performSync();
    }
}
```

### Updated Mutation Methods (Simplified)

```typescript
set<K extends PermanentKeys<S>>(
    field: K,
    value: ExtractPermanent<S[K]>,
    options?: MutationOptions
): void {
    if (asyncState.status !== 'ready' || !internalStorage) {
        throw new Error('Store is not ready');
    }

    const now = clock();
    (internalStorage.data as Record<string, unknown>)[field as string] = value;
    (internalStorage.$timestamps as Record<string, number>)[field as string] = now;

    asyncState = { ...asyncState, data: { ...internalStorage.data } };

    emitter.emit(
        `${String(field)}:changed` as keyof StoreEvents<S>,
        value as StoreEvents<S>[keyof StoreEvents<S>],
    );

    // No need to pass data - uses internalStorage reference
    scheduleStorageSave(options?.immediate);
    markDirty();
}

// Similar changes for patch, add, update, remove...
```

### Updated flush() Method

```typescript
async flush(timeoutMs = 30000): Promise<void> {
    const startTime = clock();
    
    // Clear any pending debounce and force immediate save
    if (storageDebounceTimer) {
        clearTimeout(storageDebounceTimer);
        storageDebounceTimer = undefined;
    }
    
    // Trigger save if there's pending data
    if (storageSavePending) {
        await performStorageSave();
    }
    
    // Wait for any in-progress save to complete
    while (mutableStorageStatus.isSaving) {
        if (clock() - startTime > timeoutMs) {
            throw new Error(`flush() timed out after ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, 10));
    }
}
```

---

## Test Plan

### Storage Debouncing Tests

```typescript
describe('Storage Debouncing', () => {
    it('should coalesce rapid saves into single storage write', async () => {
        const mockStorage = createMockStorage();
        const store = createSyncableStore({
            // ...config
            syncConfig: { storageDebounceMs: 50 }
        });
        await store.load();
        
        // Rapid mutations
        store.set('field1', 'value1');
        store.set('field1', 'value2');
        store.set('field1', 'value3');
        
        // Wait for debounce
        await new Promise(r => setTimeout(r, 100));
        
        // Should only have saved once with final value
        expect(mockStorage.saveCallCount).toBe(1);
        expect(mockStorage.lastSavedData.data.field1).toBe('value3');
    });

    it('should batch multiple field changes within debounce window', async () => {
        const mockStorage = createMockStorage();
        const store = createSyncableStore({ 
            syncConfig: { storageDebounceMs: 50 } 
        });
        await store.load();
        
        store.set('fieldA', 'A');
        store.set('fieldB', 'B');
        store.set('fieldC', 'C');
        
        await new Promise(r => setTimeout(r, 100));
        
        expect(mockStorage.saveCallCount).toBe(1);
        expect(mockStorage.lastSavedData.data).toEqual({
            fieldA: 'A',
            fieldB: 'B', 
            fieldC: 'C'
        });
    });
});
```

### Storage Queue Tests

```typescript
describe('Storage Queue', () => {
    it('should queue save when one is in progress', async () => {
        const mockStorage = createSlowMockStorage(100); // 100ms save delay
        const store = createSyncableStore({
            syncConfig: { storageDebounceMs: 0 } // No debounce for this test
        });
        await store.load();
        
        // First save starts immediately
        store.set('field', 'value1');
        
        // This should queue while first is in progress
        await new Promise(r => setTimeout(r, 50));
        store.set('field', 'value2');
        
        // Wait for both saves
        await store.flush();
        
        // Should have 2 saves: initial + queued
        expect(mockStorage.saveCallCount).toBe(2);
        expect(mockStorage.savedValues).toEqual(['value1', 'value2']);
    });

    it('should process pending save after current completes', async () => {
        const saveOrder: string[] = [];
        const mockStorage = createMockStorage({
            onSave: (data) => saveOrder.push(data.data.field)
        });
        const store = createSyncableStore({
            syncConfig: { storageDebounceMs: 0 }
        });
        await store.load();
        
        store.set('field', 'A');
        // Simulate long save
        await new Promise(r => setTimeout(r, 10));
        store.set('field', 'B');
        store.set('field', 'C');
        
        await store.flush();
        
        // A should save first, then C (B was overwritten before save)
        expect(saveOrder).toEqual(['A', 'C']);
    });
});
```

### Immediate Option Tests

```typescript
describe('Immediate Save Option', () => {
    it('should bypass debounce when immediate=true', async () => {
        const mockStorage = createMockStorage();
        const store = createSyncableStore({
            syncConfig: { storageDebounceMs: 1000 } // Long debounce
        });
        await store.load();
        
        const startTime = Date.now();
        store.set('critical', 'data', { immediate: true });
        await store.flush();
        
        // Should save immediately, not after 1000ms
        expect(Date.now() - startTime).toBeLessThan(100);
        expect(mockStorage.saveCallCount).toBe(1);
    });

    it('should clear pending debounce timer when immediate=true', async () => {
        const mockStorage = createMockStorage();
        const store = createSyncableStore({
            syncConfig: { storageDebounceMs: 500 }
        });
        await store.load();
        
        store.set('field', 'debounced');
        store.set('field', 'immediate', { immediate: true });
        
        await store.flush();
        
        // Only immediate save should occur
        expect(mockStorage.saveCallCount).toBe(1);
        expect(mockStorage.lastSavedData.data.field).toBe('immediate');
    });

    it('should work for all mutation types', async () => {
        const mockStorage = createMockStorage();
        const store = createSyncableStore({
            syncConfig: { storageDebounceMs: 1000 }
        });
        await store.load();
        
        store.patch('prefs', { theme: 'dark' }, { immediate: true });
        await store.flush();
        expect(mockStorage.saveCallCount).toBe(1);
        
        store.add('items', 'key1', { name: 'item' }, { deleteAt: 999, immediate: true });
        await store.flush();
        expect(mockStorage.saveCallCount).toBe(2);
        
        store.update('items', 'key1', { name: 'updated' }, { immediate: true });
        await store.flush();
        expect(mockStorage.saveCallCount).toBe(3);
        
        store.remove('items', 'key1', { immediate: true });
        await store.flush();
        expect(mockStorage.saveCallCount).toBe(4);
    });
});
```

### Sync Queue Tests

```typescript
describe('Sync Queue Protection', () => {
    it('should prevent concurrent syncs', async () => {
        let concurrentCalls = 0;
        let maxConcurrent = 0;
        
        const mockAdapter = createMockSyncAdapter({
            onPull: async () => {
                concurrentCalls++;
                maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
                await new Promise(r => setTimeout(r, 100));
                concurrentCalls--;
                return { success: true, data: null, counter: 0n };
            }
        });
        
        const store = createSyncableStore({
            sync: mockAdapter,
            syncConfig: { debounceMs: 0 }
        });
        await store.load();
        
        // Trigger multiple syncs rapidly
        store.syncNow();
        store.syncNow();
        store.syncNow();
        
        await new Promise(r => setTimeout(r, 500));
        
        // Should never have more than 1 concurrent sync
        expect(maxConcurrent).toBe(1);
    });

    it('should queue sync when called during active sync', async () => {
        let syncCount = 0;
        const mockAdapter = createMockSyncAdapter({
            onPull: async () => {
                syncCount++;
                await new Promise(r => setTimeout(r, 100));
                return { success: true, data: null, counter: 0n };
            }
        });
        
        const store = createSyncableStore({
            sync: mockAdapter,
            syncConfig: { debounceMs: 0 }
        });
        await store.load();
        
        // Start sync
        const firstSync = store.syncNow();
        
        // Queue another while first is running
        await new Promise(r => setTimeout(r, 50));
        store.syncNow();
        
        await firstSync;
        await new Promise(r => setTimeout(r, 200));
        
        // Should have done 2 syncs total
        expect(syncCount).toBe(2);
    });

    it('should coalesce multiple queued syncs into one', async () => {
        let syncCount = 0;
        const mockAdapter = createMockSyncAdapter({
            onPull: async () => {
                syncCount++;
                await new Promise(r => setTimeout(r, 100));
                return { success: true, data: null, counter: 0n };
            }
        });
        
        const store = createSyncableStore({
            sync: mockAdapter,
            syncConfig: { debounceMs: 0 }
        });
        await store.load();
        
        // Start sync and queue multiple
        store.syncNow();
        await new Promise(r => setTimeout(r, 50));
        store.syncNow();
        store.syncNow();
        store.syncNow();
        
        await new Promise(r => setTimeout(r, 300));
        
        // Should be exactly 2: original + one queued
        expect(syncCount).toBe(2);
    });
});
```

### Event Handler Tests

```typescript
describe('Visibility and Online Event Sync', () => {
    it('should not cause concurrent syncs from visibility change', async () => {
        let concurrentCalls = 0;
        let maxConcurrent = 0;
        
        const mockAdapter = createMockSyncAdapter({
            onPull: async () => {
                concurrentCalls++;
                maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
                await new Promise(r => setTimeout(r, 100));
                concurrentCalls--;
                return { success: true, data: null, counter: 0n };
            }
        });
        
        const store = createSyncableStore({
            sync: mockAdapter,
            syncConfig: { syncOnVisible: true }
        });
        await store.load();
        
        // Simulate rapid visibility changes
        document.dispatchEvent(new Event('visibilitychange'));
        document.dispatchEvent(new Event('visibilitychange'));
        document.dispatchEvent(new Event('visibilitychange'));
        
        await new Promise(r => setTimeout(r, 500));
        
        expect(maxConcurrent).toBe(1);
    });

    it('should not cause concurrent syncs from online event', async () => {
        let concurrentCalls = 0;
        let maxConcurrent = 0;
        
        const mockAdapter = createMockSyncAdapter({
            onPull: async () => {
                concurrentCalls++;
                maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
                await new Promise(r => setTimeout(r, 100));
                concurrentCalls--;
                return { success: true, data: null, counter: 0n };
            }
        });
        
        const store = createSyncableStore({
            sync: mockAdapter,
            syncConfig: { syncOnReconnect: true }
        });
        await store.load();
        
        // Simulate rapid online/offline
        window.dispatchEvent(new Event('offline'));
        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new Event('online'));
        
        await new Promise(r => setTimeout(r, 500));
        
        expect(maxConcurrent).toBe(1);
    });
});
```

### Flush Tests

```typescript
describe('flush() with Debouncing', () => {
    it('should wait for debounced storage operations', async () => {
        const mockStorage = createMockStorage();
        const store = createSyncableStore({
            syncConfig: { storageDebounceMs: 500 }
        });
        await store.load();
        
        store.set('field', 'value');
        
        // Flush should trigger immediate save
        const startTime = Date.now();
        await store.flush();
        
        expect(Date.now() - startTime).toBeLessThan(100);
        expect(mockStorage.saveCallCount).toBe(1);
    });

    it('should clear debounce timer and save pending data', async () => {
        const mockStorage = createMockStorage();
        const store = createSyncableStore({
            syncConfig: { storageDebounceMs: 10000 }
        });
        await store.load();
        
        store.set('a', '1');
        store.set('b', '2');
        store.set('c', '3');
        
        // Without flush, would wait 10 seconds
        await store.flush();
        
        expect(mockStorage.saveCallCount).toBe(1);
        expect(mockStorage.lastSavedData.data).toEqual({ a: '1', b: '2', c: '3' });
    });

    it('should wait for in-progress save to complete', async () => {
        const mockStorage = createSlowMockStorage(200);
        const store = createSyncableStore({
            syncConfig: { storageDebounceMs: 0 }
        });
        await store.load();
        
        store.set('field', 'value', { immediate: true });
        
        const startTime = Date.now();
        await store.flush();
        
        // Should have waited for the 200ms save
        expect(Date.now() - startTime).toBeGreaterThanOrEqual(200);
    });
});
```

---

## Migration Notes

### Breaking Changes

None - all changes are additive:
- New optional `storageDebounceMs` config
- New optional `MutationOptions` parameter on mutation methods
- Default behavior is compatible (debounce is low enough to be imperceptible)

### Default Values

| Setting | Default | Notes |
|---------|---------|-------|
| `storageDebounceMs` | 100ms | Fast enough for UX, saves I/O |
| `debounceMs` (sync) | 1000ms | Unchanged |

---

## Files to Modify

1. `packages/synqable/src/sync/types.ts`
   - Add `storageDebounceMs` to `SyncConfig`
   - Add `MutationOptions` interface
   - Export new types

2. `packages/synqable/src/sync/createSyncableStore.ts`
   - Update `SyncableStore` interface with optional `MutationOptions` parameter
   - Replace `storageSavePending: { account, data }` with `storageSavePending: boolean`
   - Add `syncPending: boolean` state variable
   - Add `storageDebounceTimer` state variable
   - Implement `scheduleStorageSave(immediate?: boolean)` function (no data param needed)
   - Update `performStorageSave()` to use `internalStorage` reference directly
   - Update `performSync()` with concurrent protection using `syncPending` flag
   - Update all mutation methods (`set`, `patch`, `add`, `update`, `remove`) to accept options
   - Update `flush()` to clear debounce timer and wait for pending saves

3. `packages/synqable/test/syncable-store.test.ts`
   - Add storage debouncing test suite
   - Add storage queue test suite
   - Add immediate option test suite
   - Add sync queue test suite
   - Add event handler sync test suite
   - Add updated flush test suite

---

## Summary of Changes

| Before | After |
|--------|-------|
| `storageSavePending: { account, data }` | `storageSavePending: boolean` |
| `saveToStorage(account, data)` | `scheduleStorageSave(immediate?)` |
| No storage debounce | `storageDebounceTimer` with 100ms default |
| No sync queue protection | `syncPending: boolean` flag |
| No `immediate` option | `MutationOptions.immediate` for all mutations |

**Key insight**: Since `internalStorage` is mutated in place and the account is fixed, we only need boolean flags. The CRDT-style timestamps ensure saving a later state is always correct.
