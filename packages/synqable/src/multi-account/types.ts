/**
 * Multi-Account Store - Type Definitions
 *
 * Types for managing multiple SyncableStore instances across account switches.
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

// ============================================================================
// Account Types for Encryption Support
// ============================================================================

/**
 * Plain account - just an address, no encryption capability.
 * This is equivalent to the existing `0x${string}` pattern used in AccountStore.
 */
export type Account = `0x${string}`;

/**
 * Account with signer - address + privateKey, enables encryption and signing.
 */
export interface AccountWithSigner {
	owner: `0x${string}`;
	privateKey: `0x${string}`;
}

/**
 * Helper to extract address from either type.
 */
export function getAddress(value: Account | AccountWithSigner): `0x${string}` {
	return typeof value === 'string' ? value : value.owner;
}

/**
 * Helper to extract privateKey (undefined for plain account).
 */
export function getPrivateKey(value: Account | AccountWithSigner): `0x${string}` | undefined {
	return typeof value === 'string' ? undefined : value.privateKey;
}

/**
 * Store types - union of either store type.
 * Config can accept either a plain account store or an account-with-signer store.
 */
export type AccountOrSignerStore =
	| Readable<Account | undefined>
	| Readable<AccountWithSigner | undefined>;

/**
 * Account store - a readable store of Ethereum addresses.
 * Value is undefined when no account is connected.
 */
export type AccountStore = Readable<`0x${string}` | undefined>;

/**
 * Factory function that creates a SyncableStore for a given account.
 * Now accepts optional privateKey for encryption.
 */
export type SyncableStoreFactory<S extends Schema> = (
	account: `0x${string}`,
	privateKey?: `0x${string}`,
) => SyncableStore<S>;

/**
 * Configuration for creating a multi-account store manager.
 */
export interface MultiAccountStoreConfig<S extends Schema> {
	/**
	 * Schema definition - required for correct default values on map fields.
	 */
	schema: S;

	/**
	 * Account store - can be either:
	 * - Readable<Account | undefined> (plain address, no encryption)
	 * - Readable<AccountWithSigner | undefined> (address + privateKey, with encryption)
	 */
	accountStore: AccountOrSignerStore;

	/** Factory function to create stores for accounts */
	factory: SyncableStoreFactory<S>;
}

/**
 * Multi-account store manager that wraps single-account SyncableStores.
 *
 * Follows Svelte store contract with lazy initialization:
 * - First subscriber triggers account store subscription
 * - Last subscriber leaving triggers cleanup
 */
export interface MultiAccountStore<S extends Schema> {
	/**
	 * Svelte store contract - subscribe to current store changes.
	 * Value is null when no account connected or during transition.
	 *
	 * Lifecycle:
	 * - First subscriber: starts listening to account changes
	 * - Last subscriber leaves: stops listening, cleans up current store
	 */
	subscribe(callback: (store: SyncableStore<S> | null) => void): () => void;

	/**
	 * Synchronous access to current store.
	 * Returns null when no account connected or no subscribers.
	 *
	 * IMPORTANT: Captured reference remains valid even after account switch.
	 * This is intentional for async operation safety.
	 */
	get(): SyncableStore<S> | null;

	// ============ Renamed ============

	/**
	 * Reactive lifecycle state derived from current store.
	 * Returns idle state when no account connected.
	 * RENAMED from accountState for consistency with SyncableStore.state$
	 */
	readonly state$: Readable<StoreLifecycleState>;

	// ============ New Status Readables ============

	/**
	 * Reactive sync status derived from current store.
	 * Returns idle status when no account connected.
	 */
	readonly syncStatus$: Readable<SyncStatus>;

	/**
	 * Reactive storage status derived from current store.
	 * Returns idle status when no account connected.
	 */
	readonly storageStatus$: Readable<StorageStatus>;

	// ============ New Watch Methods ============

	/**
	 * Watch a field reactively across account switches.
	 * - For permanent fields: Returns undefined when no account is connected or store is loading.
	 * - For map fields: Returns empty {} when no account is connected, never undefined.
	 */
	watchField<K extends keyof S>(
		field: K,
	): S[K] extends MapField<unknown> ? Readable<DataOf<S>[K]> : Readable<DataOf<S>[K] | undefined>;

	/**
	 * Watch a specific map item reactively across account switches.
	 * Returns undefined when no account is connected or item doesn't exist.
	 */
	watchItem<K extends MapKeys<S>>(
		field: K,
		key: string,
	): Readable<(ExtractMapItem<S[K]> & {deleteAt: number}) | undefined>;

	/**
	 * Watch map field IDs reactively across account switches.
	 * Returns empty array when no account is connected.
	 */
	watchItemIds<K extends MapKeys<S>>(field: K): Readable<string[]>;
}
