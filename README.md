# synqable

A TypeScript library for building **syncable local-first stores** with multi-account support, offline-first operations, and CRDT-style conflict resolution.

## Features

- 🔄 **Local-first**: Data is stored locally and syncs to server when available
- 🔀 **CRDT Merge**: Last-Writer-Wins (LWW) conflict resolution with deterministic tiebreaker
- 👥 **Multi-account**: Seamless account switching with lazy lifecycle management
- 📦 **Type-safe Schema**: Define your data shape with full TypeScript inference
- ⚡ **Svelte Compatible**: Follows the Svelte store contract out of the box
- 🔌 **Pluggable Storage**: Built-in localStorage adapter, easily extend for IndexedDB, etc.
- 🌐 **Pluggable Sync**: Bring your own server sync adapter

## Installation

```bash
npm install synqable
# or
pnpm add synqable
```

## Quick Start

### 1. Define Your Schema

```typescript
import { defineSchema, permanent, map } from 'synqable';

const schema = defineSchema({
  // Permanent fields: single values, updated as whole, never deleted
  settings: permanent<{
    theme: 'light' | 'dark';
    notifications: boolean;
  }>(),

  // Map fields: key-value collections with per-item timestamps and TTL
  tasks: map<{
    title: string;
    completed: boolean;
  }>(),
});
```

### 2. Create a Store

```typescript
import { createSyncableStore, createLocalStorageAdapter } from 'synqable';

const store = createSyncableStore({
  schema,
  account: '0x1234...', // Ethereum-style address
  storage: {
    adapterFactory: () => createLocalStorageAdapter(),
    key: 'my-app-data',
  },
  defaultData: () => ({
    settings: { theme: 'light', notifications: true },
    tasks: {},
  }),
});

// Initialize the store
await store.load();
```

### 3. Use the Store

```typescript
// Get current state synchronously
const state = store.get();
if (state.status === 'ready') {
  console.log('Settings:', state.data.settings);
  console.log('Tasks:', state.data.tasks);
}

// Set a permanent field (full replacement)
store.set('settings', { theme: 'dark', notifications: false });

// Update a permanent field with partial updates (deep merge)
store.update('settings', { theme: 'light' });

// Add a map item (with required deleteAt timestamp)
store.addItem('tasks', 'task-1', { title: 'Buy milk', completed: false }, {
  deleteAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
});

// Set a map item (full replacement, preserves deleteAt)
store.setItem('tasks', 'task-1', { title: 'Buy milk', completed: true });

// Update a map item with partial updates (deep merge, preserves deleteAt)
store.updateItem('tasks', 'task-1', { completed: true });

// Remove a map item
store.removeItem('tasks', 'task-1');

// Subscribe to lifecycle state changes
const unsubscribe = store.state$.subscribe((state) => {
  console.log('Status:', state.status); // 'idle' | 'loading' | 'ready'
  console.log('Account:', state.account);
  console.log('Is loading:', state.isLoading);
  console.log('Load error:', state.loadError);
});
```

## Multi-Account Support

For apps that support multiple accounts (e.g., wallet-connected dApps):

```typescript
import {
  createMultiAccountStore,
  createSyncableStoreFactory,
  createLocalStorageAdapterFactory,
} from 'synqable';

// Create a factory that generates stores per account
const factory = createSyncableStoreFactory({
  schema,
  storage: {
    adapterFactory: createLocalStorageAdapterFactory(),
    key: (account) => `my-app-${account}`,
  },
  defaultData: () => ({
    settings: { theme: 'light', notifications: true },
    tasks: {},
  }),
});

// Create the multi-account manager
const multiStore = createMultiAccountStore({
  accountStore, // Your wallet connection's account store
  factory,
});

// Subscribe - automatically handles account switches
multiStore.subscribe((store) => {
  if (store) {
    // store is ready for current account
  } else {
    // No account connected
  }
});

// Use reactive state directly (works across account switches)
multiStore.state$.subscribe((state) => {
  console.log('Status:', state.status);
  console.log('Account:', state.account);
});
```

