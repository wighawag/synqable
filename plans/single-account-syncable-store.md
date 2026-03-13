# Single-Account Syncable Store - Complete Implementation

## Overview

This document provides a complete, standalone implementation of a **single-account syncable store** - a type-safe, schema-driven data store with:

- Local storage persistence
- Cross-tab synchronization
- Server synchronization with pull/push pattern
- Automatic timestamp-based conflict resolution
- Automatic cleanup of expired items

The store is bound to ONE specific account at creation time. Multi-account switching should be handled at a higher level by creating/destroying store instances.

## Project Structure

```
src/
├── storage/
│   ├── types.ts              # AsyncStorage interface
│   ├── LocalStorageAdapter.ts # Browser localStorage implementation
│   └── index.ts              # Storage exports
└── sync/
    ├── types.ts              # Schema, field types, events, sync types
    ├── cleanup.ts            # Expired item cleanup
    ├── merge.ts              # Timestamp-based merge algorithm
    ├── createSyncableStore.ts # Main store factory
    └── index.ts              # Public API exports
```

## Dependencies

```json
{
  "dependencies": {
    "radiate": "^0.3.0",
    "json-stable-stringify": "^1.1.1"
  },
  "devDependencies": {
    "@types/json-stable-stringify": "^1.0.36",
    "typescript": "^5.0.0"
  }
}
```

---

## File 1: `src/storage/types.ts`

```typescript
/**
 * Generic async storage interface for key-value persistence.
 * All operations are async to support various backends.
 */
export interface AsyncStorage<T> {
  /**
   * Load data for the given key.
   * @returns The stored data, or undefined if not found
   */
  load(key: string): Promise<T | undefined>;

  /**
   * Save data for the given key.
   * @param key Storage key
   * @param data Data to persist
   */
  save(key: string, data: T): Promise<void>;

  /**
   * Remove data for the given key.
   * @param key Storage key
   */
  remove(key: string): Promise<void>;

  /**
   * Check if data exists for the given key.
   * @param key Storage key
   */
  exists(key: string): Promise<boolean>;
}

/**
 * Callback invoked when storage changes externally.
 * @param key The key that changed
 * @param newValue The new value, or undefined if removed
 */
export type StorageChangeCallback<T> = (
  key: string,
  newValue: T | undefined,
) => void;

/**
 * Extended storage interface with watch capability.
 * Adapters that support external change notifications implement this.
 */
export interface WatchableStorage<T> extends AsyncStorage<T> {
  /**
   * Subscribe to external changes for a specific key.
   * @param key The storage key to watch
   * @param callback Called when external changes occur
   * @returns Unsubscribe function
   */
  watch(key: string, callback: StorageChangeCallback<T>): () => void;
}

/**
 * Type guard to check if storage supports watching.
 */
export function isWatchable<T>(
  storage: AsyncStorage<T>,
): storage is WatchableStorage<T> {
  return 'watch' in storage && typeof (storage as any).watch === 'function';
}
```

---

## File 2: `src/storage/LocalStorageAdapter.ts`

```typescript
import type { WatchableStorage, StorageChangeCallback } from './types';

export interface LocalStorageAdapterOptions<T> {
  /** Optional serializer, defaults to JSON.stringify */
  serialize?: (data: T) => string;
  /** Optional deserializer, defaults to JSON.parse */
  deserialize?: (data: string) => T;
}

export function createLocalStorageAdapter<T>(
  options?: LocalStorageAdapterOptions<T>,
): WatchableStorage<T> {
  const serialize = options?.serialize ?? JSON.stringify;
  const deserialize = (options?.deserialize ?? JSON.parse) as (
    data: string,
  ) => T;

  // Map of key -> Set of callbacks
  const watchers = new Map<string, Set<StorageChangeCallback<T>>>();

  // Single global listener for the storage event
  let globalListener: ((e: StorageEvent) => void) | null = null;

  function ensureGlobalListener() {
    if (globalListener) return;

    globalListener = (e: StorageEvent) => {
      // Only handle changes from other tabs/windows
      // Note: localStorage events only fire for changes from OTHER documents
      if (!e.key) return;

      const callbacks = watchers.get(e.key);
      if (!callbacks || callbacks.size === 0) return;

      // Parse new value
      let newValue: T | undefined;
      if (e.newValue !== null) {
        try {
          newValue = deserialize(e.newValue);
        } catch {
          newValue = undefined;
        }
      }

      // Notify all watchers for this key
      for (const callback of callbacks) {
        callback(e.key, newValue);
      }
    };

    window.addEventListener('storage', globalListener);
  }

  function cleanupGlobalListener() {
    if (watchers.size === 0 && globalListener) {
      window.removeEventListener('storage', globalListener);
      globalListener = null;
    }
  }

  return {
    async load(key: string): Promise<T | undefined> {
      try {
        const stored = localStorage.getItem(key);
        return stored ? deserialize(stored) : undefined;
      } catch {
        return undefined;
      }
    },

    async save(key: string, data: T): Promise<void> {
      try {
        localStorage.setItem(key, serialize(data));
      } catch {
        // Silently fail - localStorage might be full or unavailable
      }
    },

    async remove(key: string): Promise<void> {
      try {
        localStorage.removeItem(key);
      } catch {
        // Silently fail
      }
    },

    async exists(key: string): Promise<boolean> {
      try {
        return localStorage.getItem(key) !== null;
      } catch {
        return false;
      }
    },

    watch(key: string, callback: StorageChangeCallback<T>): () => void {
      ensureGlobalListener();

      if (!watchers.has(key)) {
        watchers.set(key, new Set());
      }
      watchers.get(key)!.add(callback);

      // Return unsubscribe function
      return () => {
        const callbacks = watchers.get(key);
        if (callbacks) {
          callbacks.delete(callback);
          if (callbacks.size === 0) {
            watchers.delete(key);
          }
        }
        cleanupGlobalListener();
      };
    },
  };
}
```

---

## File 3: `src/storage/index.ts`

```typescript
export {
  type AsyncStorage,
  type WatchableStorage,
  type StorageChangeCallback,
  isWatchable,
} from './types';

export {
  createLocalStorageAdapter,
  type LocalStorageAdapterOptions,
} from './LocalStorageAdapter';
```

---

## File 4: `src/sync/types.ts`

