/**
 * Multi-Account Store Implementation
 *
 * Manages multiple SyncableStore instances across account switches,
 * with race condition protection and lazy lifecycle management.
 */

import type {Schema, SyncableStore, Readable, AsyncState, DataOf} from '../main/types.js';
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

	// Subscribers for store changes
	const subscribers = new Set<(store: SyncableStore<S> | null) => void>();

	// State for currentAccount reactive store
	const stateSubscribers = new Set<(state: AsyncState<DataOf<S>>) => void>();
	let currentStoreStateUnsub: (() => void) | undefined;
	let latestState: AsyncState<DataOf<S>> = {
		status: 'idle',
		account: undefined,
		isLoading: false,
		loadError: null,
	};

	function notify(): void {
		for (const callback of subscribers) {
			callback(currentStore);
		}
	}

	function notifyState(): void {
		for (const callback of stateSubscribers) {
			callback(latestState);
		}
	}

	function handleAccountChange(value: Account | AccountWithSigner | undefined): void {
		// Same value - no change needed
		if (isSameAccountOrSigner(value, current) && currentStore) {
			return;
		}

		// Cleanup previous store's state subscription
		currentStoreStateUnsub?.();
		currentStoreStateUnsub = undefined;

		// Stop and cleanup previous store
		currentStore?.stop();

		current = value;

		// No account - transition to null/idle
		if (!value) {
			currentStore = null;
			latestState = {
				status: 'idle',
				account: undefined,
				isLoading: false,
				loadError: null,
			};
			notify();
			notifyState();
			return;
		}

		// Extract address and privateKey from either type
		const account = getAddress(value);
		const privateKey = getPrivateKey(value);

		// Create store with account + optional privateKey
		let store = factory(account, privateKey);

		// Set the new store immediately - subscribers see it in loading state
		currentStore = store;

		// Subscribe to store state if we have state subscribers
		if (stateSubscribers.size > 0) {
			currentStoreStateUnsub = store.subscribe((state) => {
				latestState = state;
				notifyState();
			});
		}

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
		currentStoreStateUnsub?.();
		currentStoreStateUnsub = undefined;
		currentStore?.stop();
		currentStore = null;
		current = undefined;
		latestState = {
			status: 'idle',
			account: undefined,
			isLoading: false,
			loadError: null,
		};
	}

	// Create the currentAccount reactive store
	const currentAccount: Readable<AsyncState<DataOf<S>>> = {
		subscribe(callback: (state: AsyncState<DataOf<S>>) => void): () => void {
			// Start lifecycle if this is the first subscriber overall
			const needsStart = subscribers.size === 0 && stateSubscribers.size === 0;
			if (needsStart) {
				start();
			}

			// If we have a current store but no state subscription yet, subscribe now
			if (currentStore && !currentStoreStateUnsub) {
				currentStoreStateUnsub = currentStore.subscribe((state) => {
					latestState = state;
					notifyState();
				});
			}

			stateSubscribers.add(callback);
			callback(latestState); // Svelte store contract: call immediately

			return () => {
				stateSubscribers.delete(callback);

				// Last subscriber overall - stop and cleanup
				if (subscribers.size === 0 && stateSubscribers.size === 0) {
					stop();
				} else if (stateSubscribers.size === 0) {
					// No more state subscribers, but still store subscribers
					// Cleanup the store state subscription
					currentStoreStateUnsub?.();
					currentStoreStateUnsub = undefined;
				}
			};
		},
	};

	return {
		subscribe(callback: (store: SyncableStore<S> | null) => void): () => void {
			// Start lifecycle if this is the first subscriber overall
			const needsStart = subscribers.size === 0 && stateSubscribers.size === 0;
			if (needsStart) {
				start();
			}

			subscribers.add(callback);
			callback(currentStore); // Svelte store contract: call immediately

			// Return unsubscribe function
			return () => {
				subscribers.delete(callback);

				// Last subscriber overall - stop and cleanup
				if (subscribers.size === 0 && stateSubscribers.size === 0) {
					stop();
				}
			};
		},

		get(): SyncableStore<S> | null {
			return currentStore;
		},

		currentAccount,
	};
}
