/**
 * Multi-Account Store Implementation
 *
 * Manages multiple SyncableStore instances across account switches,
 * with race condition protection and lazy lifecycle management.
 */

import type {Schema, SyncableStore, Readable} from '../main/types.js';
import type {
	Account,
	AccountWithSigner,
	AccountStore,
	AccountOrSignerStore,
	SyncableStoreFactory,
	MultiAccountStoreConfig,
	MultiAccountStore,
} from './types.js';
import {getAddress, getPrivateKey} from './types.js';

// Re-export types
export type {
	Account,
	AccountWithSigner,
	AccountStore,
	AccountOrSignerStore,
	SyncableStoreFactory,
	MultiAccountStoreConfig,
	MultiAccountStore,
};
export {getAddress, getPrivateKey};

/**
 * Helper to compare Account or AccountWithSigner values.
 * Returns true if they represent the same account with the same privateKey.
 */
function isSameAccountOrSigner(
	a: Account | AccountWithSigner | undefined,
	b: Account | AccountWithSigner | undefined,
): boolean {
	if (!a || !b) return a === b;

	const addrA = getAddress(a);
	const addrB = getAddress(b);
	if (addrA !== addrB) return false;

	const keyA = getPrivateKey(a);
	const keyB = getPrivateKey(b);
	return keyA === keyB;
}

/**
 * Creates a multi-account store manager.
 *
 * @example With plain account (no encryption)
 * ```typescript
 * const accountStore: Readable<`0x${string}` | undefined> = // from wallet
 *
 * const multiStore = createMultiAccountStore({
 *   accountStore,
 *   factory: createSyncableStoreFactory({ schema, storage, defaultData }),
 * });
 * ```
 *
 * @example With signer account (enables encryption)
 * ```typescript
 * const accountStore: Readable<AccountWithSigner | undefined> = // from wallet with signer
 *
 * const multiStore = createMultiAccountStore({
 *   accountStore,
 *   factory: createSyncableStoreFactory({ schema, storage, defaultData }),
 * });
 *
 * // When accountStore emits { owner: '0x...', privateKey: '0x...' },
 * // the factory receives both account and privateKey for encryption
 * ```
 */
export function createMultiAccountStore<S extends Schema>(
	config: MultiAccountStoreConfig<S>,
): MultiAccountStore<S> {
	const {accountStore, factory} = config;

	// State - current tracks both Account and AccountWithSigner
	let currentStore: SyncableStore<S> | null = null;
	let current: Account | AccountWithSigner | undefined;
	let unsubscribeAccount: (() => void) | undefined;

	// Subscribers
	const subscribers = new Set<(store: SyncableStore<S> | null) => void>();

	function notify(): void {
		for (const callback of subscribers) {
			callback(currentStore);
		}
	}

	function handleAccountChange(value: Account | AccountWithSigner | undefined): void {
		// Same value - no change needed
		if (isSameAccountOrSigner(value, current) && currentStore) {
			return;
		}

		// Stop and cleanup previous store
		currentStore?.stop();

		current = value;

		// No account - transition to null
		if (!value) {
			currentStore = null;
			notify();
			return;
		}

		// Extract address and privateKey from either type
		const account = getAddress(value);
		const privateKey = getPrivateKey(value);

		// Create store with account + optional privateKey
		let store = factory(account, privateKey);

		// Set the new store immediately - subscribers see it in loading state
		currentStore = store;
		notify();
		// load it
		store.load();
	}

	function start(): void {
		if (unsubscribeAccount) {
			return; // Already started
		}
		// Subscribe handles both store types - emitted values are discriminated by type
		unsubscribeAccount = (
			accountStore as Readable<Account | AccountWithSigner | undefined>
		).subscribe(handleAccountChange);
	}

	function stop(): void {
		unsubscribeAccount?.();
		unsubscribeAccount = undefined;
		currentStore?.stop();
		currentStore = null;
		current = undefined;
	}

	return {
		subscribe(callback: (store: SyncableStore<S> | null) => void): () => void {
			// First subscriber - start listening to account changes
			if (subscribers.size === 0) {
				start();
			}

			subscribers.add(callback);
			callback(currentStore); // Svelte store contract: call immediately

			// Return unsubscribe function
			return () => {
				subscribers.delete(callback);

				// Last subscriber left - stop and cleanup
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
