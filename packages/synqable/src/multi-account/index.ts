/**
 * Multi-Account Store Implementation
 *
 * Manages multiple SyncableStore instances across account switches,
 * with race condition protection and lazy lifecycle management.
 */

import type {Schema, SyncableStore} from '../main/types.js';
import type {AccountStore, SyncableStoreFactory, MultiAccountStoreConfig, MultiAccountStore} from './types.js';

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
	let pendingAccount: `0x${string}` | undefined;
	let unsubscribeAccount: (() => void) | undefined;

	// Subscribers
	const subscribers = new Set<(store: SyncableStore<S> | null) => void>();

	function notify(): void {
		for (const callback of subscribers) {
			callback(currentStore);
		}
	}

	async function handleAccountChange(account: `0x${string}` | undefined): Promise<void> {
		// Edge case #4: Account store emits same account - no-op
		if (account === currentAccount && currentStore) {
			return;
		}

		// Track which account we are switching to
		pendingAccount = account;
		currentAccount = account;

		// Stop and cleanup previous store
		if (currentStore) {
			currentStore.stop();
			currentStore = null;
			notify(); // Notify immediately that store is null/transitioning
		}

		// No account - stay null
		if (!account) {
			return;
		}

		// Edge case #5: Factory throws
		let store: SyncableStore<S>;
		try {
			store = factory(account);
		} catch (error) {
			console.error('Failed to create store for account:', error);
			// The store remains null - components will see the disconnect state
			return;
		}

		try {
			// Load the store - async
			await store.load();

			// Edge case #2: All subscribers leave during load
			if (subscribers.size === 0) {
				store.stop();
				return;
			}

			// Race condition guard: only set if still the intended account
			if (pendingAccount === account) {
				currentStore = store;
				notify();
			} else {
				// Account changed during load - cleanup orphan store
				store.stop();
			}
		} catch (error) {
			// Load failed - cleanup
			store.stop();

			// Only log if still the intended account
			if (pendingAccount === account) {
				console.error('Failed to load account data:', error);
				// The store remains null - components will see the disconnect state
			}
		}
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
		pendingAccount = undefined;
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
