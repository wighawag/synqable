# Multi-Account Derived Readables

## Overview

Enhance `MultiAccountStore` with derived reactive stores that automatically handle account switching:

1. **Rename** `accountState` → `state$` (consistency with `SyncableStore`)
2. **Add** `syncStatus$` and `storageStatus$` (derived from current store)
3. **Add** `watchField`, `watchItem`, `watchItemIds` (eliminate double subscriptions)

## Problem Statement

Currently, to watch data across account switches, users need to double-subscribe:

```typescript
// ❌ Current approach - awkward double subscription
multiStore.subscribe((store) => {
  if (store) {
    const unsub = store.watchField('settings').subscribe(settings => {
      // handle settings...
    });
    // Must track unsub and call it on next account change!
  }
});

// Same problem for status observing
let syncUnsub: (() => void) | undefined;
multiStore.subscribe((store) => {
  syncUnsub?.();
  if (store) {
    syncUnsub = store.syncStatus$.subscribe(status => { ... });
  }
});
```

This is error-prone because:
1. Users must manually manage nested unsubscriptions
2. Easy to create memory leaks by forgetting to unsubscribe
3. Verbose and repetitive code

## Solution

Add derived readables directly to `MultiAccountStore`:

```typescript
// ✅ New approach - single subscription
multiStore.state$.subscribe(state => { ... });
multiStore.syncStatus$.subscribe(status => { ... });
multiStore.storageStatus$.subscribe(status => { ... });
multiStore.watchField('settings').subscribe(settings => { ... });
```

## Complete API Design

### Updated `MultiAccountStore<S>` Interface

```typescript
interface MultiAccountStore<S extends Schema> {
  // ============ Existing ============
  
  /** Svelte store contract - subscribe to current store changes */
  subscribe(callback: (store: SyncableStore<S> | null) => void): () => void;

  /** Synchronous access to current store */
  get(): SyncableStore<S> | null;

  // ============ Renamed ============
  
  /**
   * Reactive lifecycle state derived from current store.
   * Returns idle state when no account connected.
   * RENAMED from accountState for consistency with SyncableStore.state$
   */
  readonly state$: Readable<StoreLifecycleState>;

  // ============ New Status Readables ============

  /**
   * Reactive sync status derived from current store.
   * Returns idle status when no account connected.
   */
  readonly syncStatus$: Readable<SyncStatus>;

  /**
   * Reactive storage status derived from current store.
   * Returns idle status when no account connected.
   */
  readonly storageStatus$: Readable<StorageStatus>;

  // ============ New Watch Methods ============

  /**
   * Watch a field reactively across account switches.
   * Returns undefined when no account is connected or store is loading.
   */
  watchField<K extends keyof S>(field: K): Readable<DataOf<S>[K] | undefined>;

  /**
   * Watch a specific map item reactively across account switches.
   * Returns undefined when no account is connected or item doesn't exist.
   */
  watchItem<K extends MapKeys<S>>(
    field: K,
    key: string,
  ): Readable<(ExtractMapItem<S[K]> & {deleteAt: number}) | undefined>;

  /**
   * Watch map field IDs reactively across account switches.
   * Returns empty array when no account is connected.
   */
  watchItemIds<K extends MapKeys<S>>(field: K): Readable<string[]>;
}
```

### Behavior Matrix

| Account State | `state$` | `syncStatus$` | `storageStatus$` | `watchField(...)` |
|---------------|----------|---------------|------------------|-------------------|
| No account    | `{status: 'idle', ...}` | `{isSyncing: false, isOnline: true, ...}` | `{isSaving: false, ...}` | `undefined` |
| Loading       | `{status: 'loading', ...}` | (from store) | (from store) | `undefined` |
| Ready         | `{status: 'ready', ...}` | (from store) | (from store) | field value |
| Account switch | Automatically re-subscribes to new store |

### Default Values When No Account

```typescript
const idleLifecycleState: StoreLifecycleState = {
  status: 'idle',
  account: undefined,
  isLoading: false,
  loadError: null,
};

const idleSyncStatus: SyncStatus = {
  isSyncing: false,
  isOnline: true,  // Assume online by default
  hasPendingSync: false,
  lastSyncedAt: null,
  syncError: null,
  displayState: 'idle',
};

const idleStorageStatus: StorageStatus = {
  isSaving: false,
  lastSavedAt: null,
  storageError: null,
  displayState: 'idle',
};
```

## Implementation Plan

### Step 1: Update Type Imports

In `packages/synqable/src/multi-account/types.ts`:

```typescript
import type {
  Schema,
  SyncableStore,
  Readable,
  StoreLifecycleState,
  StorageStatus,       // NEW
  DataOf,              // NEW
  MapKeys,             // NEW
  ExtractMapItem,      // NEW
} from '../main/types.js';

import type {SyncStatus} from '../sync/types.js';  // NEW
```