### Multi-Account with Encryption

When using encryption with multi-account, provide an `AccountWithSigner` store instead of a plain address store:

```typescript
import {
  createMultiAccountStore,
  createSyncableStoreFactory,
  createLocalStorageAdapterFactory,
  createAesGcmProvider,
  type AccountWithSigner,
} from 'synqable';

// Account store that provides both address and privateKey
const accountStore: Readable<AccountWithSigner | undefined> = // from wallet

// Factory with encryption support
const factory = createSyncableStoreFactory({
  schema,
  storage: {
    adapterFactory: createLocalStorageAdapterFactory(createAesGcmProvider),
    key: (account) => `my-app-${account}`,
  },
  defaultData: () => ({ settings: {}, tasks: {} }),
});

// Multi-account manager - automatically passes privateKey for encryption
const multiStore = createMultiAccountStore({
  accountStore, // Emits { owner: '0x...', privateKey: '0x...' }
  factory,
});
```

### Multi-Account Watch Methods

Watch fields and items directly on the multi-account store - they automatically update when the account changes:

```typescript
// Watch a permanent field across account switches
const settings$ = multiStore.watchField('settings');
settings$.subscribe((settings) => {
  console.log('Settings:', settings); // undefined when no account connected
});

// Watch a specific map item
const task$ = multiStore.watchItem('tasks', 'task-1');
task$.subscribe((task) => {
  console.log('Task:', task);
});

// Watch map item IDs (only notifies on additions/removals)
const taskIds$ = multiStore.watchItemIds('tasks');
taskIds$.subscribe((ids) => {
  console.log('Task IDs:', ids); // [] when no account connected
});

// Watch sync and storage status
multiStore.syncStatus$.subscribe((status) => {
  console.log('Sync status:', status.displayState);
});

multiStore.storageStatus$.subscribe((status) => {
  console.log('Storage status:', status.displayState);
});
```

## Server Sync

Add server synchronization by providing a sync adapter:

```typescript
import { createSyncableStore, type SyncAdapter } from 'synqable';

const syncAdapter: SyncAdapter<typeof schema> = {
  async pull(account) {
    const response = await fetch(`/api/sync/${account}`);
    const data = await response.json();
    return { success: true, data, counter: BigInt(data.counter) };
  },

  async push(account, data, counter) {
    const response = await fetch(`/api/sync/${account}`, {
      method: 'POST',
      body: JSON.stringify({ data, counter: counter.toString() }),
    });
    return { success: response.ok };
  },
};

const store = createSyncableStore({
  schema,
  account: '0x1234...',
  storage: { adapterFactory: () => createLocalStorageAdapter(), key: 'my-app' },
  defaultData: () => ({ settings: {}, tasks: {} }),
  sync: {
    adapterFactory: () => syncAdapter,
    options: {
      debounceMs: 1000,      // Debounce pushes
      intervalMs: 30000,     // Periodic sync
      syncOnVisible: true,   // Sync when tab becomes visible
      syncOnReconnect: true, // Sync when coming back online
      maxRetries: 3,         // Retry failed syncs
    },
  },
});
```

## Encryption

Encrypt local storage data using AES-GCM encryption derived from a private key:

```typescript
import {
  createLocalStorageAdapterFactory,
  createAesGcmProvider,
} from 'synqable';

// Create a factory that supports encryption
const storageFactory = createLocalStorageAdapterFactory(createAesGcmProvider);

const store = createSyncableStore({
  schema,
  account: '0x1234...',
  privateKey: '0xabc123...', // When provided, data is encrypted
  storage: {
    adapterFactory: storageFactory,
    key: 'my-app-data',
  },
  defaultData: () => ({ settings: {}, tasks: {} }),
});
```

When `privateKey` is provided and the storage adapter factory supports encryption:
- All data is encrypted before saving to localStorage
- Data is decrypted when loading
- Encrypted data uses the `enc:` prefix for detection
- Plain data can still be read (migration-friendly)

## Built-in Sync Adapter: secp256k1-db

