# Plan: Replace `subscribe` with `state$` and Add Readable Type Utilities

## Overview

Two improvements to the SyncableStore API:

1. **Replace `subscribe()` method with `state$: Readable<StoreLifecycleState>`** - Makes the lifecycle observation consistent with `syncStatus$` and `storageStatus$`
2. **Add type utilities for watch methods** - Allow users to easily type the Readable stores returned by `watchField`, `watchItem`, `watchItemIds`

---

## Part 1: Replace `subscribe` with `state$`

### Problem

The current `subscribe` method returns `AsyncState<DataOf<S>>` which includes `data` when `status === 'ready'`, but the callback **only fires on status lifecycle changes**, not on data mutations.

This is misleading because:
- Users see `data` in the type and expect reactivity to data changes
- The callback only fires on `idle` → `loading` → `ready` transitions
- Data mutations update `asyncState.data` but never trigger the callback

### Solution

Replace `subscribe()` with `state$: Readable<StoreLifecycleState>` to:
- Make the API consistent with `syncStatus$` and `storageStatus$`
- Remove the misleading `data` field
- Clearly communicate that this is for lifecycle observation only

### New Type: `StoreLifecycleState`

```typescript
/**
 * Store lifecycle state - for observing load status.
 * Does NOT include data - use get() for current data or watchField/watchItem for reactivity.
 */
export type StoreLifecycleState =
    | { status: 'idle'; account: `0x${string}` | undefined; isLoading: false; loadError: Error | null }
    | { status: 'loading'; account: `0x${string}`; isLoading: true; loadError: null }
    | { status: 'ready'; account: `0x${string}`; isLoading: false; loadError: null };
```

### Changes to `SyncableStore` Interface

```diff
export interface SyncableStore<S extends Schema> {
-   /** Subscribe to state changes (Svelte store contract) */
-   subscribe(callback: (state: AsyncState<DataOf<S>>) => void): () => void;

+   /** Reactive store lifecycle state */
+   readonly state$: Readable<StoreLifecycleState>;
    
    /** Reactive sync status */
    readonly syncStatus$: Readable<SyncStatus>;
    
    /** Reactive storage status */
    readonly storageStatus$: Readable<StorageStatus>;
}
```

### Implementation Changes

```typescript
// In createSyncableStore.ts

// New lifecycle state derivation
function getLifecycleState(): StoreLifecycleState {
    if (asyncState.status === 'ready') {
        return {
            status: 'ready',
            account: asyncState.account,
            isLoading: false,
            loadError: null,
        };
    }
    if (asyncState.isLoading) {
        return {
            status: 'loading',
            account,
            isLoading: true,
            loadError: null,
        };
    }
    return {
        status: 'idle',
        account: asyncState.account,
        isLoading: false,
        loadError: asyncState.loadError,
    };
}

// New state$ readable
const state$: Readable<StoreLifecycleState> = {
    subscribe(callback: (state: StoreLifecycleState) => void): () => void {
        callback(getLifecycleState());
        return emitter.on('$store:state', () => callback(getLifecycleState()));
    },
};

// Remove old subscribe method from store object
// Add state$ to store object
```

### Migration Path

Users currently using `subscribe`:

```typescript
// Before
store.subscribe((state) => {
    if (state.status === 'ready') {
        console.log('Ready with data:', state.data);
    }
});

// After
store.state$.subscribe((state) => {
    if (state.status === 'ready') {
        const data = store.get().data;  // Use get() for current data
        console.log('Ready with data:', data);
    }
});
```

---

## Part 2: Readable Type Utilities

### Problem

Users want to type variables that will hold the Readable stores returned by watch methods:

```typescript
// Currently awkward - need to repeat the full type
let settingsStore: Readable<Settings | undefined>;
let taskStore: Readable<(Task & { deleteAt: number }) | undefined>;
let taskIdsStore: Readable<string[]>;
```

### Solution

Add type utilities that derive the correct Readable type from the schema and field name.

### New Type Utilities

```typescript
// ============================================================================
// Readable Type Utilities
// ============================================================================

/**
 * Type of the Readable returned by watchField for a given field.
 * 
 * @example
 * ```typescript
 * const settingsStore: FieldReadable<typeof schema, 'settings'> = store.watchField('settings');
 * ```
 */
export type FieldReadable<S extends Schema, K extends keyof S> = Readable<DataOf<S>[K] | undefined>;

/**
 * Type of the Readable returned by watchItem for a given map field.
 * 
 * @example
 * ```typescript
 * const taskStore: ItemReadable<typeof schema, 'tasks'> = store.watchItem('tasks', taskId);
 * ```
 */
export type ItemReadable<S extends Schema, K extends MapKeys<S>> = Readable<
    (ExtractMapItem<S[K]> & { deleteAt: number }) | undefined
>;

/**
 * Type of the Readable returned by watchItemIds for a given map field.
 * 
 * @example
 * ```typescript
 * const taskIdsStore: ItemIdsReadable<typeof schema, 'tasks'> = store.watchItemIds('tasks');
 * ```
 */
export type ItemIdsReadable<S extends Schema, K extends MapKeys<S>> = Readable<string[]>;

/**
 * Helper to get the value type inside a Readable.
 * Useful for typing callback parameters.
 * 
 * @example
 * ```typescript
 * function handleSettings(settings: ReadableValue<FieldReadable<typeof schema, 'settings'>>) {
 *     // settings is Settings | undefined
 * }
 * ```
 */
export type ReadableValue<R> = R extends Readable<infer T> ? T : never;
```