### Step 2: Update Interface

In `packages/synqable/src/multi-account/types.ts`:

```typescript
export interface MultiAccountStore<S extends Schema> {
  subscribe(callback: (store: SyncableStore<S> | null) => void): () => void;
  get(): SyncableStore<S> | null;

  // Renamed from accountState
  readonly state$: Readable<StoreLifecycleState>;
  
  // New status readables
  readonly syncStatus$: Readable<SyncStatus>;
  readonly storageStatus$: Readable<StorageStatus>;

  // New watch methods
  watchField<K extends keyof S>(field: K): Readable<DataOf<S>[K] | undefined>;
  watchItem<K extends MapKeys<S>>(
    field: K,
    key: string,
  ): Readable<(ExtractMapItem<S[K]> & {deleteAt: number}) | undefined>;
  watchItemIds<K extends MapKeys<S>>(field: K): Readable<string[]>;
}
```

### Step 3: Update Implementation

In `packages/synqable/src/multi-account/index.ts`:

#### 3.1: Add New Imports

```typescript
import type {
  Schema,
  SyncableStore,
  Readable,
  StoreLifecycleState,
  StorageStatus,      // NEW
  DataOf,             // NEW
  MapKeys,            // NEW
  ExtractMapItem,     // NEW
} from '../main/types.js';

import type {SyncStatus} from '../sync/types.js';  // NEW
```

#### 3.2: Add Default Status Values

```typescript
const idleSyncStatus: SyncStatus = {
  isSyncing: false,
  isOnline: true,
  hasPendingSync: false,
  lastSyncedAt: null,
  syncError: null,
  get displayState() {
    return 'idle' as const;
  },
};

const idleStorageStatus: StorageStatus = {
  isSaving: false,
  lastSavedAt: null,
  storageError: null,
  get displayState() {
    return 'idle' as const;
  },
};
```

#### 3.3: Create Generic Derived Readable Helper

```typescript
/**
 * Creates a derived readable that delegates to the current store's readable.
 * Automatically re-subscribes when account changes.
 */
function createDerivedReadable<T>(
  getStoreReadable: (store: SyncableStore<S>) => Readable<T>,
  defaultValue: T,
): Readable<T> {
  const derivedSubscribers = new Set<(value: T) => void>();
  let currentDerivedUnsub: (() => void) | undefined;
  let latestDerivedValue: T = defaultValue;

  // Track this derived readable for account change notifications
  const derivedInfo = {
    setupOnStore(store: SyncableStore<S> | null): void {
      // Cleanup previous subscription
      currentDerivedUnsub?.();
      currentDerivedUnsub = undefined;

      if (!store) {
        if (latestDerivedValue !== defaultValue) {
          latestDerivedValue = defaultValue;
          notifyDerivedSubscribers();
        }
        return;
      }

      // Subscribe to the store's readable
      const storeReadable = getStoreReadable(store);
      currentDerivedUnsub = storeReadable.subscribe((value) => {
        latestDerivedValue = value;
        notifyDerivedSubscribers();
      });
    },
    subscribers: derivedSubscribers,
    cleanup(): void {
      currentDerivedUnsub?.();
      currentDerivedUnsub = undefined;
    },
  };

  // Register for account change notifications
  derivedReadables.add(derivedInfo);

  function notifyDerivedSubscribers(): void {
    for (const callback of derivedSubscribers) {
      callback(latestDerivedValue);
    }
  }

  return {
    subscribe(callback: (value: T) => void): () => void {
      // Start lifecycle if this is the first subscriber overall
      if (!hasAnySubscribers()) {
        start();
      }

      // Setup on current store if this is first subscriber for this derived
      if (derivedSubscribers.size === 0) {
        derivedInfo.setupOnStore(currentStore);
      }

      derivedSubscribers.add(callback);
      callback(latestDerivedValue); // Svelte store contract

      return () => {
        derivedSubscribers.delete(callback);

        // Cleanup if no more subscribers for this derived
        if (derivedSubscribers.size === 0) {
          derivedInfo.cleanup();
        }

        // Stop lifecycle if no subscribers overall
        if (!hasAnySubscribers()) {
          stop();
        }
      };
    },
  };
}
```

#### 3.4: Track All Derived Readables

```typescript
// Track all derived readables for account change notifications
const derivedReadables = new Set<{
  setupOnStore(store: SyncableStore<S> | null): void;
  subscribers: Set<(value: unknown) => void>;
  cleanup(): void;
}>();

function hasAnySubscribers(): boolean {
  if (subscribers.size > 0) return true;
  for (const derived of derivedReadables) {
    if (derived.subscribers.size > 0) return true;
  }
  return false;
}
```