```typescript
/**
 * Simple Syncable Store - Type Definitions
 *
 * Two field types only:
 * - Permanent: Single value, updated as whole, never deleted
 * - Map: Key-value collection with per-item timestamps and deleteAt
 */

// ============================================================================
// Field Type Markers
// ============================================================================

/**
 * Marker type for permanent fields - updated as a whole unit.
 */
export type PermanentField<T> = { __type: 'permanent'; __value?: T };

/**
 * Marker type for map fields - items merged individually.
 */
export type MapField<T> = { __type: 'map'; __item?: T };

// ============================================================================
// Schema Definition Helpers
// ============================================================================

/**
 * Define a permanent field in the schema.
 * Permanent fields are updated as a whole and never deleted.
 */
export function permanent<T>(): PermanentField<T> {
  return { __type: 'permanent' } as PermanentField<T>;
}

/**
 * Define a map field in the schema.
 * Map fields contain items that are individually tracked with timestamps and deleteAt.
 */
export function map<T>(): MapField<T> {
  return { __type: 'map' } as MapField<T>;
}

/**
 * Schema type - maps field names to field types.
 */
export type Schema = Record<
  string,
  PermanentField<unknown> | MapField<unknown>
>;

/**
 * Define a schema with type inference.
 */
export function defineSchema<S extends Schema>(schema: S): S {
  return schema;
}

// ============================================================================
// Type Extractors
// ============================================================================

/**
 * Extract permanent field keys from a schema.
 */
export type PermanentKeys<S extends Schema> = {
  [K in keyof S]: S[K] extends PermanentField<unknown> ? K : never;
}[keyof S];

/**
 * Extract map field keys from a schema.
 */
export type MapKeys<S extends Schema> = {
  [K in keyof S]: S[K] extends MapField<unknown> ? K : never;
}[keyof S];

/**
 * Extract the inner type from a PermanentField.
 */
export type ExtractPermanent<F> = F extends PermanentField<infer T> ? T : never;

/**
 * Extract the item type from a MapField.
 */
export type ExtractMapItem<F> = F extends MapField<infer T> ? T : never;

/**
 * Extract the user-facing data type from schema.
 * Map items include deleteAt in the data.
 */
export type DataOf<S extends Schema> = {
  [K in keyof S]: S[K] extends PermanentField<infer T>
    ? T
    : S[K] extends MapField<infer T>
      ? Record<string, T & { deleteAt: number }>
      : never;
};

/**
 * Deep partial type for patch operations.
 */
export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

// ============================================================================
// Internal Storage Shape
// ============================================================================

/**
 * Internal storage structure with timestamps stored separately from user data.
 */
export type InternalStorage<S extends Schema> = {
  /** Schema version for migration tracking */
  $version: number;

  /** User's clean data */
  data: DataOf<S>;

  /** Timestamps for permanent fields */
  $timestamps: {
    [K in PermanentKeys<S>]?: number;
  };

  /** Per-item timestamps for map fields */
  $itemTimestamps: {
    [K in MapKeys<S>]?: Record<string, number>;
  };

  /** Tombstones for deleted map items (stores deleteAt time) */
  $tombstones: {
    [K in MapKeys<S>]?: Record<string, number>;
  };
};

// ============================================================================
// State Events
// ============================================================================

/**
 * State lifecycle events - emitted on async state transitions.
 */
export type StateEvent = { type: 'idle' } | { type: 'loading' } | { type: 'ready' };

// ============================================================================
// Sync Status and Events
// ============================================================================

/**
 * Sync status - server synchronization state.
 */
export interface SyncStatus {
  /** True when a sync operation is currently in progress */
  readonly isSyncing: boolean;

  /** True when network is available */
  readonly isOnline: boolean;

  /** True when sync is intentionally paused */
  readonly isPaused: boolean;

  /** True if there are changes pending sync to server */
  readonly hasPendingSync: boolean;

  /** Last successful sync timestamp */
  readonly lastSyncedAt: number | null;

  /** Last sync error, null if healthy */
  readonly syncError: Error | null;

  /** Display state for simple UI: syncing > offline > paused > error > idle */
  readonly displayState: 'syncing' | 'offline' | 'paused' | 'error' | 'idle';
}

/**
 * Sync lifecycle events - point-in-time notifications.
 */
export type SyncEvent =
  | { type: 'pending' }
  | { type: 'started' }
  | { type: 'completed'; timestamp: number }
  | { type: 'failed'; error: Error }
  | { type: 'offline' }
  | { type: 'online' }
  | { type: 'paused' }
  | { type: 'resumed' };

// ============================================================================
// Storage Status and Events
// ============================================================================

/**
 * Storage status - local persistence state.
 */
export interface StorageStatus {
  /** True when a storage save operation is in progress */
  readonly isSaving: boolean;

  /** Last successful save timestamp */
  readonly lastSavedAt: number | null;

  /** Last storage error, null if healthy */
  readonly storageError: Error | null;

  /** Display state for simple UI: saving > error > idle */
  readonly displayState: 'saving' | 'error' | 'idle';
}

/**
 * Storage lifecycle events - point-in-time notifications.
 */
export type StorageEvent =
  | { type: 'saving' }
  | { type: 'saved'; timestamp: number }
  | { type: 'failed'; error: Error };

// ============================================================================
// Combined Status Utility
// ============================================================================

/**
 * Combine sync and storage status for UI convenience.
 */
export function combineStatus(
  sync: SyncStatus,
  storage: StorageStatus,
): {
  hasError: boolean;
  hasUnsavedChanges: boolean;
  isBusy: boolean;
} {
  return {
    hasError: sync.syncError !== null || storage.storageError !== null,
    hasUnsavedChanges: storage.isSaving,
    isBusy: sync.isSyncing || storage.isSaving,
  };
}

// ============================================================================
// Type-Safe Event Map
// ============================================================================

/**
 * Base store events that are always present (not schema-derived).
 */
type BaseStoreEvents<S extends Schema> = {
  '$store:state': StateEvent;
  '$store:sync': SyncEvent;
  '$store:storage': StorageEvent;
};

/**
 * Helper type - events for permanent fields.
 */
type PermanentEvents<S extends Schema> = {
  [K in PermanentKeys<S> as `${K & string}:changed`]: ExtractPermanent<S[K]>;
};

/**
 * Helper type - events for map fields.
 */
type MapEvents<S extends Schema> = {
  [K in MapKeys<S> as `${K & string}:added`]: {
    key: string;
    item: ExtractMapItem<S[K]> & { deleteAt: number };
  };
} & {
  [K in MapKeys<S> as `${K & string}:updated`]: {
    key: string;
    item: ExtractMapItem<S[K]> & { deleteAt: number };
  };
} & {
  [K in MapKeys<S> as `${K & string}:removed`]: {
    key: string;
    item: ExtractMapItem<S[K]> & { deleteAt: number };
  };
};

/**
 * Schema-derived events.
 */
type SchemaEvents<S extends Schema> = Omit<
  PermanentEvents<S> & MapEvents<S>,
  keyof BaseStoreEvents<S>
>;

/**
 * Complete event map for a store.
 */
export type StoreEvents<S extends Schema> = BaseStoreEvents<S> & SchemaEvents<S>;

// ============================================================================
// Async State Types
// ============================================================================

/**
 * Async state for store data.
 */
export type AsyncState<T> =
  | { status: 'idle'; account: undefined }
  | { status: 'loading'; account: `0x${string}` }
  | { status: 'ready'; account: `0x${string}`; data: T };

// ============================================================================
// Change Tracking Types
// ============================================================================

/**
 * Represents a change detected during merge.
 */
export type StoreChange =
  | { event: `${string}:changed`; data: unknown }
  | { event: `${string}:added`; data: { key: string; item: unknown } }
  | { event: `${string}:updated`; data: { key: string; item: unknown } }
  | { event: `${string}:removed`; data: { key: string; item: unknown } };

// ============================================================================
// Server Sync Types
// ============================================================================

/**
 * Response from pull operation.
 */
export interface PullResponse<S extends Schema> {
  /** Server data, or null if no data exists */
  data: InternalStorage<S> | null;

  /** Server's current counter for optimistic locking */
  counter: bigint;
}

/**
 * Response from push operation.
 */
export interface PushResponse {
  /** Whether the push was successful */
  success: boolean;

  /** If failed due to stale counter, the server's current counter */
  currentCounter?: bigint;

  /** Error message if failed */
  error?: string;
}

/**
 * Server sync adapter interface.
 */
export interface SyncAdapter<S extends Schema> {
  /**
   * Pull latest state from server.
   */
  pull(account: `0x${string}`): Promise<PullResponse<S>>;

  /**
   * Push local state to server.
   */
  push(
    account: `0x${string}`,
    data: InternalStorage<S>,
    counter: bigint,
  ): Promise<PushResponse>;

  /**
   * Subscribe to real-time updates (optional).
   */
  subscribe?(
    account: `0x${string}`,
    callback: (data: InternalStorage<S>, counter: bigint) => void,
  ): () => void;
}

/**
 * Sync configuration.
 */
export interface SyncConfig {
  /** Debounce delay for pushing changes (default: 1000ms) */
  debounceMs?: number;

  /** Interval for periodic sync (default: 30000ms, 0 to disable) */
  intervalMs?: number;

  /** Sync when tab becomes visible (default: true) */
  syncOnVisible?: boolean;

  /** Sync when coming back online (default: true) */
  syncOnReconnect?: boolean;

  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;

  /** Initial backoff delay for retries (default: 1000ms) */
  retryBackoffMs?: number;
}
```

---

## File 5: `src/sync/cleanup.ts`

