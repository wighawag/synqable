# Encryption System & Adapter Factory Design

## Overview

This document outlines the design for:
1. **Pluggable encryption** via an `EncryptionProvider` interface
2. **LocalStorage adapter factory** producing keyed instances with shared listener infrastructure
3. **Multi-account system modification** to support `SignerStore` with optional encryption keys

## Core Concepts

### AccountOrSigner Discriminated Union

Replace the current `AccountStore` pattern with a discriminated union that clearly separates unencrypted vs encrypted access:

```typescript
/**
 * Account-only connection - no encryption capability.
 * Used when user connects with address only (e.g., read-only view).
 */
export interface Account {
  type: 'account';
  address: `0x${string}`;
}

/**
 * Signer connection - always has encryption capability.
 * Used when user connects with full wallet access and can sign.
 */
export interface Signer {
  type: 'signer';
  owner: `0x${string}`;
  /** Private key for encryption (hex-encoded) - mandatory for signers */
  privateKey: `0x${string}`;
}

/**
 * Discriminated union: either account-only or full signer access.
 */
export type AccountOrSigner = Account | Signer;

/**
 * Helper to get the address from either type.
 */
export function getAddress(accountOrSigner: AccountOrSigner): `0x${string}` {
  return accountOrSigner.type === 'account'
    ? accountOrSigner.address
    : accountOrSigner.owner;
}

/**
 * Store of account/signer information.
 * Value is undefined when no account is connected.
 */
export type AccountOrSignerStore = Readable<AccountOrSigner | undefined>;
```

**Behavior:**
- `Account`: Loads data unencrypted. **Fails** if existing data is encrypted.
- `Signer`: Always encrypts data. Can only read encrypted data.

---

## Encryption Provider Interface

### Design Goals

- **Pluggable**: Users can provide their own encryption implementation
- **Async-ready**: Encryption operations can be async (for WebCrypto, etc.)
- **Type-safe**: Clear input/output types
- **Key-bound**: Provider instances are bound to a specific key

### Interface Definition

```typescript
// File: packages/synqable/src/encryption/types.ts

/**
 * Encryption provider interface.
 * Implementations are bound to a specific encryption key.
 */
export interface EncryptionProvider {
  /**
   * Encrypt data.
   * @param data - Plain text data to encrypt
   * @returns Encrypted data (typically base64 or hex encoded)
   */
  encrypt(data: string): Promise<string>;

  /**
   * Decrypt data.
   * @param encryptedData - Encrypted data to decrypt
   * @returns Decrypted plain text data
   * @throws Error if decryption fails (wrong key, corrupted data, etc.)
   */
  decrypt(encryptedData: string): Promise<string>;
}

/**
 * Factory function that creates an EncryptionProvider from a private key.
 */
export type EncryptionProviderFactory = (privateKey: `0x${string}`) => EncryptionProvider;

/**
 * Prefix marker for encrypted data.
 * Used to detect whether stored data is encrypted without parsing.
 */
export const ENCRYPTED_PREFIX = 'enc:';

/**
 * Check if a string is encrypted (has the prefix marker).
 */
export function isEncrypted(data: string): boolean {
  return data.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Error thrown when Account mode tries to load encrypted data.
 */
export class EncryptedDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedDataError';
  }
}
```

**Encryption Detection:**
- Encrypted data is prefixed with `enc:` marker
- When loading, check for prefix to determine if decryption is needed
- `Account` (no encryption) throws `EncryptedDataError` if data has `enc:` prefix

### Example Implementation (AES-GCM)

```typescript
// File: packages/synqable/src/encryption/aes-gcm.ts

import type { EncryptionProvider, EncryptionProviderFactory } from './types.js';

/**
 * Creates an AES-GCM encryption provider from a private key.
 * The private key is used to derive the actual AES key via HKDF.
 */
export const createAesGcmProvider: EncryptionProviderFactory = (privateKey) => {
  // Derive AES key from private key (implementation detail)
  let cryptoKey: CryptoKey | null = null;
  
  async function getKey(): Promise<CryptoKey> {
    if (cryptoKey) return cryptoKey;
    
    // Convert hex private key to bytes
    const keyBytes = hexToBytes(privateKey);
    
    // Import as raw key material
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      'HKDF',
      false,
      ['deriveKey']
    );
    
    // Derive AES-GCM key
    cryptoKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('synqable-v1'),
        info: new TextEncoder().encode('aes-gcm-key'),
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    
    return cryptoKey;
  }
  
  return {
    async encrypt(data: string): Promise<string> {
      const key = await getKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(data);
      
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoded
      );
      
      // Combine IV + ciphertext and encode as base64
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      
      return bytesToBase64(combined);
    },
    
    async decrypt(encryptedData: string): Promise<string> {
      const key = await getKey();
      const combined = base64ToBytes(encryptedData);
      
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
      );
      
      return new TextDecoder().decode(decrypted);
    },
  };
};

// Helper functions (implementation detail)
function hexToBytes(hex: string): Uint8Array { /* ... */ }
function bytesToBase64(bytes: Uint8Array): string { /* ... */ }
function base64ToBytes(base64: string): Uint8Array { /* ... */ }
```