### Usage Examples

```typescript
import { 
    defineSchema, 
    permanent, 
    map,
    FieldReadable,
    ItemReadable,
    ItemIdsReadable,
    ReadableValue 
} from 'synqable';

interface Settings {
    theme: 'light' | 'dark';
    notifications: boolean;
}

interface Task {
    title: string;
    completed: boolean;
}

const schema = defineSchema({
    settings: permanent<Settings>(),
    tasks: map<Task>(),
});

// Type variables that will hold watch stores
let settingsStore: FieldReadable<typeof schema, 'settings'>;
let taskStore: ItemReadable<typeof schema, 'tasks'>;
let taskIdsStore: ItemIdsReadable<typeof schema, 'tasks'>;

// Later, assign them
settingsStore = store.watchField('settings');
taskStore = store.watchItem('tasks', 'task-1');
taskIdsStore = store.watchItemIds('tasks');

// Type callback parameters
function onSettingsChange(value: ReadableValue<typeof settingsStore>) {
    // value is Settings | undefined
    if (value) {
        console.log('Theme:', value.theme);
    }
}
```

### Full Schema-Level Type Helpers

For users who want all field/item types at once:

```typescript
/**
 * All field readable types for a schema.
 * 
 * @example
 * ```typescript
 * type MyFieldStores = FieldReadables<typeof schema>;
 * // { settings: Readable<Settings | undefined>, tasks: Readable<Record<string, Task & {deleteAt: number}> | undefined> }
 * ```
 */
export type FieldReadables<S extends Schema> = {
    [K in keyof S]: FieldReadable<S, K>;
};

/**
 * All item readable types for map fields in a schema.
 * 
 * @example
 * ```typescript
 * type MyItemStores = ItemReadables<typeof schema>;
 * // { tasks: Readable<(Task & {deleteAt: number}) | undefined> }
 * ```
 */
export type ItemReadables<S extends Schema> = {
    [K in MapKeys<S>]: ItemReadable<S, K>;
};

/**
 * All item IDs readable types for map fields in a schema.
 * 
 * @example
 * ```typescript
 * type MyItemIdsStores = ItemIdsReadables<typeof schema>;
 * // { tasks: Readable<string[]> }
 * ```
 */
export type ItemIdsReadables<S extends Schema> = {
    [K in MapKeys<S>]: ItemIdsReadable<S, K>;
};
```

---

## Todo List

- [ ] Add `StoreLifecycleState` type to types.ts
- [ ] Add `getLifecycleState()` helper function in createSyncableStore.ts
- [ ] Create `state$` readable in createSyncableStore.ts
- [ ] Remove `subscribe()` method from store implementation
- [ ] Update `SyncableStore` interface: remove `subscribe`, add `state$`
- [ ] Add `FieldReadable` type utility to types.ts
- [ ] Add `ItemReadable` type utility to types.ts
- [ ] Add `ItemIdsReadable` type utility to types.ts
- [ ] Add `ReadableValue` type utility to types.ts
- [ ] Add `FieldReadables`, `ItemReadables`, `ItemIdsReadables` collection types
- [ ] Export new types from main/index.ts
- [ ] Update tests to use `state$` instead of `subscribe`
- [ ] Add tests for new type utilities (compile-time only)
- [ ] Update multi-account manager if it uses subscribe

---

## Files to Modify

| File | Changes |
|------|---------|
| `packages/synqable/src/main/types.ts` | Add `StoreLifecycleState`, remove `subscribe` from interface, add `state$`, add type utilities |
| `packages/synqable/src/main/createSyncableStore.ts` | Replace `subscribe` implementation with `state$` |
| `packages/synqable/src/main/index.ts` | Export new types |
| `packages/synqable/src/multi-account/index.ts` | Update if using subscribe |
| `packages/synqable/test/syncable-store.test.ts` | Update tests to use `state$` |

---

## Breaking Change

This is a **breaking change**. The `subscribe()` method is removed and replaced with `state$`.

Migration is straightforward:
- `store.subscribe(callback)` → `store.state$.subscribe(callback)`
- If accessing `state.data` in the callback, use `store.get().data` instead