```typescript
/**
 * Simple Syncable Store - Cleanup Algorithm
 *
 * Removes expired items and tombstones from the store.
 */

import type { Schema, InternalStorage, DataOf, StoreChange } from './types';

/**
 * Result of cleanup operation.
 */
export interface CleanupResult<S extends Schema> {
  /** Cleaned storage with expired items and tombstones removed */
  storage: InternalStorage<S>;

  /** Changes produced by cleanup - expired items become :removed events */
  changes: StoreChange[];

  /** True if any tombstones were deleted during cleanup */
  tombstonesDeleted: boolean;
}

/**
 * Clean up expired items and tombstones from storage.
 * Items and tombstones with deleteAt <= now are removed.
 */
export function cleanup<S extends Schema>(
  storage: InternalStorage<S>,
  schema: S,
  now: number = Date.now(),
): CleanupResult<S> {
  const changes: StoreChange[] = [];
  let tombstonesDeleted = false;

  const result: InternalStorage<S> = {
    $version: storage.$version,
    data: { ...storage.data } as DataOf<S>,
    $timestamps: { ...storage.$timestamps },
    $itemTimestamps: {} as InternalStorage<S>['$itemTimestamps'],
    $tombstones: {} as InternalStorage<S>['$tombstones'],
  };

  for (const field of Object.keys(schema) as (keyof S & string)[]) {
    const fieldDef = schema[field];

    if (fieldDef.__type === 'map') {
      // Copy and filter tombstones
      const tombstones =
        (storage.$tombstones as Record<string, Record<string, number>>)[field] ?? {};
      const cleanedTombstones: Record<string, number> = {};

      for (const [key, deleteAt] of Object.entries(tombstones)) {
        if (deleteAt > now) {
          cleanedTombstones[key] = deleteAt;
        } else {
          tombstonesDeleted = true;
        }
      }

      (result.$tombstones as Record<string, Record<string, number>>)[field] =
        cleanedTombstones;

      // Copy and filter items
      const items = ((storage.data as Record<string, unknown>)[field] ?? {}) as Record<
        string,
        { deleteAt: number }
      >;
      const timestamps =
        (storage.$itemTimestamps as Record<string, Record<string, number>>)[field] ?? {};
      const cleanedItems: Record<string, unknown> = {};
      const cleanedTimestamps: Record<string, number> = {};

      for (const [key, item] of Object.entries(items)) {
        if (item.deleteAt > now) {
          cleanedItems[key] = item;
          if (timestamps[key] !== undefined) {
            cleanedTimestamps[key] = timestamps[key];
          }
        } else {
          // Item expired - emit :removed change
          changes.push({
            event: `${field}:removed`,
            data: { key, item },
          });
        }
      }

      (result.data as Record<string, unknown>)[field] = cleanedItems;
      (result.$itemTimestamps as Record<string, Record<string, number>>)[field] =
        cleanedTimestamps;
    }
    // Permanent fields are never cleaned up
  }

  return { storage: result, changes, tombstonesDeleted };
}
```

---

## File 6: `src/sync/merge.ts`

```typescript
/**
 * Simple Syncable Store - Merge Algorithm
 *
 * Deterministic merge using "higher timestamp wins" with tiebreaker.
 */

import stableStringify from 'json-stable-stringify';
import type {
  Schema,
  InternalStorage,
  StoreChange,
  DataOf,
  PermanentKeys,
  MapKeys,
} from './types';
import { cleanup, type CleanupResult } from './cleanup';

// ============================================================================
// Merge Outcome Types
// ============================================================================

export type MergeOutcome = 'incoming' | 'current' | 'tie';
export type TiebreakerOutcome = 'first' | 'second' | 'tie';

export interface TiebreakerResult<T> {
  value: T;
  outcome: TiebreakerOutcome;
}

// ============================================================================
// Tiebreaker
// ============================================================================

/**
 * Deterministic tiebreaker for values with identical timestamps.
 * Uses json-stable-stringify for deterministic property order.
 */
export function tiebreaker<T>(a: T, b: T): TiebreakerResult<T> {
  const aStr = stableStringify(a) ?? '';
  const bStr = stableStringify(b) ?? '';

  if (aStr === bStr) {
    return { value: a, outcome: 'tie' };
  }

  if (aStr < bStr) {
    return { value: a, outcome: 'first' };
  }
  return { value: b, outcome: 'second' };
}

// ============================================================================
// Permanent Field Merge
// ============================================================================

export interface PermanentMergeInput<T> {
  value: T;
  timestamp: number;
}

export interface PermanentMergeResult<T> {
  value: T;
  timestamp: number;
  outcome: MergeOutcome;
}

export function mergePermanent<T>(
  current: PermanentMergeInput<T>,
  incoming: PermanentMergeInput<T>,
): PermanentMergeResult<T> {
  if (incoming.timestamp > current.timestamp) {
    return {
      value: incoming.value,
      timestamp: incoming.timestamp,
      outcome: 'incoming',
    };
  }

  if (current.timestamp > incoming.timestamp) {
    return {
      value: current.value,
      timestamp: current.timestamp,
      outcome: 'current',
    };
  }

  // Same timestamp - use tiebreaker
  const result = tiebreaker(current.value, incoming.value);

  let outcome: MergeOutcome;
  if (result.outcome === 'tie') {
    outcome = 'tie';
  } else if (result.outcome === 'second') {
    outcome = 'incoming';
  } else {
    outcome = 'current';
  }

  return {
    value: result.value,
    timestamp: current.timestamp,
    outcome,
  };
}

// ============================================================================
// Map Field Merge
// ============================================================================

export interface MapState<T> {
  items: Record<string, T>;
  timestamps: Record<string, number>;
  tombstones: Record<string, number>;
}

export interface MapChange<T> {
  event: `${string}:added` | `${string}:updated` | `${string}:removed`;
  data: { key: string; item: T };
}

export interface MapMergeResult<T> {
  items: Record<string, T>;
  timestamps: Record<string, number>;
  tombstones: Record<string, number>;
  changes: MapChange<T>[];
  localWonCount: number;
  tieCount: number;
}

export function mergeMap<T>(
  current: MapState<T>,
  incoming: MapState<T>,
  fieldName: string,
): MapMergeResult<T> {
  const items: Record<string, T> = {};
  const timestamps: Record<string, number> = {};
  const tombstones: Record<string, number> = {};
  const changes: MapChange<T>[] = [];
  let localWonCount = 0;
  let tieCount = 0;

  // Merge tombstones - later deleteAt wins
  const allTombstoneKeys = new Set([
    ...Object.keys(current.tombstones),
    ...Object.keys(incoming.tombstones),
  ]);

  for (const key of allTombstoneKeys) {
    const ct = current.tombstones[key] ?? 0;
    const it = incoming.tombstones[key] ?? 0;
    if (ct > 0 || it > 0) {
      tombstones[key] = Math.max(ct, it);
    }
  }

  // Merge items
  const allItemKeys = new Set([
    ...Object.keys(current.items),
    ...Object.keys(incoming.items),
  ]);

  for (const key of allItemKeys) {
    const hadItem = key in current.items;
    const isTombstoned = key in tombstones;

    if (isTombstoned) {
      if (hadItem) {
        changes.push({
          event: `${fieldName}:removed`,
          data: { key, item: current.items[key] },
        });
      }
      continue;
    }

    const cItem = current.items[key];
    const iItem = incoming.items[key];
    const cTs = current.timestamps[key] ?? 0;
    const iTs = incoming.timestamps[key] ?? 0;

    let winner: T;
    let winnerTs: number;

    if (!cItem && iItem) {
      winner = iItem;
      winnerTs = iTs;
      changes.push({
        event: `${fieldName}:added`,
        data: { key, item: iItem },
      });
    } else if (cItem && !iItem) {
      winner = cItem;
      winnerTs = cTs;
      localWonCount++;
    } else {
      if (iTs > cTs) {
        winner = iItem;
        winnerTs = iTs;
        changes.push({
          event: `${fieldName}:updated`,
          data: { key, item: iItem },
        });
      } else if (cTs > iTs) {
        winner = cItem;
        winnerTs = cTs;
        localWonCount++;
      } else {
        const picked = tiebreaker(
          { item: cItem, ts: cTs },
          { item: iItem, ts: iTs },
        );
        winner = picked.value.item;
        winnerTs = picked.value.ts;

        switch (picked.outcome) {
          case 'tie':
            tieCount++;
            break;
          case 'first':
            localWonCount++;
            break;
          case 'second':
            changes.push({
              event: `${fieldName}:updated`,
              data: { key, item: iItem },
            });
            break;
        }
      }
    }

    items[key] = winner;
    timestamps[key] = winnerTs;
  }

  return { items, timestamps, tombstones, changes, localWonCount, tieCount };
}

// ============================================================================
// Full Store Merge
// ============================================================================

export interface StoreMergeResult<S extends Schema> {
  merged: InternalStorage<S>;
  changes: StoreChange[];
  hasLocalChanges: boolean;
}

export function mergeStore<S extends Schema>(
  current: InternalStorage<S>,
  incoming: InternalStorage<S>,
  schema: S,
): StoreMergeResult<S> {
  const result: InternalStorage<S> = {
    $version: Math.max(current.$version ?? 0, incoming.$version ?? 0),
    data: {} as DataOf<S>,
    $timestamps: {} as InternalStorage<S>['$timestamps'],
    $itemTimestamps: {} as InternalStorage<S>['$itemTimestamps'],
    $tombstones: {} as InternalStorage<S>['$tombstones'],
  };
  const changes: StoreChange[] = [];
  let hasLocalChanges = false;

  for (const field of Object.keys(schema) as (keyof S & string)[]) {
    const fieldDef = schema[field];

    if (fieldDef.__type === 'permanent') {
      const currentTs = (current.$timestamps as Record<string, number>)[field] ?? 0;
      const incomingTs = (incoming.$timestamps as Record<string, number>)[field] ?? 0;
      const currentValue = (current.data as Record<string, unknown>)[field];
      const incomingValue = (incoming.data as Record<string, unknown>)[field];

      const mergeResult = mergePermanent(
        { value: currentValue, timestamp: currentTs },
        { value: incomingValue, timestamp: incomingTs },
      );

      (result.data as Record<string, unknown>)[field] = mergeResult.value;
      (result.$timestamps as Record<string, number>)[field] = mergeResult.timestamp;

      switch (mergeResult.outcome) {
        case 'incoming':
          changes.push({ event: `${field}:changed`, data: mergeResult.value });
          break;
        case 'current':
          if (currentTs > 0) {
            hasLocalChanges = true;
          }
          break;
        case 'tie':
          break;
      }
    } else if (fieldDef.__type === 'map') {
      const currentItems = ((current.data as Record<string, unknown>)[field] ?? {}) as Record<
        string,
        unknown
      >;
      const incomingItems = ((incoming.data as Record<string, unknown>)[field] ?? {}) as Record<
        string,
        unknown
      >;
      const currentTimestamps =
        (current.$itemTimestamps as Record<string, Record<string, number>>)[field] ?? {};
      const incomingTimestamps =
        (incoming.$itemTimestamps as Record<string, Record<string, number>>)[field] ?? {};
      const currentTombstones =
        (current.$tombstones as Record<string, Record<string, number>>)[field] ?? {};
      const incomingTombstones =
        (incoming.$tombstones as Record<string, Record<string, number>>)[field] ?? {};

      const mapResult = mergeMap(
        {
          items: currentItems,
          timestamps: currentTimestamps,
          tombstones: currentTombstones,
        },
        {
          items: incomingItems,
          timestamps: incomingTimestamps,
          tombstones: incomingTombstones,
        },
        field,
      );

      (result.data as Record<string, unknown>)[field] = mapResult.items;
      (result.$itemTimestamps as Record<string, Record<string, number>>)[field] =
        mapResult.timestamps;
      (result.$tombstones as Record<string, Record<string, number>>)[field] = mapResult.tombstones;

      changes.push(...(mapResult.changes as StoreChange[]));

      if (mapResult.localWonCount > 0) {
        hasLocalChanges = true;
      }
    }
  }

  return { merged: result, changes, hasLocalChanges };
}

// ============================================================================
// Merge and Cleanup Combined
// ============================================================================

export interface MergeAndCleanupResult<S extends Schema> {
  storage: InternalStorage<S>;
  changes: StoreChange[];
  tombstonesDeleted: boolean;
  itemsExpired: boolean;
  serverNeedsUpdate: boolean;
}

export function mergeAndCleanup<S extends Schema>(
  current: InternalStorage<S>,
  incoming: InternalStorage<S>,
  schema: S,
  now: number = Date.now(),
): MergeAndCleanupResult<S> {
  const { merged, changes: mergeChanges, hasLocalChanges } = mergeStore(current, incoming, schema);
  const { storage: cleaned, changes: cleanupChanges, tombstonesDeleted } = cleanup(
    merged,
    schema,
    now,
  );

  const allChanges = deduplicateChanges(mergeChanges, cleanupChanges);
  const serverNeedsUpdate = hasLocalChanges;

  return {
    storage: cleaned,
    changes: allChanges,
    tombstonesDeleted,
    itemsExpired: cleanupChanges.length > 0,
    serverNeedsUpdate,
  };
}

function deduplicateChanges(
  mergeChanges: StoreChange[],
  cleanupChanges: StoreChange[],
): StoreChange[] {
  const result: StoreChange[] = [];

  const expiredKeys = new Set<string>();
  for (const change of cleanupChanges) {
    if (change.event.endsWith(':removed')) {
      const data = change.data as { key: string };
      const fieldName = change.event.split(':')[0];
      expiredKeys.add(`${fieldName}:${data.key}`);
    }
  }

  const addedKeys = new Set<string>();
  for (const change of mergeChanges) {
    if (change.event.endsWith(':added')) {
      const data = change.data as { key: string };
      const fieldName = change.event.split(':')[0];
      addedKeys.add(`${fieldName}:${data.key}`);
    }
  }

  for (const change of mergeChanges) {
    const fieldName = change.event.split(':')[0];

    if (change.event.endsWith(':added') || change.event.endsWith(':updated')) {
      const data = change.data as { key: string };
      const keyPath = `${fieldName}:${data.key}`;

      if (expiredKeys.has(keyPath)) {
        continue;
      }
    }

    result.push(change);
  }

  for (const change of cleanupChanges) {
    if (change.event.endsWith(':removed')) {
      const data = change.data as { key: string };
      const fieldName = change.event.split(':')[0];
      const keyPath = `${fieldName}:${data.key}`;

      if (addedKeys.has(keyPath)) {
        continue;
      }
    }

    result.push(change);
  }

  return result;
}
```

