/**
 * Multi-Account Store - Type Definitions
 *
 * Types for managing multiple SyncableStore instances across account switches.
 */

import type {Schema, SyncableStore, Readable} from '../main/types.js';

/**
 * Account store - a readable store of Ethereum addresses.
 * Value is undefined when no account is connected.
 */
export type AccountStore = Readable<`0x${string}` | undefined>;

/**
 * Factory function that creates a SyncableStore for a given account.
 */
export type SyncableStoreFactory<S extends Schema> = (account: `0x${string}`) => SyncableStore<S>;

/**
 * Configuration for creating a multi-account store manager.
 */
export interface MultiAccountStoreConfig<S extends Schema> {
	/** Account store to subscribe to */
	accountStore: AccountStore;

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
	 * Get the current account address - if any.
	 */
	readonly currentAccount: `0x${string}` | undefined;
}
