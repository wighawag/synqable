# Phase 2: Shared LocalStorage Adapter Factory

## Goal

Create a `createLocalStorageAdapterFactory()` that returns a `StorageAdapterFactory` where all created adapters share the same global storage event listener.

## Current State

```typescript
// Current: creates standalone adapter with its own listener
export function createLocalStorageAdapter<T>(
  options?: LocalStorageAdapterOptions<T>,
): WatchableStorage<T>;
```

Each call creates a new adapter with its own `watchers` map and potentially its own global listener.

---

## Proposed Design

### Factory Function

```typescript
// File: packages/synqable/src/storage/LocalStorageAdapter.ts

export interface LocalStorageAdapterFactoryOptions {
  /** Optional serializer, defaults to JSON.stringify */
  serialize?: (data: unknown) => string;
  /** Optional deserializer, defaults to JSON.parse */
  deserialize?: (data: string) => unknown;
}

/**
 * Creates a localStorage adapter factory with shared global listener.
 * All adapters created by this factory share the same storage event listener.
 * 
 * @param options - Serialization options (shared by all adapters)
 * @returns StorageAdapterFactory that can be passed to StorageConfig
 */
export function createLocalStorageAdapterFactory<T>(
  options?: LocalStorageAdapterFactoryOptions,
): StorageAdapterFactory<T>;
```

### Usage

```typescript
import { createLocalStorageAdapterFactory } from 'synqable';

// Create factory (shared infrastructure)
const localStorageFactory = createLocalStorageAdapterFactory();

// Use in store config
createSyncableStore({
  storage: {
    adapterFactory: localStorageFactory,
    key: 'myapp:user',
  },
  privateKey: '0x...',  // Optional: passed to factory for encryption
  // ...
});
```

---

## Implementation

```typescript
// File: packages/synqable/src/storage/LocalStorageAdapter.ts

import type { StorageAdapterFactory, WatchableStorage, StorageChangeCallback } from './types.js';

export interface LocalStorageAdapterFactoryOptions {
  serialize?: (data: unknown) => string;
  deserialize?: (data: string) => unknown;
}

// Encryption prefix marker
const ENCRYPTED_PREFIX = 'enc:';

export function createLocalStorageAdapterFactory<T>(
  options?: LocalStorageAdapterFactoryOptions,
): StorageAdapterFactory<T> {
  const serialize = options?.serialize ?? JSON.stringify;
  const deserialize = (options?.deserialize ?? JSON.parse) as (data: string) => T;

  // Shared state across all adapters
  const watchers = new Map<string, Set<{
    callback: StorageChangeCallback<T>;
    decrypt?: (data: string) => Promise<string>;
  }>>();
  let globalListener: ((e: StorageEvent) => void) | null = null;

  function ensureGlobalListener() {
    if (globalListener) return;

    globalListener = async (e: StorageEvent) => {
      if (!e.key || e.newValue === null) return;

      const callbacks = watchers.get(e.key);
      if (!callbacks || callbacks.size === 0) return;

      for (const { callback, decrypt } of callbacks) {
        try {
          let rawValue = e.newValue;
          
          // Check for encryption prefix
          if (rawValue.startsWith(ENCRYPTED_PREFIX)) {
            if (decrypt) {
              rawValue = await decrypt(rawValue.slice(ENCRYPTED_PREFIX.length));
            } else {
              // No decryption available, skip this callback
              continue;
            }
          }
          
          const newValue = deserialize(rawValue);
          callback(e.key!, newValue);
        } catch {
          callback(e.key!, undefined);
        }
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

  // Return the factory function
  return (privateKey?: `0x${string}`): WatchableStorage<T> => {
    // Create encryption functions if privateKey provided
    let encrypt: ((data: string) => Promise<string>) | undefined;
    let decrypt: ((data: string) => Promise<string>) | undefined;

    if (privateKey) {
      // Derive encryption key (simplified - actual impl would use WebCrypto)
      const encryptionKey = privateKey;
      
      encrypt = async (data: string): Promise<string> => {
        // TODO: Actual encryption implementation
        // For now, placeholder that would use AES-GCM
        return `encrypted(${data})`;
      };
      
      decrypt = async (data: string): Promise<string> => {
        // TODO: Actual decryption implementation
        return data.replace('encrypted(', '').replace(')', '');
      };
    }

    return {
      async load(key: string): Promise<T | undefined> {
        try {
          let stored = localStorage.getItem(key);
          if (!stored) return undefined;

          // Check for encryption prefix
          const isEncrypted = stored.startsWith(ENCRYPTED_PREFIX);
          
          if (isEncrypted) {
            if (!decrypt) {
              throw new Error('Data is encrypted but no privateKey provided');
            }
            stored = await decrypt(stored.slice(ENCRYPTED_PREFIX.length));
          } else if (privateKey) {
            // Has encryption key but data is not encrypted
            // This is fine - just read plain data
          }

          return deserialize(stored);
        } catch {
          return undefined;
        }
      },

      async save(key: string, data: T): Promise<void> {
        let serialized = serialize(data);
        
        if (encrypt) {
          serialized = ENCRYPTED_PREFIX + await encrypt(serialized);
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

        if (!watchers.has(key)) {
          watchers.set(key, new Set());
        }

        const entry = { callback, decrypt };
        watchers.get(key)!.add(entry);

        return () => {
          const callbacks = watchers.get(key);
          if (callbacks) {
            callbacks.delete(entry);
            if (callbacks.size === 0) {
              watchers.delete(key);
            }
          }
          cleanupGlobalListener();
        };
      },
    };
  };
}
```