---

## File 7: `src/sync/createSyncableStore.ts`

```typescript
/**
 * Single-Account Syncable Store
 *
 * Creates a type-safe syncable store bound to ONE specific account.
 */

import type {
  Schema,
  InternalStorage,
  DataOf,
  AsyncState,
  SyncStatus,
  StorageStatus,
  PermanentKeys,
  MapKeys,
  ExtractPermanent,
  ExtractMapItem,
  DeepPartial,
  StoreChange,
  StoreEvents,
  SyncAdapter,
  SyncConfig,
} from './types';

import type { AsyncStorage } from '../storage/types';
import { isWatchable } from '../storage/types';
import { cleanup } from './cleanup';
import { mergeAndCleanup } from './merge';
import { createEmitter } from 'radiate';

// ============================================================================
// Readable Store Interface (Svelte store contract)
// ============================================================================

export interface Readable<T> {
  subscribe(callback: (value: T) => void): () => void;
}

// ============================================================================
// Store Configuration
// ============================================================================

export interface SyncableStoreConfig<S extends Schema> {
  /** Schema definition */
  schema: S;

  /** Static account address - store is bound to this account */
  account: `0x${string}`;

  /** Local storage adapter */
  storage: AsyncStorage<InternalStorage<S>>;

  /** Storage key - direct string */
  storageKey: string;

  /** Default data factory */
  defaultData: () => DataOf<S>;

  /** Clock function for timestamps (default: Date.now) */
  clock?: () => number;

  /** Schema version for migrations */
  schemaVersion?: number;

  /** Optional: Server sync adapter */
  sync?: SyncAdapter<S>;

  /** Optional: Sync configuration */
  syncConfig?: SyncConfig;

  /** Migration functions keyed by target version */
  migrations?: Record<number, (oldData: unknown) => InternalStorage<S>>;
}

// ============================================================================
// Store Interface
// ============================================================================

export interface SyncableStore<S extends Schema> {
  /** Current async state */
  readonly state: AsyncState<DataOf<S>>;

  /** The account this store is bound to */
  readonly account: `0x${string}`;

  /** Set a permanent field value */
  set<K extends PermanentKeys<S>>(field: K, value: ExtractPermanent<S[K]>): void;

  /** Patch a permanent field with partial updates */
  patch<K extends PermanentKeys<S>>(field: K, value: DeepPartial<ExtractPermanent<S[K]>>): void;

  /** Add an item to a map field */
  add<K extends MapKeys<S>>(
    field: K,
    key: string,
    value: ExtractMapItem<S[K]>,
    options: { deleteAt: number },
  ): void;

  /** Update an existing map item */
  update<K extends MapKeys<S>>(field: K, key: string, value: ExtractMapItem<S[K]>): void;

  /** Remove an item from a map field */
  remove<K extends MapKeys<S>>(field: K, key: string): void;

  /** Subscribe to state changes (Svelte store contract) */
  subscribe(callback: (state: AsyncState<DataOf<S>>) => void): () => void;

  /** Subscribe to type-safe events */
  on<E extends keyof StoreEvents<S>>(
    event: E,
    callback: (data: StoreEvents<S>[E]) => void,
  ): () => void;

  /** Unsubscribe from events */
  off<E extends keyof StoreEvents<S>>(
    event: E,
    callback: (data: StoreEvents<S>[E]) => void,
  ): void;

  /** Load data from storage - must be called to initialize */
  load(): Promise<void>;

  /** Stop watching and clean up */
  stop(): void;

  /** Get a reactive store for a specific map item */
  getItemStore<K extends MapKeys<S>>(
    field: K,
    key: string,
  ): Readable<(ExtractMapItem<S[K]> & { deleteAt: number }) | undefined>;

  /** Get a reactive store for a top-level field */
  getFieldStore<K extends keyof S>(field: K): Readable<DataOf<S>[K] | undefined>;

  /** Subscribe to sync status changes */
  readonly syncStatusStore: Readable<SyncStatus>;

  /** Subscribe to storage status changes */
  readonly storageStatusStore: Readable<StorageStatus>;

  /** Force sync to server now */
  syncNow(): Promise<void>;

  /** Pause server sync */
  pauseSync(): void;

  /** Resume server sync */
  resumeSync(): void;

  /** Retry loading after a migration failure */
  retryLoad(): void;

  /** Wait for all pending storage saves to complete */
  flush(timeoutMs?: number): Promise<void>;
}

// ============================================================================
// Implementation
// ============================================================================

export function createSyncableStore<S extends Schema>(
  config: SyncableStoreConfig<S>,
): SyncableStore<S> {
  const {
    schema,
    account,
    storage,
    storageKey,
    defaultData,
    clock = Date.now,
    schemaVersion = 1,
    sync: syncAdapter,
    syncConfig,
    migrations,
  } = config;

  // Sync configuration with defaults
  const debounceMs = syncConfig?.debounceMs ?? 1000;
  const maxRetries = syncConfig?.maxRetries ?? 3;
  const retryBackoffMs = syncConfig?.retryBackoffMs ?? 1000;

  // State
  let asyncState: AsyncState<DataOf<S>> = { status: 'idle', account: undefined };
  let internalStorage: InternalStorage<S> | null = null;

  // Storage queue state
  let storageSavePending: {
    account: `0x${string}`;
    data: InternalStorage<S>;
  } | null = null;
  let currentSavePromise: Promise<void> | null = null;

  // Internal mutable sync status
  interface MutableSyncStatus {
    isSyncing: boolean;
    isOnline: boolean;
    isPaused: boolean;
    hasPendingSync: boolean;
    lastSyncedAt: number | null;
    syncError: Error | null;
    readonly displayState: 'syncing' | 'offline' | 'paused' | 'error' | 'idle';
  }

  // Internal mutable storage status
  interface MutableStorageStatus {
    isSaving: boolean;
    lastSavedAt: number | null;
    storageError: Error | null;
    readonly displayState: 'saving' | 'error' | 'idle';
  }

  const mutableSyncStatus: MutableSyncStatus = {
    isSyncing: false,
    isOnline: true,
    isPaused: false,
    hasPendingSync: false,
    lastSyncedAt: null,
    syncError: null,
    get displayState() {
      if (this.isSyncing) return 'syncing';
      if (!this.isOnline) return 'offline';
      if (this.isPaused) return 'paused';
      if (this.syncError) return 'error';
      return 'idle';
    },
  };

  const mutableStorageStatus: MutableStorageStatus = {
    isSaving: false,
    lastSavedAt: null,
    storageError: null,
    get displayState() {
      if (this.isSaving) return 'saving';
      if (this.storageError) return 'error';
      return 'idle';
    },
  };

  const syncStatus: SyncStatus = mutableSyncStatus;
  const storageStatus: StorageStatus = mutableStorageStatus;

  // Event emitter
  const emitter = createEmitter<StoreEvents<S>>();

  // Event type definitions
  type SyncEventData =
    | { type: 'pending' }
    | { type: 'started' }
    | { type: 'completed'; timestamp: number }
    | { type: 'failed'; error: Error }
    | { type: 'offline' }
    | { type: 'online' }
    | { type: 'paused' }
    | { type: 'resumed' };

  type StorageEventData =
    | { type: 'saving' }
    | { type: 'saved'; timestamp: number }
    | { type: 'failed'; error: Error };

  type StateEventData = { type: 'idle' } | { type: 'loading' } | { type: 'ready' };

  function emitSyncEvent(event: SyncEventData): void {
    (emitter.emit as (eventName: '$store:sync', data: SyncEventData) => void)(
      '$store:sync',
      event,
    );
  }

  function emitStorageEvent(event: StorageEventData): void {
    (emitter.emit as (eventName: '$store:storage', data: StorageEventData) => void)(
      '$store:storage',
      event,
    );
  }

  function emitStateEvent(event: StateEventData): void {
    (emitter.emit as (eventName: '$store:state', data: StateEventData) => void)(
      '$store:state',
      event,
    );
  }

  // Cleanup references
  let unwatchStorage: (() => void) | undefined;
  let handleVisibilityChange: (() => void) | undefined;
  let handleOnline: (() => void) | undefined;
  let handleOffline: (() => void) | undefined;
  let handleBeforeUnload: ((e: BeforeUnloadEvent) => void) | undefined;
  let syncIntervalTimer: ReturnType<typeof setInterval> | undefined;
  let syncDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let syncDirty = false;
  let syncPaused = false;

  // Store caches
  const itemStoreCache = new Map<string, Readable<unknown>>();
  const fieldStoreCache = new Map<string, Readable<unknown>>();

  // Status stores
  const syncStatusStore: Readable<SyncStatus> = {
    subscribe(callback: (status: SyncStatus) => void): () => void {
      callback(syncStatus);
      return emitter.on('$store:sync', () => callback(syncStatus));
    },
  };

  const storageStatusStore: Readable<StorageStatus> = {
    subscribe(callback: (status: StorageStatus) => void): () => void {
      callback(storageStatus);
      return emitter.on('$store:storage', () => callback(storageStatus));
    },
  };

  // Mark dirty and schedule sync
  function markDirty(): void {
    if (!syncAdapter) return;
    syncDirty = true;
    mutableSyncStatus.hasPendingSync = true;
    emitSyncEvent({ type: 'pending' });
    scheduleSync();
  }

  function scheduleSync(): void {
    if (!syncAdapter || asyncState.status !== 'ready' || syncPaused) return;

    if (syncDebounceTimer) {
      clearTimeout(syncDebounceTimer);
    }

    syncDebounceTimer = setTimeout(() => {
      performSync();
    }, debounceMs);
  }

  async function performSync(retryCount = 0): Promise<void> {
    if (!syncAdapter || !internalStorage || asyncState.status !== 'ready') return;

    const currentAccount = account;

    try {
      mutableSyncStatus.isSyncing = true;
      mutableSyncStatus.syncError = null;
      if (retryCount === 0) {
        emitSyncEvent({ type: 'started' });
      }

      const pullResponse = await syncAdapter.pull(currentAccount);

      let dataToSync = internalStorage;
      let shouldPush = false;

      const serverData = pullResponse.data ?? createDefaultInternalStorage();

      const { storage: cleanedMerged, changes, serverNeedsUpdate } = mergeAndCleanup(
        internalStorage,
        serverData,
        schema,
        clock(),
      );
      dataToSync = cleanedMerged;
      shouldPush = serverNeedsUpdate;

      if (changes.length > 0) {
        internalStorage = cleanedMerged;
        asyncState = { ...asyncState, data: cleanedMerged.data };

        for (const change of changes) {
          emitter.emit(
            change.event as keyof StoreEvents<S>,
            change.data as StoreEvents<S>[keyof StoreEvents<S>],
          );
        }

        await saveToStorage(currentAccount, cleanedMerged);
      }

      if (shouldPush) {
        const clockBigInt = BigInt(clock());
        const newCounter =
          clockBigInt > pullResponse.counter ? clockBigInt : pullResponse.counter + 1n;
        const pushResponse = await syncAdapter.push(currentAccount, dataToSync, newCounter);

        if (!pushResponse.success) {
          if (retryCount < maxRetries) {
            const backoffDelay = retryBackoffMs * Math.pow(2, retryCount);
            setTimeout(() => {
              performSync(retryCount + 1);
            }, backoffDelay);
            return;
          } else {
            throw new Error(pushResponse.error || 'Push rejected after max retries');
          }
        }

        syncDirty = false;
        mutableSyncStatus.lastSyncedAt = clock();
        mutableSyncStatus.hasPendingSync = false;
        mutableSyncStatus.syncError = null;
        mutableSyncStatus.isSyncing = false;
        emitSyncEvent({ type: 'completed', timestamp: clock() });
      } else {
        mutableSyncStatus.syncError = null;
        mutableSyncStatus.isSyncing = false;
      }
    } catch (error) {
      if (retryCount < maxRetries) {
        const backoffDelay = retryBackoffMs * Math.pow(2, retryCount);
        setTimeout(() => {
          performSync(retryCount + 1);
        }, backoffDelay);
      } else {
        mutableSyncStatus.syncError = error as Error;
        mutableSyncStatus.isSyncing = false;
        emitSyncEvent({ type: 'failed', error: error as Error });
      }
    }
  }

  function createDefaultInternalStorage(): InternalStorage<S> {
    return {
      $version: schemaVersion,
      data: defaultData(),
      $timestamps: {} as InternalStorage<S>['$timestamps'],
      $itemTimestamps: {} as InternalStorage<S>['$itemTimestamps'],
      $tombstones: {} as InternalStorage<S>['$tombstones'],
    };
  }

  async function doStorageSave(
    acc: `0x${string}`,
    data: InternalStorage<S>,
  ): Promise<void> {
    try {
      await storage.save(storageKey, data);
      mutableStorageStatus.lastSavedAt = clock();
    } catch (error) {
      mutableStorageStatus.storageError = error as Error;
      emitStorageEvent({ type: 'failed', error: error as Error });
      throw error;
    }
  }

  async function processStorageSave(
    acc: `0x${string}`,
    data: InternalStorage<S>,
  ): Promise<void> {
    try {
      await doStorageSave(acc, data);
    } catch {
      // Error handled in doStorageSave
    }

    if (storageSavePending) {
      const pending = storageSavePending;
      storageSavePending = null;
      mutableStorageStatus.storageError = null;
      emitStorageEvent({ type: 'saving' });
      await processStorageSave(pending.account, pending.data);
    } else {
      mutableStorageStatus.isSaving = false;
      emitStorageEvent({ type: 'saved', timestamp: mutableStorageStatus.lastSavedAt ?? clock() });
    }
  }

  function saveToStorage(acc: `0x${string}`, data: InternalStorage<S>): Promise<void> {
    if (mutableStorageStatus.isSaving) {
      storageSavePending = { account: acc, data };
      mutableStorageStatus.storageError = null;
      return currentSavePromise!;
    }

    mutableStorageStatus.isSaving = true;
    storageSavePending = null;
    mutableStorageStatus.storageError = null;
    emitStorageEvent({ type: 'saving' });

    currentSavePromise = processStorageSave(acc, data);
    return currentSavePromise;
  }

  function setupStorageWatch(): void {
    if (isWatchable(storage)) {
      unwatchStorage = storage.watch(storageKey, async (_, newValue) => {
        if (!newValue || !internalStorage) return;

        const { storage: cleanedMerged, changes } = mergeAndCleanup(
          internalStorage,
          newValue,
          schema,
          clock(),
        );

        if (changes.length > 0) {
          internalStorage = cleanedMerged;

          if (asyncState.status === 'ready') {
            asyncState = { ...asyncState, data: cleanedMerged.data };
          }

          for (const change of changes) {
            emitter.emit(
              change.event as keyof StoreEvents<S>,
              change.data as StoreEvents<S>[keyof StoreEvents<S>],
            );
          }
        }
      });
    }
  }

  function setupGlobalListeners(): void {
    if (syncConfig?.syncOnVisible !== false && typeof document !== 'undefined') {
      handleVisibilityChange = () => {
        if (document.visibilityState === 'visible' && asyncState.status === 'ready') {
          performSync();
        }
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    if (syncConfig?.syncOnReconnect !== false && typeof window !== 'undefined') {
      handleOnline = () => {
        mutableSyncStatus.isOnline = true;
        emitSyncEvent({ type: 'online' });
        if (asyncState.status === 'ready') {
          performSync();
        }
      };
      handleOffline = () => {
        mutableSyncStatus.isOnline = false;
        emitSyncEvent({ type: 'offline' });
      };
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    }

    const intervalMs = syncConfig?.intervalMs;
    if (syncAdapter && intervalMs && intervalMs > 0) {
      syncIntervalTimer = setInterval(() => {
        if (asyncState.status === 'ready' && !syncPaused) {
          performSync();
        }
      }, intervalMs);
    }

    if (typeof window !== 'undefined') {
      handleBeforeUnload = (e: BeforeUnloadEvent) => {
        if (
          mutableStorageStatus.isSaving ||
          (mutableSyncStatus.hasPendingSync && !mutableSyncStatus.syncError)
        ) {
          e.preventDefault();
          e.returnValue = 'You have unsaved changes.';
        }
      };
      window.addEventListener('beforeunload', handleBeforeUnload);
    }
  }

  async function load(): Promise<void> {
    if (asyncState.status !== 'idle') {
      throw new Error('Store already loaded or loading');
    }

    asyncState = { status: 'loading', account };
    emitStateEvent({ type: 'loading' });

    const localData = await storage.load(storageKey);

    if (localData) {
      const storedVersion = localData.$version ?? 0;

      if (storedVersion < schemaVersion) {
        try {
          let migrated: unknown = localData;
          for (let v = storedVersion + 1; v <= schemaVersion; v++) {
            const migration = migrations?.[v];
            if (!migration) {
              throw new Error(`Missing migration for version ${v}`);
            }
            migrated = migration(migrated);
            (migrated as { $version: number }).$version = v;
          }
          internalStorage = migrated as InternalStorage<S>;
        } catch (error) {
          mutableStorageStatus.storageError = error as Error;
          emitStorageEvent({ type: 'failed', error: error as Error });
          return;
        }
      } else {
        internalStorage = localData;
      }
    } else {
      internalStorage = createDefaultInternalStorage();
    }

    const { storage: cleanedStorage } = cleanup(internalStorage, schema, clock());
    internalStorage = cleanedStorage;

    await saveToStorage(account, internalStorage);

    asyncState = {
      status: 'ready',
      account,
      data: internalStorage.data,
    };
    emitStateEvent({ type: 'ready' });

    if (syncAdapter) {
      performSync();
    }

    setupStorageWatch();
    setupGlobalListeners();
  }

  const store: SyncableStore<S> = {
    get state() {
      return asyncState;
    },

    get account() {
      return account;
    },

    set<K extends PermanentKeys<S>>(field: K, value: ExtractPermanent<S[K]>): void {
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

      saveToStorage(account, internalStorage);
      markDirty();
    },

    patch<K extends PermanentKeys<S>>(
      field: K,
      value: DeepPartial<ExtractPermanent<S[K]>>,
    ): void {
      if (asyncState.status !== 'ready' || !internalStorage) {
        throw new Error('Store is not ready');
      }

      const now = clock();
      const current = (internalStorage.data as Record<string, unknown>)[field as string];
      const merged = deepMerge(current, value);

      (internalStorage.data as Record<string, unknown>)[field as string] = merged;
      (internalStorage.$timestamps as Record<string, number>)[field as string] = now;

      asyncState = { ...asyncState, data: { ...internalStorage.data } };

      emitter.emit(
        `${String(field)}:changed` as keyof StoreEvents<S>,
        merged as StoreEvents<S>[keyof StoreEvents<S>],
      );

      saveToStorage(account, internalStorage);
      markDirty();
    },

    add<K extends MapKeys<S>>(
      field: K,
      key: string,
      value: ExtractMapItem<S[K]>,
      options: { deleteAt: number },
    ): void {
      if (asyncState.status !== 'ready' || !internalStorage) {
        throw new Error('Store is not ready');
      }

      const now = clock();
      const items = ((internalStorage.data as Record<string, unknown>)[field as string] ??
        {}) as Record<string, unknown>;
      const timestamps =
        (internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[
          field as string
        ] ?? {};

      const itemWithDeleteAt = {
        ...(value as object),
        deleteAt: options.deleteAt,
      };
      items[key] = itemWithDeleteAt;
      timestamps[key] = now;

      (internalStorage.data as Record<string, unknown>)[field as string] = items;
      (internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[
        field as string
      ] = timestamps;

      asyncState = { ...asyncState, data: { ...internalStorage.data } };

      emitter.emit(
        `${String(field)}:added` as keyof StoreEvents<S>,
        { key, item: itemWithDeleteAt } as StoreEvents<S>[keyof StoreEvents<S>],
      );

      saveToStorage(account, internalStorage);
      markDirty();
    },

    update<K extends MapKeys<S>>(field: K, key: string, value: ExtractMapItem<S[K]>): void {
      if (asyncState.status !== 'ready' || !internalStorage) {
        throw new Error('Store is not ready');
      }

      const items = ((internalStorage.data as Record<string, unknown>)[field as string] ??
        {}) as Record<string, { deleteAt: number }>;
      const existing = items[key];

      if (!existing) {
        throw new Error(`Item ${key} does not exist in ${String(field)}`);
      }

      const now = clock();
      const timestamps =
        (internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[
          field as string
        ] ?? {};

      const updatedItem = { ...(value as object), deleteAt: existing.deleteAt };
      items[key] = updatedItem;
      timestamps[key] = now;

      (internalStorage.data as Record<string, unknown>)[field as string] = items;
      (internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[
        field as string
      ] = timestamps;

      asyncState = { ...asyncState, data: { ...internalStorage.data } };

      emitter.emit(
        `${String(field)}:updated` as keyof StoreEvents<S>,
        { key, item: updatedItem } as StoreEvents<S>[keyof StoreEvents<S>],
      );

      saveToStorage(account, internalStorage);
      markDirty();
    },

    remove<K extends MapKeys<S>>(field: K, key: string): void {
      if (asyncState.status !== 'ready' || !internalStorage) {
        throw new Error('Store is not ready');
      }

      const items = ((internalStorage.data as Record<string, unknown>)[field as string] ??
        {}) as Record<string, { deleteAt: number }>;
      const existing = items[key];

      if (!existing) {
        throw new Error(`Item ${key} does not exist in ${String(field)}`);
      }

      const tombstones =
        (internalStorage.$tombstones as Record<string, Record<string, number>>)[field as string] ??
        {};
      tombstones[key] = existing.deleteAt;
      (internalStorage.$tombstones as Record<string, Record<string, number>>)[field as string] =
        tombstones;

      delete items[key];

      const timestamps =
        (internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[
          field as string
        ] ?? {};
      delete timestamps[key];

      asyncState = { ...asyncState, data: { ...internalStorage.data } };

      emitter.emit(
        `${String(field)}:removed` as keyof StoreEvents<S>,
        { key, item: existing } as StoreEvents<S>[keyof StoreEvents<S>],
      );

      saveToStorage(account, internalStorage);
      markDirty();
    },

    subscribe(callback: (state: AsyncState<DataOf<S>>) => void): () => void {
      callback(asyncState);
      return emitter.on('$store:state', () => callback(asyncState));
    },

    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),

    syncStatusStore,
    storageStatusStore,

    load,

    stop(): void {
      unwatchStorage?.();
      unwatchStorage = undefined;

      if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = undefined;
      }

      if (handleVisibilityChange) {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        handleVisibilityChange = undefined;
      }

      if (handleOnline) {
        window.removeEventListener('online', handleOnline);
        handleOnline = undefined;
      }
      if (handleOffline) {
        window.removeEventListener('offline', handleOffline);
        handleOffline = undefined;
      }

      if (syncIntervalTimer) {
        clearInterval(syncIntervalTimer);
        syncIntervalTimer = undefined;
      }

      if (handleBeforeUnload) {
        window.removeEventListener('beforeunload', handleBeforeUnload);
        handleBeforeUnload = undefined;
      }
    },

    getItemStore<K extends MapKeys<S>>(
      field: K,
      key: string,
    ): Readable<(ExtractMapItem<S[K]> & { deleteAt: number }) | undefined> {
      type ItemType = (ExtractMapItem<S[K]> & { deleteAt: number }) | undefined;

      const cacheKey = `${String(field)}:${key}`;
      const cached = itemStoreCache.get(cacheKey);
      if (cached) return cached as Readable<ItemType>;

      const getCurrentValue = (): ItemType => {
        if (asyncState.status !== 'ready') return undefined;
        const items = (asyncState.data[field] as Record<string, unknown>) ?? {};
        return items[key] as ItemType;
      };

      const itemStore: Readable<ItemType> = {
        subscribe(callback: (value: ItemType) => void): () => void {
          callback(getCurrentValue());

          const unsubState = emitter.on('$store:state', () => callback(getCurrentValue()));

          const unsubAdded = emitter.on(
            `${String(field)}:added` as keyof StoreEvents<S>,
            (e) => {
              const event = e as { key: string; item: unknown };
              if (event.key === key) callback(event.item as ItemType);
            },
          );
          const unsubUpdated = emitter.on(
            `${String(field)}:updated` as keyof StoreEvents<S>,
            (e) => {
              const event = e as { key: string; item: unknown };
              if (event.key === key) callback(event.item as ItemType);
            },
          );
          const unsubRemoved = emitter.on(
            `${String(field)}:removed` as keyof StoreEvents<S>,
            (e) => {
              const event = e as { key: string };
              if (event.key === key) callback(undefined);
            },
          );

          return () => {
            unsubState();
            unsubAdded();
            unsubUpdated();
            unsubRemoved();
          };
        },
      };

      itemStoreCache.set(cacheKey, itemStore);
      return itemStore;
    },

    getFieldStore<K extends keyof S>(field: K): Readable<DataOf<S>[K] | undefined> {
      type FieldType = DataOf<S>[K] | undefined;

      const cacheKey = String(field);
      const cached = fieldStoreCache.get(cacheKey);
      if (cached) return cached as Readable<FieldType>;

      const getCurrentValue = (): FieldType => {
        if (asyncState.status !== 'ready') return undefined;
        return asyncState.data[field];
      };

      const fieldDef = schema[field];
      const isMap = fieldDef.__type === 'map';

      const fieldStore: Readable<FieldType> = {
        subscribe(callback: (value: FieldType) => void): () => void {
          callback(getCurrentValue());

          const unsubState = emitter.on('$store:state', () => callback(getCurrentValue()));

          const unsubs: (() => void)[] = [unsubState];

          if (isMap) {
            unsubs.push(
              emitter.on(`${String(field)}:added` as keyof StoreEvents<S>, () => {
                callback(getCurrentValue());
              }),
            );
            unsubs.push(
              emitter.on(`${String(field)}:removed` as keyof StoreEvents<S>, () => {
                callback(getCurrentValue());
              }),
            );
          } else {
            unsubs.push(
              emitter.on(`${String(field)}:changed` as keyof StoreEvents<S>, () => {
                callback(getCurrentValue());
              }),
            );
          }

          return () => {
            for (const unsub of unsubs) {
              unsub();
            }
          };
        },
      };

      fieldStoreCache.set(cacheKey, fieldStore);
      return fieldStore;
    },

    async syncNow(): Promise<void> {
      if (!syncAdapter || asyncState.status !== 'ready') return;

      if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = undefined;
      }

      await performSync();
    },

    pauseSync(): void {
      syncPaused = true;
      mutableSyncStatus.isPaused = true;
      if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = undefined;
      }
      emitSyncEvent({ type: 'paused' });
    },

    resumeSync(): void {
      syncPaused = false;
      mutableSyncStatus.isPaused = false;
      emitSyncEvent({ type: 'resumed' });
      if (syncDirty) {
        scheduleSync();
      }
    },

    retryLoad(): void {
      if (asyncState.status !== 'loading') {
        throw new Error('Can only retry when in loading state');
      }

      mutableStorageStatus.storageError = null;
      emitStorageEvent({ type: 'saved', timestamp: clock() });

      asyncState = { status: 'idle', account: undefined };
      load();
    },

    async flush(timeoutMs = 30000): Promise<void> {
      const startTime = clock();
      while (mutableStorageStatus.isSaving) {
        if (clock() - startTime > timeoutMs) {
          throw new Error(`flush() timed out after ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };

  return store;
}

