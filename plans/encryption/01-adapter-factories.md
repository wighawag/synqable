# Phase 1: Adapter Factories

## Goal

Change `StorageConfig` and `SyncConfig` to accept adapter **factories** instead of adapter **instances**. The factories accept an optional `privateKey` parameter for encryption support.

## Current State

### StorageConfig (storage/types.ts)
```typescript
export interface StorageConfig<T> {
  adapter: AsyncStorage<T>;
  key: string;
  options?: StorageOptions;
}
```

### SyncConfig (sync/types.ts)
```typescript
export interface SyncConfig<S extends Schema> {
  adapter: SyncAdapter<S>;
  options?: SyncOptions;
}
```

---

## Proposed Changes

### 1. Storage Adapter Factory

```typescript
// File: packages/synqable/src/storage/types.ts

/**
 * Factory function that creates a storage adapter.
 * @param privateKey - Optional encryption key. If provided, data should be encrypted.
 */
export type StorageAdapterFactory<T> = (privateKey?: `0x${string}`) => AsyncStorage<T>;

/**
 * Combined storage configuration with adapter factory, key, and options.
 */
export interface StorageConfig<T> {
  /** Factory to create storage adapter (receives optional privateKey) */
  adapterFactory: StorageAdapterFactory<T>;

  /** Storage key for this store instance */
  key: string;

  /** Storage options */
  options?: StorageOptions;
}
```

### 2. Sync Adapter Factory

```typescript
// File: packages/synqable/src/sync/types.ts

/**
 * Factory function that creates a sync adapter.
 * @param privateKey - Optional encryption key. If provided, data should be encrypted.
 */
export type SyncAdapterFactory<S extends Schema> = (privateKey?: `0x${string}`) => SyncAdapter<S>;

/**
 * Combined sync configuration with adapter factory and options.
 */
export interface SyncConfig<S extends Schema> {
  /** Factory to create sync adapter (receives optional privateKey) */
  adapterFactory: SyncAdapterFactory<S>;

  /** Sync options */
  options?: SyncOptions;
}
```

---

## Usage Examples

### Before (current)
```typescript
const storage = createLocalStorageAdapter();

createSyncableStore({
  storage: {
    adapter: storage,
    key: 'myapp:user',
  },
  // ...
});
```

### After (with factory)
```typescript
// No encryption
createSyncableStore({
  storage: {
    adapterFactory: () => createLocalStorageAdapter(),
    key: 'myapp:user',
  },
  // ...
});

// With encryption (privateKey passed by createSyncableStore internally)
createSyncableStore({
  storage: {
    adapterFactory: (privateKey) => createLocalStorageAdapter({ 
      encryption: privateKey ? createEncryption(privateKey) : undefined 
    }),
    key: 'myapp:user',
  },
  privateKey: '0x...',  // New field on SyncableStoreConfig
  // ...
});
```

---

## Detailed File Changes

### 1. `storage/types.ts`

```typescript
// ADD: New type after AsyncStorage interface (around line 52)
/**
 * Factory function that creates a storage adapter.
 * @param privateKey - Optional encryption key. If provided, data should be encrypted.
 */
export type StorageAdapterFactory<T> = (privateKey?: `0x${string}`) => AsyncStorage<T>;

// CHANGE: StorageConfig interface (lines 12-21)
// FROM:
export interface StorageConfig<T> {
  adapter: AsyncStorage<T>;
  key: string;
  options?: StorageOptions;
}

// TO:
export interface StorageConfig<T> {
  /** Factory to create storage adapter (receives optional privateKey) */
  adapterFactory: StorageAdapterFactory<T>;
  /** Storage key for this store instance */
  key: string;
  /** Storage options */
  options?: StorageOptions;
}
```

### 2. `sync/types.ts`

```typescript
// ADD: New type after SyncAdapter interface (around line 143)
/**
 * Factory function that creates a sync adapter.
 * @param privateKey - Optional encryption key. If provided, data should be encrypted.
 */
export type SyncAdapterFactory<S extends Schema> = (privateKey?: `0x${string}`) => SyncAdapter<S>;

// CHANGE: SyncConfig interface (lines 171-177)
// FROM:
export interface SyncConfig<S extends Schema> {
  adapter: SyncAdapter<S>;
  options?: SyncOptions;
}

// TO:
export interface SyncConfig<S extends Schema> {
  /** Factory to create sync adapter (receives optional privateKey) */
  adapterFactory: SyncAdapterFactory<S>;
  /** Sync options */
  options?: SyncOptions;
}
```