---

## Key Points

1. **Shared State**: `watchers` map and `globalListener` are created once per factory, shared by all adapters

2. **Encryption Handling**:
   - Each adapter instance gets its own `encrypt`/`decrypt` functions based on privateKey
   - `enc:` prefix marks encrypted data
   - Unencrypted adapter can still read plain data
   - Encrypted adapter can read both (decrypts if prefix present)

3. **Backward Compatibility**: Keep existing `createLocalStorageAdapter()` for simple cases

---

## Detailed File Changes

### 1. `storage/types.ts`

Already has `StorageAdapterFactory<T>` from Phase 1. No changes needed.

### 2. `storage/LocalStorageAdapter.ts`

**Structure of changes:**

```typescript
// KEEP existing code at top:
import type {WatchableStorage, StorageChangeCallback} from './types.js';

export interface LocalStorageAdapterOptions<T> { ... }  // KEEP

export function createLocalStorageAdapter<T>(...): WatchableStorage<T> {
  // KEEP entire existing function unchanged
}

// ADD: New import at top
import type { StorageAdapterFactory } from './types.js';

// ADD: New interface after existing interface
export interface LocalStorageAdapterFactoryOptions {
  serialize?: (data: unknown) => string;
  deserialize?: (data: string) => unknown;
}

// ADD: Encryption prefix constant
const ENCRYPTED_PREFIX = 'enc:';

// ADD: New factory function (copy the Implementation section above)
export function createLocalStorageAdapterFactory<T>(
  options?: LocalStorageAdapterFactoryOptions,
): StorageAdapterFactory<T> {
  // ... full implementation as shown above
}
```

### 3. `storage/index.ts`

```typescript
// CURRENT content (approximately):
export type {
  AsyncStorage,
  WatchableStorage,
  StorageChangeCallback,
  StorageOptions,
  StorageConfig,
} from './types.js';

export {createLocalStorageAdapter} from './LocalStorageAdapter.js';
export {isWatchable} from './types.js';

// CHANGE TO:
export type {
  AsyncStorage,
  WatchableStorage,
  StorageChangeCallback,
  StorageOptions,
  StorageConfig,
  StorageAdapterFactory,  // ADD THIS
} from './types.js';

export {
  createLocalStorageAdapter,
  createLocalStorageAdapterFactory,  // ADD THIS
} from './LocalStorageAdapter.js';

export {isWatchable} from './types.js';
```

---

## Testing Strategy

### Test File Location
Create new test file: `packages/synqable/test/localStorage-factory.test.ts`

