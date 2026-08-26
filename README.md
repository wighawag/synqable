# synqable

A TypeScript library for building **syncable local-first stores** with multi-account support, offline-first operations, and CRDT-style conflict resolution.

## Features

- 🔄 **Local-first**: Data is stored locally and syncs to server when available
- 🔀 **CRDT Merge**: Last-Writer-Wins (LWW) conflict resolution with deterministic tiebreaker
- 🎚️ **Merge granularity you choose**: per value, per property, or per collection item
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
import { defineSchema, value, record, map } from 'synqable';

const schema = defineSchema({
  // Value fields: merged as a single unit, never deleted
  activeWorkspaceId: value<string>(),

  // Record fields: fixed set of properties, each merged independently
  settings: record<{
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

The choice between them is about **merge granularity**, which decides whether a
concurrent edit survives. See [Schema Design](#schema-design) before picking one.

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
    activeWorkspaceId: 'default',
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

// Set a value field
store.set('activeWorkspaceId', 'workspace-2');

// Set a record field (full replacement - stamps every property)
store.set('settings', { theme: 'dark', notifications: false });

// Update a record field with partial updates (stamps only `theme`, so a
// concurrent edit to `notifications` on another device still survives)
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
// Watch a record field across account switches
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
// Watch a record field
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
| `set(field, value)` | Replace a value or record field (on a record, stamps every property) |
| `update(field, partial)` | Update a **record** field with partial updates (stamps only the supplied properties) |
| `patch(field, fn)` | Patch a value or record field with a function (on a record, stamps only what changed) |
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

The three field types differ in **merge granularity**: the unit at which a
conflict is resolved, and therefore the unit at which a concurrent edit can be
lost. Pick the type by asking what two devices might edit at the same time.

| Field type | Merge granularity | Key set | Deletion |
|------------|-------------------|---------|----------|
| `value<T>()` | the whole value | single value | never deleted |
| `record<T>()` | per property | fixed, heterogeneous | never deleted |
| `map<T>()` | per key | open, homogeneous | `deleteAt` + TTL |

### Value Fields

Use for data that is genuinely atomic, where replacing it wholesale is the
intent:

```typescript
activeWorkspaceId: value<string>()
```

A value field is resolved as one unit. If two devices write it concurrently, the
later write wins **entirely**. That is the correct behaviour for an atomic value
and the wrong behaviour for a struct whose properties are edited independently -
use `record` for that.

Value fields also hold anything a record cannot: arrays, primitives, `Date`s,
class instances, and **structs whose properties carry a joint invariant**:

```typescript
dateRange: value<{start: number; end: number}>()   // start <= end
```

Merging `start` and `end` independently could converge on `start > end`, a range
that existed on no device. When properties must move together, they must merge
together.

`update()` is deliberately **not available** on value fields: a partial update
cannot merge independently there, so offering it would claim a granularity the
merge does not provide. Use `set()` or `patch()`.

### Record Fields

Use for a fixed set of named properties that may be edited independently, which
is what most settings and preferences objects are:

```typescript
settings: record<{
  theme: 'light' | 'dark';
  language: string;
}>()
```

Each property carries its own timestamp, so device A changing `theme` and
device B changing `language` converge with **both** edits intact. Modelling the
same struct as a `value` field would discard one of them.

- `set(field, whole)` asserts every property, so every property is stamped.
- `update(field, partial)` stamps only the properties you supply.
- `patch(field, fn)` stamps only the properties whose value actually changed.

Record granularity is **one level deep** by design. In
`record<{layout: {columns: number}}>()`, `layout` is stamped as a unit;
per-path timestamps at arbitrary depth is a different data structure and
deliberately out of scope.

Record fields have a fixed key set and no tombstones. If entries come and go,
use a map field.

`record<T>()` rejects arrays and primitives at the schema, and `mergeRecord`
rejects exotic objects (`Date`, `Map`, class instances) at runtime, because none
of them have independently mergeable properties. All of them belong in a `value`
field.

### `value` or `record`? They accept the same `T`

Both can hold `{theme, fontSize}`, and the type does not tell them apart. The
question is not what the data looks like, it is whether the properties can be
**observed independently**, which only you know:

| Modelling mistake | Result | How you find out |
|---|---|---|
| mergeable struct as `value` | an edit is lost | visible: a setting reverts, and the surviving state did exist on some device |
| atomic struct as `record` | torn write | silent: converges to a combination that existed nowhere, possibly breaking an invariant |

The second failure is worse, so **prefer `value` when unsure** and move to
`record` once you know the properties are genuinely independent. Converting that
direction needs no migration (see below); the reverse loses per-property
history.

### Map Fields

Use for collections where items have individual lifecycles:

```typescript
tasks: map<{
  title: string;
  completed: boolean;
}>()
```

Map items automatically include a `deleteAt` timestamp for TTL-based cleanup.

### Choosing

- Properties edited independently on different devices? **`record`**
- Entries that come and go, or need a TTL? **`map`**
- A single indivisible value replaced wholesale? **`value`**

A homogeneous, open-ended collection (`Record<string, Task>`) belongs in a `map`,
not a `value` or `record`: those merge a fixed key set and cannot express
deletion.

## How Merge Works

When syncing with the server, synqable uses a **Last-Writer-Wins (LWW)** strategy:

1. **Timestamps**: every merge unit carries its own timestamp - one per value
   field, one per record property, one per map item
2. **Higher wins**: the version with the higher timestamp wins
3. **Deterministic tiebreaker**: if timestamps match, a deterministic hash
   comparison breaks the tie the same way on every device
4. **Tombstones**: deleted map items are tracked as tombstones until their TTL expires

This ensures:
- Deterministic merge results across all clients
- Eventual consistency: every device converges on the same state
- No **divergence** between devices

It does **not** mean every edit survives. LWW resolves a conflict by discarding
the loser, and the merge unit is what decides whether two edits even conflict.
Two devices editing different properties of a `record` do not conflict and both
edits survive; the same two edits against a `value` field are one conflict, and
one of them is discarded. Choosing the right field type is how you control that.

### Converting a field from `value` to `record`

Data written while a field was a `value` has a single field-level timestamp and
no per-property timestamps. `mergeRecord` uses the field-level timestamp as the
**floor** for any property that lacks its own, so previously written data merges
correctly without a migration or a `$version` bump.

## License

MIT
