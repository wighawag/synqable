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
    adapter: createLocalStorageAdapter(),
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
// Set a permanent field
store.set('settings', { theme: 'dark', notifications: false });

// Patch a permanent field (partial update)
store.patch('settings', { theme: 'light' });

// Add a map item (with TTL - deleteAt timestamp)
store.add('tasks', 'task-1', { title: 'Buy milk', completed: false }, {
  deleteAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
});

// Update a map item
store.update('tasks', 'task-1', { title: 'Buy milk', completed: true });

// Remove a map item
store.remove('tasks', 'task-1');

// Subscribe to state changes (Svelte store contract)
const unsubscribe = store.subscribe((state) => {
  if (state.status === 'ready') {
    console.log('Settings:', state.data.settings);
    console.log('Tasks:', state.data.tasks);
  }
});
```

## Multi-Account Support

For apps that support multiple accounts (e.g., wallet-connected dApps):

```typescript
import {
  createMultiAccountStore,
  createSyncableStoreFactory,
} from 'synqable';

// Create a factory that generates stores per account
const factory = createSyncableStoreFactory({
  schema,
  storage: {
    adapter: createLocalStorageAdapter(),
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
  storage: { adapter: createLocalStorageAdapter(), key: 'my-app' },
  defaultData: () => ({ settings: {}, tasks: {} }),
  sync: {
    adapter: syncAdapter,
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
  // { type: 'idle' | 'loading' | 'ready', error?: Error }
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
| `set(field, value)` | Set a permanent field value |
| `patch(field, partial)` | Partially update a permanent field |
| `add(field, key, value, options)` | Add an item to a map field |
| `update(field, key, value)` | Update an existing map item |
| `remove(field, key)` | Remove an item from a map field |
| `subscribe(callback)` | Subscribe to state changes |
| `watchField(field)` | Create a reactive store for a field |
| `watchItem(field, key)` | Create a reactive store for a map item |
| `syncNow()` | Force immediate sync |
| `flush(timeoutMs?)` | Wait for pending storage saves |
| `stop()` | Cleanup and stop all listeners |

### Store Properties

| Property | Description |
|----------|-------------|
| `state` | Current async state (readonly) |
| `account` | The account this store is bound to |
| `syncStatus$` | Reactive sync status store |
| `storageStatus$` | Reactive storage status store |

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