// ============================================================================
// Helpers
// ============================================================================

function deepMerge<T>(target: T, source: DeepPartial<T>): T {
  if (typeof source !== 'object' || source === null) {
    return source as T;
  }

  if (Array.isArray(source)) {
    return source as T;
  }

  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    return source as T;
  }

  const result = { ...target };

  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    if (sourceValue !== undefined) {
      (result as Record<string, unknown>)[key as string] = deepMerge(
        target[key],
        sourceValue as DeepPartial<T[keyof T]>,
      );
    }
  }

  return result;
}
```

---

## File 8: `src/sync/index.ts`

```typescript
/**
 * Single-Account Syncable Store - Public API
 */

// Schema definition
export {
  defineSchema,
  permanent,
  map,
  combineStatus,
  type PermanentField,
  type MapField,
  type Schema,
  type DataOf,
  type PermanentKeys,
  type MapKeys,
  type ExtractPermanent,
  type ExtractMapItem,
  type DeepPartial,
  type InternalStorage,
  type AsyncState,
  type StateEvent,
  type SyncStatus,
  type SyncEvent,
  type StorageStatus,
  type StorageEvent,
  type StoreChange,
  type StoreEvents,
  type SyncAdapter,
  type SyncConfig,
  type PullResponse,
  type PushResponse,
} from './types';

