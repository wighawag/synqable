/**
 * Multi-Account Store Implementation
 *
 * Manages multiple SyncableStore instances across account switches,
 * with race condition protection and lazy lifecycle management.
 */

import type {
	Schema,
	SyncableStore,
	Readable,
	StoreLifecycleState,
	StorageStatus,
	DataOf,
	MapKeys,
	MapField,
	ExtractMapItem,
} from '../main/types.js';
import type {SyncStatus} from '../sync/types.js';
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

// ============================================================================
// Default Status Values
// ============================================================================

const idleLifecycleState: StoreLifecycleState = {
	status: 'idle',
	account: undefined,
	isLoading: false,
	loadError: null,
};

const idleSyncStatus: SyncStatus = {
	isSyncing: false,
	isOnline: true,
	hasPendingSync: false,
	lastSyncedAt: null,
	syncError: null,
	get displayState() {
		return 'idle' as const;
	},
};

const idleStorageStatus: StorageStatus = {
	isSaving: false,
	lastSavedAt: null,
	storageError: null,
	get displayState() {
		return 'idle' as const;
	},
};

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

	// Track all derived readables for account change notifications
	interface DerivedReadableInfo {
		setupOnStore(store: SyncableStore<S> | null): void;
		subscribers: Set<(value: unknown) => void>;
		cleanup(): void;
	}
	const derivedReadables = new Set<DerivedReadableInfo>();

	function notify(): void {
		for (const callback of subscribers) {
			callback(currentStore);
		}
	}

	function hasAnySubscribers(): boolean {
		if (subscribers.size > 0) return true;
		for (const derived of derivedReadables) {
			if (derived.subscribers.size > 0) return true;
		}
		return false;
	}

	/**
	 * Creates a derived readable that delegates to the current store's readable.
	 * Automatically re-subscribes when account changes.
	 */
	function createDerivedReadable<T>(
		getStoreReadable: (store: SyncableStore<S>) => Readable<T>,
		defaultValue: T,
	): Readable<T> {
		const derivedSubscribers = new Set<(value: T) => void>();
		let currentDerivedUnsub: (() => void) | undefined;
		let latestDerivedValue: T = defaultValue;

		function notifyDerivedSubscribers(): void {
			for (const callback of derivedSubscribers) {
				callback(latestDerivedValue);
			}
		}

		// Track this derived readable for account change notifications
		const derivedInfo: DerivedReadableInfo = {
			setupOnStore(store: SyncableStore<S> | null): void {
				// Cleanup previous subscription
				currentDerivedUnsub?.();
				currentDerivedUnsub = undefined;

				if (!store) {
					if (latestDerivedValue !== defaultValue) {
						latestDerivedValue = defaultValue;
						notifyDerivedSubscribers();
					}
					return;
				}

				// Subscribe to the store's readable
				const storeReadable = getStoreReadable(store);
				currentDerivedUnsub = storeReadable.subscribe((value) => {
					latestDerivedValue = value;
					notifyDerivedSubscribers();
				});
			},
			subscribers: derivedSubscribers as Set<(value: unknown) => void>,
			cleanup(): void {
				currentDerivedUnsub?.();
				currentDerivedUnsub = undefined;
			},
		};

		return {
			subscribe(callback: (value: T) => void): () => void {
				// Start lifecycle if this is the first subscriber overall
				if (!hasAnySubscribers()) {
					start();
				}

				// Setup on current store if this is first subscriber for this derived
				if (derivedSubscribers.size === 0) {
					// Register for account change notifications (lazy registration)
					derivedReadables.add(derivedInfo);
					derivedInfo.setupOnStore(currentStore);
				}

				derivedSubscribers.add(callback);
				callback(latestDerivedValue); // Svelte store contract

				return () => {
					derivedSubscribers.delete(callback);

					// Cleanup if no more subscribers for this derived
					if (derivedSubscribers.size === 0) {
						derivedInfo.cleanup();
						// Remove from set to prevent memory leak
						derivedReadables.delete(derivedInfo);
					}

					// Stop lifecycle if no subscribers overall
					if (!hasAnySubscribers()) {
						stop();
					}
				};
			},
		};
	}

	function handleAccountChange(value: Account | AccountWithSigner | undefined): void {
		// Same value - no change needed
		if (isSameAccountOrSigner(value, current) && currentStore) {
			return;
		}

		// Stop and cleanup previous store
		currentStore?.stop();

		current = value;

		// No account - transition to null/idle
		if (!value) {
			currentStore = null;

			// Notify all active derived readables about the new store (null)
			for (const derived of derivedReadables) {
				if (derived.subscribers.size > 0) {
					derived.setupOnStore(null);
				}
			}

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

		// Notify all active derived readables about the new store
		for (const derived of derivedReadables) {
			if (derived.subscribers.size > 0) {
				derived.setupOnStore(store);
			}
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

		// Cleanup all derived readables
		for (const derived of derivedReadables) {
			derived.cleanup();
		}

		currentStore?.stop();
		currentStore = null;
		current = undefined;
	}

	// Create the state$ reactive store (renamed from accountState)
	const state$ = createDerivedReadable<StoreLifecycleState>(
		(store) => store.state$,
		idleLifecycleState,
	);

	// Create syncStatus$ reactive store
	const syncStatus$ = createDerivedReadable<SyncStatus>(
		(store) => store.syncStatus$,
		idleSyncStatus,
	);

	// Create storageStatus$ reactive store
	const storageStatus$ = createDerivedReadable<StorageStatus>(
		(store) => store.storageStatus$,
		idleStorageStatus,
	);

	// Watch methods
	function watchField<K extends keyof S>(field: K): Readable<DataOf<S>[K] | undefined> {
		return createDerivedReadable<DataOf<S>[K] | undefined>(
			(store) => store.watchField(field),
			undefined,
		);
	}

	function watchItem<K extends MapKeys<S>>(
		field: K,
		key: string,
	): Readable<(ExtractMapItem<S[K]> & {deleteAt: number}) | undefined> {
		return createDerivedReadable((store) => store.watchItem(field, key), undefined);
	}

	function watchItemIds<K extends MapKeys<S>>(field: K): Readable<string[]> {
		return createDerivedReadable((store) => store.watchItemIds(field), []);
	}

	return {
		subscribe(callback: (store: SyncableStore<S> | null) => void): () => void {
			// Start lifecycle if this is the first subscriber overall
			if (!hasAnySubscribers()) {
				start();
			}

			subscribers.add(callback);
			callback(currentStore); // Svelte store contract: call immediately

			// Return unsubscribe function
			return () => {
				subscribers.delete(callback);

				// Last subscriber overall - stop and cleanup
				if (!hasAnySubscribers()) {
					stop();
				}
			};
		},

		get(): SyncableStore<S> | null {
			return currentStore;
		},

		// Renamed from accountState
		state$,

		// New status readables
		syncStatus$,
		storageStatus$,

		// New watch methods
		watchField,
		watchItem,
		watchItemIds,
	};
}