### Test Cases

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLocalStorageAdapterFactory } from '../src/storage/LocalStorageAdapter.js';

describe('createLocalStorageAdapterFactory', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('basic operations', () => {
    it('should save and load data', async () => {
      const factory = createLocalStorageAdapterFactory();
      const adapter = factory();

      await adapter.save('test-key', { foo: 'bar' });
      const result = await adapter.load('test-key');

      expect(result).toEqual({ foo: 'bar' });
    });

    it('should return undefined for missing key', async () => {
      const factory = createLocalStorageAdapterFactory();
      const adapter = factory();

      const result = await adapter.load('nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('shared listener', () => {
    it('multiple adapters from same factory share state', async () => {
      const factory = createLocalStorageAdapterFactory();
      const adapter1 = factory();
      const adapter2 = factory();

      await adapter1.save('shared', { from: 'adapter1' });
      
      // adapter2 can read what adapter1 wrote
      const result = await adapter2.load('shared');
      expect(result).toEqual({ from: 'adapter1' });
    });
  });

  describe('encryption prefix', () => {
    it('should add enc: prefix when privateKey provided', async () => {
      const factory = createLocalStorageAdapterFactory();
      const adapter = factory('0x1234567890abcdef');

      await adapter.save('encrypted-key', { secret: 'data' });

      const raw = localStorage.getItem('encrypted-key');
      expect(raw?.startsWith('enc:')).toBe(true);
    });

    it('should NOT add prefix without privateKey', async () => {
      const factory = createLocalStorageAdapterFactory();
      const adapter = factory(); // no privateKey

      await adapter.save('plain-key', { plain: 'data' });

      const raw = localStorage.getItem('plain-key');
      expect(raw?.startsWith('enc:')).toBe(false);
      expect(JSON.parse(raw!)).toEqual({ plain: 'data' });
    });

    it('should fail to load encrypted data without privateKey', async () => {
      const factory = createLocalStorageAdapterFactory();
      
      // Save with encryption
      const encryptedAdapter = factory('0x1234567890abcdef');
      await encryptedAdapter.save('secret', { data: 'hidden' });

      // Try to load without encryption
      const plainAdapter = factory();
      const result = await plainAdapter.load('secret');
      
      // Should return undefined (load fails gracefully)
      expect(result).toBeUndefined();
    });
  });
});
```

---

## Implementation Order

1. **Complete Phase 1 first** - The factory pattern for configs
2. **Then implement Phase 2:**
   1. Add `StorageAdapterFactory` import to `LocalStorageAdapter.ts`
   2. Add `ENCRYPTED_PREFIX` constant
   3. Add `LocalStorageAdapterFactoryOptions` interface
   4. Add `createLocalStorageAdapterFactory()` function
   5. Update `storage/index.ts` exports
   6. Write tests
   7. Run `pnpm test` and `pnpm test:typecheck`

---

## Implementation Tasks

- [ ] Add import for `StorageAdapterFactory` to `LocalStorageAdapter.ts`
- [ ] Add `ENCRYPTED_PREFIX` constant
- [ ] Add `LocalStorageAdapterFactoryOptions` interface
- [ ] Implement `createLocalStorageAdapterFactory()`:
  - [ ] Shared `watchers` Map in closure
  - [ ] Shared `globalListener` in closure
  - [ ] `ensureGlobalListener()` helper
  - [ ] `cleanupGlobalListener()` helper
  - [ ] Factory function returning adapter with encrypt/decrypt
- [ ] Implement `load()` with prefix detection
- [ ] Implement `save()` with prefix addition
- [ ] Implement `watch()` using shared infrastructure
- [ ] Update `storage/index.ts` exports
- [ ] Create test file `test/localStorage-factory.test.ts`
- [ ] Run `pnpm test`
- [ ] Run `pnpm test:typecheck`

---

## Notes

- The encrypt/decrypt functions are PLACEHOLDERS
- Actual WebCrypto implementation will be Phase 3
- The existing `createLocalStorageAdapter()` stays unchanged for backward compatibility
- Key insight: shared state lives in the closure of the factory creator, not the factory itself