// Store creation
export {
  createSyncableStore,
  type SyncableStore,
  type SyncableStoreConfig,
  type Readable,
} from './createSyncableStore';

// Merge functions (for advanced use)
export {
  tiebreaker,
  mergePermanent,
  mergeMap,
  mergeStore,
  mergeAndCleanup,
  type PermanentMergeInput,
  type PermanentMergeResult,
  type MapState,
  type MapChange,
  type MapMergeResult,
  type StoreMergeResult,
  type MergeAndCleanupResult,
} from './merge';

// Cleanup function
export { cleanup, type CleanupResult } from './cleanup';
```

---

## Usage Example

```typescript
import { createSyncableStore, defineSchema, permanent, map } from './sync';
import { createLocalStorageAdapter } from './storage';

// Define schema
const schema = defineSchema({
  settings: permanent<{
    theme: 'light' | 'dark';
    notifications: boolean;
  }>(),
  operations: map<{
    hash: string;
    status: 'pending' | 'confirmed' | 'failed';
  }>(),
});

// Create store for a specific account
const store = createSyncableStore({
  schema,
  account: '0x1234567890abcdef1234567890abcdef12345678',
  storage: createLocalStorageAdapter(),
  storageKey: 'myapp-data-0x1234567890abcdef1234567890abcdef12345678',
  defaultData: () => ({
    settings: { theme: 'dark', notifications: true },
    operations: {},
  }),
});

