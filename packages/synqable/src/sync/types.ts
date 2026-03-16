/**
 * Syncable Store - Server Sync Type Definitions
 *
 * Types related to server synchronization.
 */

import type {Schema, InternalStorage, StoreEvents as BaseStoreEvents} from '../main/types.js';

// ============================================================================
// Sync Status and Events
// ============================================================================

/**
 * Sync status - server synchronization state.
 */
export interface SyncStatus {
	/** True when a sync operation is currently in progress */
	readonly isSyncing: boolean;

	/** True when network is available */
	readonly isOnline: boolean;

	/** True if there are changes pending sync to server */
	readonly hasPendingSync: boolean;

	/** Last successful sync timestamp */
	readonly lastSyncedAt: number | null;

	/** Last sync error, null if healthy */
	readonly syncError: Error | null;

	/** Display state for simple UI: syncing > offline > error > idle */
	readonly displayState: 'syncing' | 'offline' | 'error' | 'idle';
}

/**
 * Sync lifecycle events - point-in-time notifications.
 */
export type SyncEvent =
	| {type: 'pending'}
	| {type: 'started'}
	| {type: 'completed'; timestamp: number}
	| {type: 'failed'; error: Error}
	| {type: 'offline'}
	| {type: 'online'};

// ============================================================================
// Store Events with Sync
// ============================================================================

/**
 * Complete event map for a store with sync enabled.
 */
export type StoreEventsWithSync<S extends Schema> = BaseStoreEvents<S> & {
	'$store:sync': SyncEvent;
};

// ============================================================================
// Server Sync Types
// ============================================================================

/**
 * Successful pull response.
 */
export interface PullResponseSuccess<S extends Schema> {
	/** Indicates successful pull */
	success: true;

	/** Server data, or null if no data exists */
	data: InternalStorage<S> | null;

	/** Server's current counter for optimistic locking */
	counter: bigint;
}

/**
 * Failed pull response.
 */
export interface PullResponseError {
	/** Indicates failed pull */
	success: false;

	/** Error message describing the failure */
	error: string;
}

/**
 * Response from pull operation (discriminated union).
 */
export type PullResponse<S extends Schema> = PullResponseSuccess<S> | PullResponseError;

/**
 * Successful push response.
 */
export interface PushResponseSuccess {
	/** Indicates successful push */
	success: true;

	/** Server's current counter after the push */
	currentCounter?: bigint;
}

/**
 * Failed push response.
 */
export interface PushResponseError {
	/** Indicates failed push */
	success: false;

	/** Server's current counter (useful for conflict resolution) */
	currentCounter?: bigint;

	/** Error message describing the failure */
	error: string;
}

/**
 * Response from push operation (discriminated union).
 */
export type PushResponse = PushResponseSuccess | PushResponseError;

/**
 * Server sync adapter interface.
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
 * Sync configuration options.
 */
export interface SyncOptions {
	/** Debounce delay for pushing changes (default: 1000ms) */
	debounceMs?: number;

	/** Interval for periodic sync (default: 30000ms, 0 to disable) */
	intervalMs?: number;

	/** Sync when tab becomes visible (default: true) */
	syncOnVisible?: boolean;

	/** Sync when coming back online (default: true) */
	syncOnReconnect?: boolean;

	/** Maximum retry attempts (default: 3) */
	maxRetries?: number;

	/** Initial backoff delay for retries (default: 1000ms) */
	retryBackoffMs?: number;
}

/**
 * Factory function that creates a sync adapter.
 * @param privateKey - Optional private key for encryption/signing
 */
export type SyncAdapterFactory<S extends Schema> = (privateKey?: `0x${string}`) => SyncAdapter<S>;

/**
 * Combined sync configuration with adapter factory and options.
 */
export interface SyncConfig<S extends Schema> {
	/** Factory to create sync adapter */
	adapterFactory: SyncAdapterFactory<S>;

	/** Sync options */
	options?: SyncOptions;
}