---

## LocalStorage Adapter Factory

### Design Goals

- **Key isolation**: Each adapter instance is bound to a specific encryption key
- **Shared infrastructure**: All instances share the same storage event listener
- **Backward compatible**: Works without encryption when no provider is given

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    LocalStorageManager                          │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │                  Shared Infrastructure                     │ │
│  │  - Single global storage event listener                    │ │
│  │  - Map<key, Set<callback>> for all watchers                │ │
│  │  - Reference counting for cleanup                          │ │
│  └───────────────────────────────────────────────────────────┘ │
│                              │                                  │
│              ┌───────────────┼───────────────┐                  │
│              ▼               ▼               ▼                  │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │  Instance A   │  │  Instance B   │  │  Instance C   │       │
│  │ EncryptKey: X │  │ EncryptKey: Y │  │ No Encryption │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

### Interface Definition

```typescript
// File: packages/synqable/src/storage/LocalStorageAdapter.ts

import type { WatchableStorage, StorageChangeCallback } from './types.js';
import type { EncryptionProvider } from '../encryption/types.js';

export interface LocalStorageAdapterOptions<T> {
  /** Optional serializer, defaults to JSON.stringify */
  serialize?: (data: T) => string;
  /** Optional deserializer, defaults to JSON.parse */
  deserialize?: (data: string) => T;
  /** Optional encryption provider - if provided, data will be encrypted */
  encryption?: EncryptionProvider;
}

/**
 * LocalStorage manager - singleton that manages shared listener infrastructure.
 */
export interface LocalStorageManager {
  /**
   * Create an adapter instance with optional encryption.
   * All instances share the same storage event listener.
   */
  createAdapter<T>(options?: LocalStorageAdapterOptions<T>): WatchableStorage<T>;
  
  /**
   * Dispose the manager and clean up all listeners.
   * Should only be called when completely done with localStorage.
   */
  dispose(): void;
}

/**
 * Create a LocalStorage manager.
 * The manager maintains shared infrastructure for all adapter instances.
 */
export function createLocalStorageManager(): LocalStorageManager;

// ============================================================================
// Convenience function for backward compatibility
// ============================================================================

/**
 * Create a standalone LocalStorage adapter (backward compatible).
 * For new code using encryption, prefer createLocalStorageManager().
 */
export function createLocalStorageAdapter<T>(
  options?: LocalStorageAdapterOptions<T>
): WatchableStorage<T>;
```

### Implementation Outline