#### 3.5: Update Account Change Handler

```typescript
function handleAccountChange(value: Account | AccountWithSigner | undefined): void {
  // ... existing code to stop old store and create new one ...

  // Notify all active derived readables about the new store
  for (const derived of derivedReadables) {
    if (derived.subscribers.size > 0) {
      derived.setupOnStore(currentStore);
    }
  }

  // ... rest of existing code ...
}
```

#### 3.6: Create the Derived Readables

```typescript
// Rename: accountState -> state$
const state$ = createDerivedReadable<StoreLifecycleState>(
  (store) => store.state$,
  {status: 'idle', account: undefined, isLoading: false, loadError: null},
);

// NEW: syncStatus$
const syncStatus$ = createDerivedReadable<SyncStatus>(
  (store) => store.syncStatus$,
  idleSyncStatus,
);

// NEW: storageStatus$
const storageStatus$ = createDerivedReadable<StorageStatus>(
  (store) => store.storageStatus$,
  idleStorageStatus,
);
```

#### 3.7: Implement Watch Methods

```typescript
function watchField<K extends keyof S>(field: K): Readable<DataOf<S>[K] | undefined> {
  return createDerivedReadable<DataOf<S>[K] | undefined>(
    (store) => store.watchField(field),
    undefined,
  );
}

function watchItem<K extends MapKeys<S>>(
  field: K,
  key: string,
): Readable<(ExtractMapItem<S[K]> & {deleteAt: number}) | undefined> {
  return createDerivedReadable(
    (store) => store.watchItem(field, key),
    undefined,
  );
}

function watchItemIds<K extends MapKeys<S>>(field: K): Readable<string[]> {
  return createDerivedReadable(
    (store) => store.watchItemIds(field),
    [],
  );
}
```

#### 3.8: Update Return Object

```typescript
return {
  subscribe(callback: (store: SyncableStore<S> | null) => void): () => void {
    // ... existing implementation ...
  },

  get(): SyncableStore<S> | null {
    return currentStore;
  },

  // Renamed from accountState
  state$,
  
  // NEW
  syncStatus$,
  storageStatus$,
  watchField,
  watchItem,
  watchItemIds,
};
```

#### 3.9: Update Cleanup

```typescript
function stop(): void {
  unsubscribeAccount?.();
  unsubscribeAccount = undefined;
  
  // Cleanup all derived readables
  for (const derived of derivedReadables) {
    derived.cleanup();
  }
  
  currentStore?.stop();
  currentStore = null;
  current = undefined;
}
```

### Step 4: Update Tests

In `packages/synqable/test/multi-account.test.ts`:

1. **Rename test references**: `accountState` → `state$`
2. **Add tests for `syncStatus$`**
3. **Add tests for `storageStatus$`**
4. **Add tests for watch methods**

## Test Cases

### State$ (renamed from accountState)

```typescript
describe('state$ (renamed from accountState)', () => {
  it('returns idle state when no account connected', () => {
    const multiStore = createMultiAccountStore({ ... });
    
    let state: StoreLifecycleState | undefined;
    multiStore.state$.subscribe(s => { state = s; });
    
    expect(state?.status).toBe('idle');
  });

  // ... existing tests updated to use state$ ...
});
```

### SyncStatus$

```typescript
describe('syncStatus$', () => {
  it('returns idle sync status when no account connected', () => {
    const multiStore = createMultiAccountStore({ ... });
    
    let status: SyncStatus | undefined;
    multiStore.syncStatus$.subscribe(s => { status = s; });
    
    expect(status?.isSyncing).toBe(false);
    expect(status?.displayState).toBe('idle');
  });

  it('reflects current store sync status when connected', async () => {
    const multiStore = createMultiAccountStore({ ... });
    mockAccount.setAccount('0x1234...');
    
    let status: SyncStatus | undefined;
    multiStore.syncStatus$.subscribe(s => { status = s; });
    
    await new Promise(r => setTimeout(r, 50));
    
    // Status should come from the underlying store
    expect(status).toBeDefined();
    expect(status?.isSyncing).toBe(false); // After load completes
  });

  it('updates when account switches', async () => {
    const multiStore = createMultiAccountStore({ ... });
    
    const statuses: SyncStatus[] = [];
    multiStore.syncStatus$.subscribe(s => { statuses.push(s); });
    
    mockAccount.setAccount('0x1111...');
    await new Promise(r => setTimeout(r, 50));
    
    mockAccount.setAccount('0x2222...');
    await new Promise(r => setTimeout(r, 50));
    
    // Should have transitioned through multiple status updates
    expect(statuses.length).toBeGreaterThan(1);
  });
});
```

### StorageStatus$