// Set up event listeners BEFORE loading
store.on('$store:state', (event) => {
  console.log('State:', event.type);
});

store.on('settings:changed', (settings) => {
  console.log('Settings changed:', settings);
});

store.on('operations:added', ({ key, item }) => {
  console.log('Operation added:', key, item);
});

// Load the store
await store.load();

// Now the store is ready - access data
if (store.state.status === 'ready') {
  console.log('Current theme:', store.state.data.settings.theme);
}

// Modify data
store.set('settings', { theme: 'light', notifications: false });

// Add an operation with TTL (deleteAt)
const oneHourFromNow = Date.now() + 60 * 60 * 1000;
store.add('operations', 'tx-123', {
  hash: '0xabc...',
  status: 'pending',
}, { deleteAt: oneHourFromNow });

// Update an operation
store.update('operations', 'tx-123', {
  hash: '0xabc...',
  status: 'confirmed',
});

// Use fine-grained reactive stores
const settingsStore = store.getFieldStore('settings');
settingsStore.subscribe((settings) => {
  if (settings) {
    console.log('Reactive settings:', settings);
  }
});

const operationStore = store.getItemStore('operations', 'tx-123');
operationStore.subscribe((op) => {
  if (op) {
    console.log('Operation status:', op.status);
  }
});

