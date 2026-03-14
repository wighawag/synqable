/**
 * Multi-Account Store Implementation
 *
 * Manages multiple SyncableStore instances across account switches,
 * with race condition protection and lazy lifecycle management.
 */

import type {Schema, SyncableStore} from '../main/types.js';
import type {
	AccountStore,
	SyncableStoreFactory,
	MultiAccountStoreConfig,
	MultiAccountStore,
} from './types.js';

// Re-export types
export type {AccountStore, SyncableStoreFactory, MultiAccountStoreConfig, MultiAccountStore};

/**
 * Creates a multi-account store manager.
 *
 * @example
 * ```typescript
 * const multiStore = createMultiAccountStore({
 *   accountStore, // From your wallet connection library
 *   factory: createSyncableStoreFactory({ schema, storage, defaultData }),
 * });
 *
 * // Auto-starts when first subscriber subscribes
 * // Auto-stops when last subscriber unsubscribes
 * ```
 */
export function createMultiAccountStore<S extends Schema>(
	config: MultiAccountStoreConfig<S>,
): MultiAccountStore<S> {
	const {accountStore, factory} = config;

	// State
	let currentStore: SyncableStore<S> | null = null;
	let currentAccount: `0x${string}` | undefined;
	let unsubscribeAccount: (() => void) | undefined;

	// Subscribers
	const subscribers = new Set<(store: SyncableStore<S> | null) => void>();

	function notify(): void {
		for (const callback of subscribers) {
			callback(currentStore);
		}
	}

	function handleAccountChange(account: `0x${string}` | undefined): void {
		// Edge case #4: Account store emits same account - no-op
		if (account === currentAccount && currentStore) {
			return;
		}

		// Stop and cleanup previous store
		currentStore?.stop();

		currentAccount = account;

		// No account - transition to null
		if (!account) {
			currentStore = null;
			notify();
			return;
		}

		let store = factory(account);

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
		unsubscribeAccount = accountStore.subscribe(handleAccountChange);
	}

	function stop(): void {
		unsubscribeAccount?.();
		unsubscribeAccount = undefined;
		currentStore?.stop();
		currentStore = null;
		currentAccount = undefined;
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
			return currentAccount;
		},
	};
}