```typescript
// Internal shared state
interface SharedInfrastructure {
  watchers: Map<string, Set<{ callback: StorageChangeCallback<unknown>; deserialize: (s: string) => unknown; decrypt?: (s: string) => Promise<string> }>>;
  globalListener: ((e: StorageEvent) => void) | null;
}

export function createLocalStorageManager(): LocalStorageManager {
  const shared: SharedInfrastructure = {
    watchers: new Map(),
    globalListener: null,
  };

  function ensureGlobalListener() {
    if (shared.globalListener) return;

    shared.globalListener = async (e: StorageEvent) => {
      if (!e.key || !e.newValue) return;

      const callbacks = shared.watchers.get(e.key);
      if (!callbacks || callbacks.size === 0) return;

      // Notify all watchers for this key
      for (const { callback, deserialize, decrypt } of callbacks) {
        try {
          let rawValue = e.newValue;
          if (decrypt) {
            rawValue = await decrypt(rawValue);
          }
          const newValue = deserialize(rawValue);
          callback(e.key, newValue);
        } catch {
          callback(e.key, undefined);
        }
      }
    };

    window.addEventListener('storage', shared.globalListener);
  }

  function cleanupGlobalListener() {
    if (shared.watchers.size === 0 && shared.globalListener) {
      window.removeEventListener('storage', shared.globalListener);
      shared.globalListener = null;
    }
  }

  return {
    createAdapter<T>(options?: LocalStorageAdapterOptions<T>): WatchableStorage<T> {
      const serialize = options?.serialize ?? JSON.stringify;
      const deserialize = (options?.deserialize ?? JSON.parse) as (data: string) => T;
      const encryption = options?.encryption;

      return {
        async load(key: string): Promise<T | undefined> {
          try {
            let stored = localStorage.getItem(key);
            if (!stored) return undefined;
            
            // Check for encryption prefix
            const isDataEncrypted = stored.startsWith(ENCRYPTED_PREFIX);
            
            if (encryption) {
              // Signer mode: data must be encrypted
              if (!isDataEncrypted) {
                throw new Error('Expected encrypted data but found unencrypted');
              }
              // Remove prefix and decrypt
              stored = await encryption.decrypt(stored.slice(ENCRYPTED_PREFIX.length));
            } else {
              // Account mode: data must NOT be encrypted
              if (isDataEncrypted) {
                throw new EncryptedDataError(
                  'Cannot load encrypted data without encryption key. ' +
                  'Connect with a signer to access this data.'
                );
              }
            }
            
            return deserialize(stored);
          } catch (error) {
            if (error instanceof EncryptedDataError) throw error;
            return undefined;
          }
        },

        async save(key: string, data: T): Promise<void> {
          let serialized = serialize(data);
          if (encryption) {
            // Add prefix marker before encrypted data
            serialized = ENCRYPTED_PREFIX + await encryption.encrypt(serialized);
          }
          localStorage.setItem(key, serialized);
        },

        async remove(key: string): Promise<void> {
          localStorage.removeItem(key);
        },

        async exists(key: string): Promise<boolean> {
          return localStorage.getItem(key) !== null;
        },

        watch(key: string, callback: StorageChangeCallback<T>): () => void {
          ensureGlobalListener();

          if (!shared.watchers.has(key)) {
            shared.watchers.set(key, new Set());
          }
          
          const entry = {
            callback: callback as StorageChangeCallback<unknown>,
            deserialize: deserialize as (s: string) => unknown,
            decrypt: encryption?.decrypt.bind(encryption),
          };
          
          shared.watchers.get(key)!.add(entry);

          return () => {
            const callbacks = shared.watchers.get(key);
            if (callbacks) {
              callbacks.delete(entry);
              if (callbacks.size === 0) {
                shared.watchers.delete(key);
              }
            }
            cleanupGlobalListener();
          };
        },
      };
    },

    dispose() {
      if (shared.globalListener) {
        window.removeEventListener('storage', shared.globalListener);
        shared.globalListener = null;
      }
      shared.watchers.clear();
    },
  };
}
```

---

## Multi-Account System Modifications

### Updated Types

```typescript
// File: packages/synqable/src/multi-account/types.ts

import type { Schema, SyncableStore, Readable } from '../main/types.js';

/**
 * Account-only connection - no encryption capability.
 * Used when user connects with address only.
 */
export interface Account {
  type: 'account';
  address: `0x${string}`;
}

/**
 * Signer connection - always has encryption capability.
 * Used when user connects with full wallet access.
 */
export interface Signer {
  type: 'signer';
  owner: `0x${string}`;
  /** Private key for encryption (hex-encoded) - mandatory */
  privateKey: `0x${string}`;
}

/**
 * Discriminated union: either account-only or full signer access.
 */
export type AccountOrSigner = Account | Signer;

/**
 * Helper to get the address from either type.
 */
export function getAddress(accountOrSigner: AccountOrSigner): `0x${string}` {
  return accountOrSigner.type === 'account'
    ? accountOrSigner.address
    : accountOrSigner.owner;
}

/**
 * Store of account/signer information.
 */
export type AccountOrSignerStore = Readable<AccountOrSigner | undefined>;

// Keep backward compatibility
/**
 * @deprecated Use AccountOrSignerStore instead
 */
export type AccountStore = Readable<`0x${string}` | undefined>;

/**
 * Factory function that creates a SyncableStore for a given account or signer.
 */
export type SyncableStoreFactoryWithEncryption<S extends Schema> = (
  accountOrSigner: AccountOrSigner
) => SyncableStore<S>;

/**
 * Configuration for multi-account store manager with encryption support.
 */
export interface MultiAccountStoreConfigWithEncryption<S extends Schema> {
  /** Account/signer store to subscribe to */
  accountStore: AccountOrSignerStore;

  /** Factory function to create stores */
  factory: SyncableStoreFactoryWithEncryption<S>;
}
```