// Clean up when done
store.stop();
```

---

## Server Sync Example

To enable server synchronization, implement the `SyncAdapter` interface:

```typescript
import type { SyncAdapter, InternalStorage } from './sync';

const schema = defineSchema({
  settings: permanent<{ theme: string }>(),
  operations: map<{ hash: string }>(),
});

type MySchema = typeof schema;

const syncAdapter: SyncAdapter<MySchema> = {
  async pull(account: `0x${string}`) {
    const response = await fetch(`/api/data/${account}`);
    const json = await response.json();
    
    return {
      data: json.data as InternalStorage<MySchema> | null,
      counter: BigInt(json.counter || 0),
    };
  },

  async push(
    account: `0x${string}`,
    data: InternalStorage<MySchema>,
    counter: bigint,
  ) {
    const response = await fetch(`/api/data/${account}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data,
        counter: counter.toString(),
      }),
    });

    const json = await response.json();
    
    return {
      success: json.success,
      currentCounter: json.currentCounter ? BigInt(json.currentCounter) : undefined,
      error: json.error,
    };
  },
};

const store = createSyncableStore({
  schema,
  account: '0x1234...',
  storage: createLocalStorageAdapter(),
  storageKey: 'myapp-0x1234...',
  defaultData: () => ({ settings: { theme: 'dark' }, operations: {} }),
  sync: syncAdapter,
  syncConfig: {
    debounceMs: 1000,      // Wait 1s after changes before syncing
    intervalMs: 30000,      // Also sync every 30s
    syncOnVisible: true,    // Sync when tab becomes visible
    syncOnReconnect: true,  // Sync when coming back online
    maxRetries: 3,          // Retry failed syncs 3 times
    retryBackoffMs: 1000,   // Start with 1s backoff, doubles each retry
  },
});
```

---

## TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

---

## Key Design Decisions

### 1. Single Account Binding
The store is bound to ONE account at creation time. This eliminates:
- Race conditions during account switching
- Complex `loadGeneration` tracking
- Cache invalidation on account change

Multi-account support is achieved by creating/destroying store instances at a higher level.

### 2. Explicit Load
Using `load()` instead of reactive `start()`:
- Clearer lifecycle: create → setup listeners → load → use → stop
- Returns a Promise so you can await initialization
- Allows setting up event listeners before any data loads

### 3. Two Field Types Only
- **Permanent fields**: Simple values, last-write-wins based on timestamp
- **Map fields**: Collections with per-item tracking and automatic TTL cleanup

### 4. Timestamp-Based Conflict Resolution
- Higher timestamp always wins
- On equal timestamps, deterministic tiebreaker (lexicographic comparison of JSON)
- Uses `json-stable-stringify` for consistent property ordering across all JS engines

### 5. Local-First Architecture
- All mutations immediately update local state and storage
- Server sync is eventual and non-blocking
- Works offline, syncs when reconnected

### 6. Fine-Grained Reactivity
- `getFieldStore()` for top-level fields
- `getItemStore()` for individual map items
- Subscribers only notified when their specific data changes

---

## Testing

Here's a basic test example using Vitest:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSyncableStore, defineSchema, permanent, map } from './sync';
import type { AsyncStorage, InternalStorage } from './sync';

const schema = defineSchema({
  settings: permanent<{ theme: string }>(),
  items: map<{ name: string }>(),
});

type TestSchema = typeof schema;

function createMockStorage(): AsyncStorage<InternalStorage<TestSchema>> {
  const store = new Map<string, InternalStorage<TestSchema>>();
  
  return {
    async load(key) {
      return store.get(key);
    },
    async save(key, data) {
      store.set(key, data);
    },
    async remove(key) {
      store.delete(key);
    },
    async exists(key) {
      return store.has(key);
    },
  };
}

describe('createSyncableStore', () => {
  it('should start in idle state', () => {
    const store = createSyncableStore({
      schema,
      account: '0x1234567890abcdef1234567890abcdef12345678',
      storage: createMockStorage(),
      storageKey: 'test-key',
      defaultData: () => ({ settings: { theme: 'dark' }, items: {} }),
    });

    expect(store.state.status).toBe('idle');
  });

  it('should transition to ready after load', async () => {
    const store = createSyncableStore({
      schema,
      account: '0x1234567890abcdef1234567890abcdef12345678',
      storage: createMockStorage(),
      storageKey: 'test-key',
      defaultData: () => ({ settings: { theme: 'dark' }, items: {} }),
    });

    await store.load();

    expect(store.state.status).toBe('ready');
    if (store.state.status === 'ready') {
      expect(store.state.data.settings.theme).toBe('dark');
    }
  });

  it('should update permanent field', async () => {
    const store = createSyncableStore({
      schema,
      account: '0x1234567890abcdef1234567890abcdef12345678',
      storage: createMockStorage(),
      storageKey: 'test-key',
      defaultData: () => ({ settings: { theme: 'dark' }, items: {} }),
    });

    await store.load();
    store.set('settings', { theme: 'light' });

    if (store.state.status === 'ready') {
      expect(store.state.data.settings.theme).toBe('light');
    }
  });

  it('should add and remove map items', async () => {
    const store = createSyncableStore({
      schema,
      account: '0x1234567890abcdef1234567890abcdef12345678',
      storage: createMockStorage(),
      storageKey: 'test-key',
      defaultData: () => ({ settings: { theme: 'dark' }, items: {} }),
    });

    await store.load();
    
    const deleteAt = Date.now() + 60000;
    store.add('items', 'item-1', { name: 'Test' }, { deleteAt });

    if (store.state.status === 'ready') {
      expect(store.state.data.items['item-1'].name).toBe('Test');
    }

    store.remove('items', 'item-1');

    if (store.state.status === 'ready') {
      expect(store.state.data.items['item-1']).toBeUndefined();
    }
  });

  it('should emit events on changes', async () => {
    const store = createSyncableStore({
      schema,
      account: '0x1234567890abcdef1234567890abcdef12345678',
      storage: createMockStorage(),
      storageKey: 'test-key',
      defaultData: () => ({ settings: { theme: 'dark' }, items: {} }),
    });

    const settingsHandler = vi.fn();
    store.on('settings:changed', settingsHandler);

    await store.load();
    store.set('settings', { theme: 'light' });

    expect(settingsHandler).toHaveBeenCalledWith({ theme: 'light' });
  });
});
```

---

## Summary

This implementation provides a complete, standalone syncable store that:

1. **Binds to a single account** - No account switching complexity
2. **Uses explicit `load()`** - Clear lifecycle, can setup listeners first
3. **Persists to local storage** - With cross-tab sync via storage events
4. **Syncs to server** - Pull/push pattern with optimistic locking
5. **Resolves conflicts** - Timestamp-based with deterministic tiebreaker
6. **Auto-cleans expired items** - Map items with `deleteAt` TTL
7. **Provides fine-grained reactivity** - Field and item-level stores
8. **Type-safe** - Full TypeScript support with schema inference