```typescript
describe('storageStatus$', () => {
  it('returns idle storage status when no account connected', () => {
    const multiStore = createMultiAccountStore({ ... });
    
    let status: StorageStatus | undefined;
    multiStore.storageStatus$.subscribe(s => { status = s; });
    
    expect(status?.isSaving).toBe(false);
    expect(status?.displayState).toBe('idle');
  });

  it('reflects current store storage status when connected', async () => {
    const multiStore = createMultiAccountStore({ ... });
    mockAccount.setAccount('0x1234...');
    
    let status: StorageStatus | undefined;
    multiStore.storageStatus$.subscribe(s => { status = s; });
    
    await new Promise(r => setTimeout(r, 50));
    
    expect(status).toBeDefined();
  });
});
```

### Watch Methods

```typescript
describe('watchField', () => {
  it('returns undefined when no account connected', () => {
    const multiStore = createMultiAccountStore({ ... });
    
    let value: Settings | undefined;
    multiStore.watchField('settings').subscribe(v => { value = v; });
    
    expect(value).toBeUndefined();
  });

  it('returns field value when account connected', async () => {
    const multiStore = createMultiAccountStore({ ... });
    mockAccount.setAccount('0x1234...');
    
    let value: Settings | undefined;
    multiStore.watchField('settings').subscribe(v => { value = v; });
    
    await new Promise(r => setTimeout(r, 50));
    expect(value).toEqual({ theme: 'dark' });
  });

  it('automatically updates on account switch', async () => {
    // ... as shown earlier ...
  });

  it('reacts to mutations in current store', async () => {
    // ... as shown earlier ...
  });
});

describe('watchItem', () => {
  // ... as shown earlier ...
});

describe('watchItemIds', () => {
  // ... as shown earlier ...
});
```

### Lifecycle Management

```typescript
describe('lifecycle with derived readables', () => {
  it('starts listening when any derived readable gets subscriber', () => {
    const multiStore = createMultiAccountStore({ ... });
    
    expect(mockAccount.getSubscriberCount()).toBe(0);
    
    const unsub = multiStore.syncStatus$.subscribe(() => {});
    expect(mockAccount.getSubscriberCount()).toBe(1);
    
    unsub();
    expect(mockAccount.getSubscriberCount()).toBe(0);
  });

  it('maintains lifecycle with mixed subscriber types', () => {
    const multiStore = createMultiAccountStore({ ... });
    
    const unsub1 = multiStore.subscribe(() => {});
    const unsub2 = multiStore.state$.subscribe(() => {});
    const unsub3 = multiStore.syncStatus$.subscribe(() => {});
    const unsub4 = multiStore.watchField('settings').subscribe(() => {});
    
    expect(mockAccount.getSubscriberCount()).toBe(1);
    
    unsub1();
    unsub2();
    unsub3();
    expect(mockAccount.getSubscriberCount()).toBe(1); // watchField still active
    
    unsub4();
    expect(mockAccount.getSubscriberCount()).toBe(0); // All gone
  });
});
```

## Files to Modify

| File | Changes |
|------|---------|
| `packages/synqable/src/multi-account/types.ts` | Add imports for `StorageStatus`, `DataOf`, `MapKeys`, `ExtractMapItem`, `SyncStatus`. Rename `accountState` to `state$`. Add `syncStatus$`, `storageStatus$`, `watchField`, `watchItem`, `watchItemIds`. |
| `packages/synqable/src/multi-account/index.ts` | Implement all new derived readables. Rename internal `accountState` to `state$`. Add helper function for creating derived readables. Update cleanup logic. |
| `packages/synqable/test/multi-account.test.ts` | Rename all `accountState` references to `state$`. Add tests for `syncStatus$`, `storageStatus$`, and watch methods. Add lifecycle tests for mixed subscriber types. |

## Migration Notes

### Breaking Change: `accountState` → `state$`

This is a breaking change. Users must update their code:

```typescript
// Before
multiStore.accountState.subscribe(state => { ... });

// After
multiStore.state$.subscribe(state => { ... });
```

The rename is justified because:
1. Consistency with `SyncableStore.state$`
2. The `$` suffix convention for Svelte stores
3. Clearer naming (it's state, not "account state")

## Summary

This enhancement provides:

| Feature | Benefit |
|---------|---------|
| `state$` (rename) | Consistent naming with `SyncableStore` |
| `syncStatus$` | Observe sync status without double-subscription |
| `storageStatus$` | Observe storage status without double-subscription |
| `watchField()` | Watch fields without double-subscription |
| `watchItem()` | Watch items without double-subscription |
| `watchItemIds()` | Watch IDs without double-subscription |

All derived readables:
- ✅ Return appropriate defaults when no account
- ✅ Automatically re-subscribe on account change
- ✅ Follow Svelte store contract
- ✅ Proper lifecycle management
- ✅ Full TypeScript support