### Updated Factory

```typescript
// File: packages/synqable/src/factory/index.ts

import type { Schema, InternalStorage, DataOf } from '../main/types.js';
import type { AccountOrSigner, SyncableStoreFactoryWithEncryption } from '../multi-account/types.js';
import { getAddress } from '../multi-account/types.js';
import type { EncryptionProviderFactory } from '../encryption/types.js';
import type { LocalStorageManager } from '../storage/LocalStorageAdapter.js';
import type { StorageOptions } from '../storage/types.js';
import type { SyncConfig } from '../sync/types.js';

export interface SyncableStoreFactoryConfigWithEncryption<S extends Schema> {
  /** Schema definition */
  schema: S;

  /** LocalStorage manager (shared infrastructure) */
  storageManager: LocalStorageManager;

  /** Function to generate storage key from account address */
  storageKey: (account: `0x${string}`) => string;

  /** Storage options */
  storageOptions?: StorageOptions;

  /** Encryption provider factory - creates provider from private key */
  encryptionFactory: EncryptionProviderFactory;

  /** Default data factory */
  defaultData: () => DataOf<S>;

  /** Clock function for timestamps (default: Date.now) */
  clock?: () => number;

  /** Schema version for migrations */
  schemaVersion?: number;

  /** Optional: Sync configuration */
  sync?: SyncConfig<S>;

  /** Migration functions keyed by target version */
  migrations?: Record<number, (oldData: unknown) => InternalStorage<S>>;
}

export function createSyncableStoreFactoryWithEncryption<S extends Schema>(
  config: SyncableStoreFactoryConfigWithEncryption<S>,
): SyncableStoreFactoryWithEncryption<S> {
  return (accountOrSigner: AccountOrSigner) => {
    // Get the address (works for both Account and Signer)
    const address = getAddress(accountOrSigner);
    
    // Create encryption provider only for signers (who have privateKey)
    const encryption = accountOrSigner.type === 'signer'
      ? config.encryptionFactory(accountOrSigner.privateKey)
      : undefined;

    // Create adapter with encryption bound (or no encryption for account-only)
    const adapter = config.storageManager.createAdapter<InternalStorage<S>>({
      encryption,
    });

    return createSyncableStore({
      schema: config.schema,
      account: address,
      storage: {
        adapter,
        key: config.storageKey(address),
        options: config.storageOptions,
      },
      defaultData: config.defaultData,
      clock: config.clock,
      schemaVersion: config.schemaVersion,
      sync: config.sync,
      migrations: config.migrations,
    });
  };
}
```

### Updated MultiAccountStore

```typescript
// File: packages/synqable/src/multi-account/index.ts

import { getAddress } from './types.js';

export function createMultiAccountStoreWithEncryption<S extends Schema>(
  config: MultiAccountStoreConfigWithEncryption<S>,
): MultiAccountStore<S> {
  const { accountStore, factory } = config;

  let currentStore: SyncableStore<S> | null = null;
  let current: AccountOrSigner | undefined;
  let unsubscribe: (() => void) | undefined;

  const subscribers = new Set<(store: SyncableStore<S> | null) => void>();

  function notify(): void {
    for (const callback of subscribers) {
      callback(currentStore);
    }
  }

  function isSameAccountOrSigner(a?: AccountOrSigner, b?: AccountOrSigner): boolean {
    if (!a || !b) return a === b;
    if (a.type !== b.type) return false;
    if (getAddress(a) !== getAddress(b)) return false;
    if (a.type === 'signer' && b.type === 'signer') {
      return a.privateKey === b.privateKey;
    }
    return true;
  }

  function handleChange(accountOrSigner: AccountOrSigner | undefined): void {
    // Same account/signer - no-op
    if (isSameAccountOrSigner(accountOrSigner, current) && currentStore) {
      return;
    }

    // Stop and cleanup previous store
    currentStore?.stop();

    current = accountOrSigner;

    // No account - transition to null
    if (!accountOrSigner) {
      currentStore = null;
      notify();
      return;
    }

    // Create new store with account/signer
    // - Account: no encryption (fails if data was encrypted)
    // - Signer: with encryption
    let store = factory(accountOrSigner);
    currentStore = store;
    notify();
    store.load();
  }

  function start(): void {
    if (unsubscribe) return;
    unsubscribe = accountStore.subscribe(handleChange);
  }

  function stop(): void {
    unsubscribe?.();
    unsubscribe = undefined;
    currentStore?.stop();
    currentStore = null;
    current = undefined;
  }

  return {
    subscribe(callback: (store: SyncableStore<S> | null) => void): () => void {
      if (subscribers.size === 0) {
        start();
      }

      subscribers.add(callback);
      callback(currentStore);

      return () => {
        subscribers.delete(callback);
        if (subscribers.size === 0) {
          stop();
        }
      };
    },

    get(): SyncableStore<S> | null {
      return currentStore;
    },

    get currentAccount(): `0x${string}` | undefined {
      return current ? getAddress(current) : undefined;
    },
  };
}
```