For Ethereum wallet-based apps, use the built-in secp256k1-db sync adapter. This adapter works with [secp256k1-db](https://github.com/wighawag/secp256k1-db), a Cloudflare Workers service that allows Ethereum wallets to store and retrieve signed data.

```typescript
import {
  createSyncableStore,
  createSecp256k1DBAdapterFactory,
} from 'synqable';

const syncAdapterFactory = createSecp256k1DBAdapterFactory({
  endpoint: 'https://your-secp256k1-db.workers.dev',
  namespace: 'my-app',
  encrypted: true, // Enable end-to-end encryption (default)
});

const store = createSyncableStore({
  schema,
  account: '0x1234...',
  privateKey: '0xabc123...', // Used for both signing and encryption
  storage: { adapterFactory: storageFactory, key: 'my-app' },
  defaultData: () => ({ settings: {}, tasks: {} }),
  sync: {
    adapterFactory: syncAdapterFactory,
    options: { debounceMs: 1000 },
  },
});
```

The `privateKey` is used for:
1. **Signing** - Creating signatures for authenticated writes to secp256k1-db
2. **Encryption** - Encrypting data before sending to server (when `encrypted: true`)

### Using with Wallet Libraries

You can also create signers from existing wallet libraries:

```typescript
import {
  fromViemWalletClient,
  fromEthersSigner,
  fromPrivateKey,
  createSecp256k1DBSyncAdapterFactory,
} from 'synqable';

// Using viem
const signer = fromViemWalletClient(walletClient, account);

// Using ethers.js
const signer = fromEthersSigner(ethersSigner);

// Using raw private key
const signer = fromPrivateKey('0x...');

const syncAdapterFactory = createSecp256k1DBSyncAdapterFactory({
  endpoint: 'https://your-secp256k1-db.workers.dev',
  namespace: 'my-app',
  signer,
});
```

## Reactive Status

Monitor sync and storage status for UI feedback:

```typescript
// Subscribe to sync status
store.syncStatus$.subscribe((status) => {
  console.log('Is syncing:', status.isSyncing);
  console.log('Is online:', status.isOnline);
  console.log('Has pending:', status.hasPendingSync);
  console.log('Display state:', status.displayState); // 'syncing' | 'offline' | 'error' | 'idle'
});

// Subscribe to storage status
store.storageStatus$.subscribe((status) => {
  console.log('Is saving:', status.isSaving);
  console.log('Display state:', status.displayState); // 'saving' | 'error' | 'idle'
});

// Combined status for simple UI indicators
import { combineStatus } from 'synqable';

const combined = combineStatus(syncStatus, storageStatus);
// { hasError, hasUnsavedChanges, isBusy }
```

## Watch Specific Fields

Create reactive stores for individual fields or items:

```typescript
// Watch a permanent field
const settings$ = store.watchField('settings');
settings$.subscribe((settings) => {
  console.log('Settings changed:', settings);
});

// Watch a specific map item
const task$ = store.watchItem('tasks', 'task-1');
task$.subscribe((task) => {
  console.log('Task updated:', task);
});

// Watch map item IDs (only notifies on additions/removals, not updates)
const taskIds$ = store.watchItemIds('tasks');
taskIds$.subscribe((ids) => {
  console.log('Task IDs:', ids);
});
```

## Event System

Subscribe to granular change events:

```typescript
// Permanent field changes
store.on('settings:changed', (settings) => {
  console.log('Settings changed:', settings);
});

// Map item events
store.on('tasks:added', ({ key, item }) => {
  console.log(`Task ${key} added:`, item);
});

store.on('tasks:updated', ({ key, item }) => {
  console.log(`Task ${key} updated:`, item);
});

store.on('tasks:removed', ({ key, item }) => {
  console.log(`Task ${key} removed:`, item);
});

// Store lifecycle events
store.on('$store:state', (event) => {
  // { type: 'idle'; error?: Error } | { type: 'loading' } | { type: 'ready' }
});

store.on('$store:sync', (event) => {
  // { type: 'pending' | 'started' | 'completed' | 'failed' | 'offline' | 'online' }
});

store.on('$store:storage', (event) => {
  // { type: 'saving' | 'saved' | 'failed' }
});
```

## API Reference

### Store Methods

| Method | Description |
|--------|-------------|
| `load()` | Initialize the store by loading from storage |
| `get()` | Get current async state synchronously |
| `set(field, value)` | Set a permanent field value (full replacement) |
| `update(field, partial)` | Update a permanent field with partial updates (deep merge) |
| `addItem(field, key, value, options)` | Add an item to a map field (requires `deleteAt`) |
| `setItem(field, key, value)` | Set a map item (full replacement, preserves `deleteAt`) |
| `updateItem(field, key, partial)` | Update a map item with partial updates (deep merge) |
| `removeItem(field, key)` | Remove an item from a map field |
| `on(event, callback)` | Subscribe to type-safe events |
| `off(event, callback)` | Unsubscribe from events |
| `watchField(field)` | Create a reactive store for a field |
| `watchItem(field, key)` | Create a reactive store for a map item |
| `watchItemIds(field)` | Create a reactive store for map item IDs |
| `syncNow()` | Force immediate sync |
| `retryLoad()` | Retry loading after a migration failure |
| `flush(timeoutMs?)` | Wait for pending storage saves |
| `stop()` | Cleanup and stop all listeners |

### Store Properties

| Property | Description |
|----------|-------------|
| `account` | The account this store is bound to |
| `state$` | Reactive store lifecycle state |
| `syncStatus$` | Reactive sync status store |
| `storageStatus$` | Reactive storage status store |

### MultiAccountStore Methods

| Method | Description |
|--------|-------------|
| `subscribe(callback)` | Subscribe to current store changes |
| `get()` | Get current store synchronously (null if no account) |
| `watchField(field)` | Watch a field across account switches |
| `watchItem(field, key)` | Watch a map item across account switches |
| `watchItemIds(field)` | Watch map item IDs across account switches |

### MultiAccountStore Properties

| Property | Description |
|----------|-------------|
| `state$` | Reactive lifecycle state (from current store) |
| `syncStatus$` | Reactive sync status (from current store) |
| `storageStatus$` | Reactive storage status (from current store) |

### Type Utilities

```typescript
import type {
  FieldReadable,    // Readable type for watchField
  ItemReadable,     // Readable type for watchItem
  ItemIdsReadable,  // Readable type for watchItemIds
  ReadableValue,    // Extract value type from Readable
  FieldReadables,   // All field readable types for a schema
  ItemReadables,    // All item readable types for map fields
  ItemIdsReadables, // All item IDs readable types for map fields
} from 'synqable';

// Example usage
const settingsStore: FieldReadable<typeof schema, 'settings'> = store.watchField('settings');
const taskStore: ItemReadable<typeof schema, 'tasks'> = store.watchItem('tasks', 'task-1');
const taskIdsStore: ItemIdsReadable<typeof schema, 'tasks'> = store.watchItemIds('tasks');

// Extract value type from any readable
type SettingsValue = ReadableValue<typeof settingsStore>;
```

## Schema Design

### Permanent Fields

Use for configuration, settings, or singleton data that's updated as a whole:

```typescript
settings: permanent<{
  theme: 'light' | 'dark';
  language: string;
}>()
```

### Map Fields

Use for collections where items have individual lifecycles:

```typescript
tasks: map<{
  title: string;
  completed: boolean;
}>()
```

Map items automatically include a `deleteAt` timestamp for TTL-based cleanup.

## How Merge Works

When syncing with the server, synqable uses a **Last-Writer-Wins (LWW)** strategy:

1. **Timestamps**: Each field/item has a timestamp tracking when it was last modified
2. **Higher wins**: The version with the higher timestamp wins
3. **Deterministic tiebreaker**: If timestamps match, JSON-stable-stringify comparison breaks the tie
4. **Tombstones**: Deleted map items are tracked as tombstones until their TTL expires

This ensures:
- Deterministic merge results across all clients
- No data loss during concurrent edits
- Eventual consistency

## License

MIT
