/**
 * Multi-Account Store - Type Definitions
 *
 * Types for managing multiple SyncableStore instances across account switches.
 */

import type {Schema, SyncableStore, Readable, AsyncState, DataOf} from '../main/types.js';

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

	/**
	 * Reactive state derived from the current account's store.
	 * Emits idle state when no account is connected.
	 * Automatically manages nested subscriptions on account changes.
	 */
	readonly currentAccount: Readable<AsyncState<DataOf<S>>>;
}