---

## SyncAdapter with Encryption

### Updated Interface

```typescript
// File: packages/synqable/src/sync/types.ts

/**
 * Server sync adapter interface with optional encryption.
 */
export interface SyncAdapter<S extends Schema> {
  /**
   * Pull latest state from server.
   */
  pull(account: `0x${string}`): Promise<PullResponse<S>>;

  /**
   * Push local state to server.
   */
  push(account: `0x${string}`, data: InternalStorage<S>, counter: bigint): Promise<PushResponse>;

  /**
   * Subscribe to real-time updates (optional).
   */
  subscribe?(
    account: `0x${string}`,
    callback: (data: InternalStorage<S>, counter: bigint) => void,
  ): () => void;
}

/**
 * Sync adapter options with encryption support.
 */
export interface SyncAdapterOptions {
  /** Encryption provider for encrypting data before push and decrypting after pull */
  encryption?: EncryptionProvider;
}
```

### Example: Encrypted Sync Adapter Wrapper

```typescript
// File: packages/synqable/src/sync/withEncryption.ts

import type { SyncAdapter, PullResponse, PushResponse } from './types.js';
import type { EncryptionProvider } from '../encryption/types.js';
import type { Schema, InternalStorage } from '../main/types.js';

/**
 * Wrap a sync adapter with encryption.
 * Data is encrypted before push and decrypted after pull.
 */
export function withEncryption<S extends Schema>(
  adapter: SyncAdapter<S>,
  encryption: EncryptionProvider,
): SyncAdapter<S> {
  return {
    async pull(account): Promise<PullResponse<S>> {
      const response = await adapter.pull(account);
      
      if (!response.success || !response.data) {
        return response;
      }

      // Data from server is encrypted string stored in a wrapper
      const encryptedData = response.data as unknown as { encrypted: string };
      
      try {
        const decrypted = await encryption.decrypt(encryptedData.encrypted);
        const data = JSON.parse(decrypted) as InternalStorage<S>;
        return { ...response, data };
      } catch (error) {
        return { success: false, error: 'Decryption failed' };
      }
    },

    async push(account, data, counter): Promise<PushResponse> {
      // Encrypt data before pushing
      const serialized = JSON.stringify(data);
      const encrypted = await encryption.encrypt(serialized);
      
      // Send as encrypted wrapper
      const encryptedData = { encrypted } as unknown as InternalStorage<S>;
      return adapter.push(account, encryptedData, counter);
    },

    subscribe: adapter.subscribe
      ? (account, callback) => {
          return adapter.subscribe!(account, async (data, counter) => {
            // Decrypt incoming real-time data
            const encryptedData = data as unknown as { encrypted: string };
            try {
              const decrypted = await encryption.decrypt(encryptedData.encrypted);
              const decryptedData = JSON.parse(decrypted) as InternalStorage<S>;
              callback(decryptedData, counter);
            } catch {
              // Ignore decryption failures in real-time updates
            }
          });
        }
      : undefined,
  };
}
```

---

## Complete Usage Example

```typescript
import {
  createLocalStorageManager,
  createSyncableStoreFactoryWithEncryption,
  createMultiAccountStoreWithEncryption,
  createAesGcmProvider,
  defineSchema,
  permanent,
  map,
} from 'synqable';
import type { AccountOrSigner, AccountOrSignerStore } from 'synqable';

// 1. Define schema
const schema = defineSchema({
  settings: permanent<{ theme: string }>(),
  todos: map<{ title: string; done: boolean }>(),
});

// 2. Create shared localStorage manager
const storageManager = createLocalStorageManager();

// 3. Create factory with encryption support
const storeFactory = createSyncableStoreFactoryWithEncryption({
  schema,
  storageManager,
  storageKey: (account) => `myapp:${account}`,
  encryptionFactory: createAesGcmProvider,
  defaultData: () => ({
    settings: { theme: 'light' },
    todos: {},
  }),
});

// 4. Create account/signer store (from your wallet library)
// Example: writable store that can be Account or Signer
const accountStore: AccountOrSignerStore = createAccountStore(); // Your implementation

// Example values:
// Account-only (no encryption): { type: 'account', owner: '0x123...' }
// With signer (encryption):     { type: 'signer', owner: '0x123...', privateKey: '0xabc...' }

// 5. Create multi-account store
const multiStore = createMultiAccountStoreWithEncryption({
  accountStore,
  factory: storeFactory,
});

// Use in Svelte
// $: store = $multiStore;
// $: if (store?.state.status === 'ready') {
//   console.log(store.state.data.settings.theme);
// }
```