### 3. `main/types.ts`

```typescript
// CHANGE: SyncableStoreConfig interface (lines 300-324)
// ADD privateKey field after account:

export interface SyncableStoreConfig<S extends Schema> {
  /** Schema definition */
  schema: S;

  /** Static account address - store is bound to this account */
  account: `0x${string}`;

  /** Optional private key for encryption */
  privateKey?: `0x${string}`;  // <-- ADD THIS FIELD

  /** Storage configuration: adapter factory, key, and options */
  storage: StorageConfig<InternalStorage<S>>;

  /** Default data factory */
  defaultData: () => DataOf<S>;

  // ... rest unchanged
}
```

### 4. `main/createSyncableStore.ts`

Search for where the storage adapter is obtained and used:

```typescript
// FIND (early in the function, around line 50-80):
// Look for something like:
const { adapter, key, options } = config.storage;

// CHANGE TO:
const { adapterFactory, key, options } = config.storage;
const adapter = adapterFactory(config.privateKey);

// FIND (in sync setup section, around line 200+):
// Look for something like:
const syncAdapter = config.sync.adapter;

// CHANGE TO:
const syncAdapter = config.sync.adapterFactory(config.privateKey);
```

### 5. `factory/types.ts`

```typescript
// CHANGE: FactoryStorageConfig interface (lines 8-17)
// FROM:
export interface FactoryStorageConfig<T> {
  adapter: AsyncStorage<T>;
  key: (account: `0x${string}`) => string;
  options?: StorageOptions;
}

// TO:
export interface FactoryStorageConfig<T> {
  /** Factory to create storage adapter */
  adapterFactory: StorageAdapterFactory<T>;
  /** Function to generate storage key from account address */
  key: (account: `0x${string}`) => string;
  /** Storage options */
  options?: StorageOptions;
}

// Also add import at top:
import type { StorageAdapterFactory } from '../storage/types.js';
```

### 6. `factory/index.ts`

```typescript
// CHANGE: In createSyncableStoreFactory function
// Update to use adapterFactory:

return (account: `0x${string}`) => {
  return createSyncableStore({
    schema: config.schema,
    account,
    // Note: privateKey is NOT passed here - that comes from MultiAccount in later phase
    storage: {
      adapterFactory: config.storage.adapterFactory,  // CHANGED from adapter
      key: config.storage.key(account),
      options: config.storage.options,
    },
    defaultData: config.defaultData,
    clock: config.clock,
    schemaVersion: config.schemaVersion,
    sync: config.sync,  // This also needs adapterFactory now
    migrations: config.migrations,
  });
};
```

### 7. Test File Updates

Search and replace in all test files:

```typescript
// Pattern to find:
storage: {
  adapter: mockStorage,
  key: 'some-key',
}

// Replace with:
storage: {
  adapterFactory: () => mockStorage,
  key: 'some-key',
}

// For sync tests, same pattern:
sync: {
  adapter: mockSyncAdapter,
}

// Replace with:
sync: {
  adapterFactory: () => mockSyncAdapter,
}
```

---

## Implementation Tasks

- [x] Add `StorageAdapterFactory<T>` type to `storage/types.ts`
- [x] Change `StorageConfig.adapter` to `StorageConfig.adapterFactory`
- [x] Add `SyncAdapterFactory<S>` type to `sync/types.ts`
- [x] Change `SyncConfig.adapter` to `SyncConfig.adapterFactory`
- [x] Add `privateKey?: `0x${string}`` to `SyncableStoreConfig` in `main/types.ts`
- [x] Update `createSyncableStore.ts` to call `adapterFactory(config.privateKey)`
- [x] Update `factory/types.ts` - change to use `adapterFactory`
- [x] Update `factory/index.ts` - pass through `adapterFactory`
- [x] Update index exports if needed
- [x] Update `syncable-store.test.ts` - change all `adapter:` to `adapterFactory: () =>`
- [x] Update `multi-account.test.ts` - same pattern
- [x] Update any other test files
- [x] Run `pnpm test` to verify all tests pass
- [x] Run `pnpm test:typecheck` to verify types

---

## Notes

- This is a **breaking change** for existing users (adapter → adapterFactory)
- Migration is simple: wrap existing adapter in `() => adapter`
- Encryption implementation is NOT part of this phase - just the factory plumbing
- MultiAccount is NOT touched in this phase
- The `privateKey` will be `undefined` for now until MultiAccount integration in Phase 3+