---

## File Structure

```
packages/synqable/src/
├── encryption/
│   ├── index.ts              # Re-exports
│   ├── types.ts              # EncryptionProvider, EncryptionProviderFactory
│   └── aes-gcm.ts            # AES-GCM implementation
├── storage/
│   ├── index.ts              # Re-exports
│   ├── types.ts              # AsyncStorage, WatchableStorage (unchanged)
│   └── LocalStorageAdapter.ts # Updated with manager + encryption
├── sync/
│   ├── index.ts              # Re-exports
│   ├── types.ts              # SyncAdapter (unchanged interface)
│   └── withEncryption.ts     # Encryption wrapper for SyncAdapter
├── multi-account/
│   ├── index.ts              # Updated with SignerStore support
│   └── types.ts              # Signer, SignerStore, etc.
├── factory/
│   ├── index.ts              # Updated factory with encryption
│   └── types.ts              # Updated config types
└── index.ts                  # Main exports
```

---

## Migration Path

### For Existing Users (No Encryption)

```typescript
// Before
const adapter = createLocalStorageAdapter();

// After (no changes needed - backward compatible)
const adapter = createLocalStorageAdapter();
```

### For New Users (With Encryption)

```typescript
// Create manager for shared infrastructure
const storageManager = createLocalStorageManager();

// Create encrypted adapter
const adapter = storageManager.createAdapter({
  encryption: createAesGcmProvider(privateKey),
});
```

---

## Implementation Tasks

1. [ ] Create `encryption/types.ts` - Define EncryptionProvider interface
2. [ ] Create `encryption/aes-gcm.ts` - AES-GCM implementation
3. [ ] Update `storage/LocalStorageAdapter.ts` - Add manager pattern and encryption support
4. [ ] Update `multi-account/types.ts` - Add Signer type and SignerStore
5. [ ] Update `multi-account/index.ts` - Add createMultiAccountStoreWithSigner
6. [ ] Update `factory/types.ts` - Add encryption factory config
7. [ ] Update `factory/index.ts` - Add createSyncableStoreFactoryWithEncryption
8. [ ] Create `sync/withEncryption.ts` - SyncAdapter encryption wrapper
9. [ ] Update `index.ts` - Export new APIs
10. [ ] Write tests for encryption provider
11. [ ] Write tests for encrypted storage adapter
12. [ ] Write tests for multi-account with signer
13. [ ] Update documentation

---

## Resolved Decisions

1. **Key rotation**: Not needed. Since `privateKey` is tied to `owner` address, changing wallets means a new `owner` and therefore a new store.

2. **Encryption mode switching**: Using discriminated union (`Account` vs `Signer`):
   - `Account` (no privateKey): Loads data unencrypted. **Fails** with `EncryptedDataError` if existing data was encrypted.
   - `Signer` (with privateKey): Always encrypts. Can only read encrypted data.
   - This prevents accidental key mixing and provides clear type-safe behavior.

3. **Version tagging**: Deferred for now. Can be added to `EncryptionProvider` interface later if needed for algorithm upgrades.

4. **Encryption detection**: Use `enc:` prefix marker on encrypted data.
   - When saving with encryption: prepend `enc:` to encrypted string
   - When loading: check for `enc:` prefix to determine if data is encrypted
   - This allows instant detection without attempting JSON parse

5. **Error handling**: Throw `EncryptedDataError` when:
   - `Account` mode tries to load data with `enc:` prefix
   - Message: "Cannot load encrypted data without encryption key. Connect with a signer to access this data."

6. **Naming conventions**:
   - `Account.address` - for account-only connections (just the address)
   - `Signer.owner` - for signer connections (they "own" and control the data)
   - `getAddress()` helper function to extract address from either type
