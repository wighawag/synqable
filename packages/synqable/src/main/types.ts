/**
 * Syncable Store - Core Type Definitions
 *
 * Two field types only:
 * - Permanent: Single value, updated as whole, never deleted
 * - Map: Key-value collection with per-item timestamps and deleteAt
 */

import {StorageConfig} from '../storage/types.js';
import {StoreEventsWithSync, SyncConfig, SyncStatus} from '../sync/types.js';

// ============================================================================
// Field Type Markers
// ============================================================================

/**
 * Marker type for permanent fields - updated as a whole unit.
 */
export type PermanentField<T> = {__type: 'permanent'; __value?: T};

/**
 * Marker type for map fields - items merged individually.
 */
export type MapField<T> = {__type: 'map'; __item?: T};

// ============================================================================
// Schema Definition Helpers
// ============================================================================

/**
 * Define a permanent field in the schema.
 * Permanent fields are updated as a whole and never deleted.
 */
export function permanent<T>(): PermanentField<T> {
	return {__type: 'permanent'} as PermanentField<T>;
}

/**
 * Define a map field in the schema.
 * Map fields contain items that are individually tracked with timestamps and deleteAt.
 */
export function map<T>(): MapField<T> {
	return {__type: 'map'} as MapField<T>;
}

/**
 * Schema type - maps field names to field types.
 */
export type Schema = Record<string, PermanentField<unknown> | MapField<unknown>>;

/**
 * Define a schema with type inference.
 */
export function defineSchema<S extends Schema>(schema: S): S {
	return schema;
}

// ============================================================================
// Type Extractors
// ============================================================================

/**
 * Extract permanent field keys from a schema.
 */
export type PermanentKeys<S extends Schema> = {
	[K in keyof S]: S[K] extends PermanentField<unknown> ? K : never;
}[keyof S];

/**
 * Extract map field keys from a schema.
 */
export type MapKeys<S extends Schema> = {
	[K in keyof S]: S[K] extends MapField<unknown> ? K : never;
}[keyof S];

/**
 * Extract the inner type from a PermanentField.
 */
export type ExtractPermanent<F> = F extends PermanentField<infer T> ? T : never;

/**
 * Extract the item type from a MapField.
 */
export type ExtractMapItem<F> = F extends MapField<infer T> ? T : never;

/**
 * Extract the user-facing data type from schema.
 * Map items include deleteAt in the data.
 */
export type DataOf<S extends Schema> = {
	[K in keyof S]: S[K] extends PermanentField<infer T>
		? T
		: S[K] extends MapField<infer T>
			? Record<string, T & {deleteAt: number}>
			: never;
};

/**
 * Deep partial type for patch operations.
 */
export type DeepPartial<T> = T extends object ? {[K in keyof T]?: DeepPartial<T[K]>} : T;

/**
 * Deep readonly type to prevent direct mutation of nested data.
 */
export type DeepReadonly<T> = T extends (infer U)[]
	? ReadonlyArray<DeepReadonly<U>>
	: T extends Map<infer K, infer V>
		? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
		: T extends Set<infer U>
			? ReadonlySet<DeepReadonly<U>>
			: T extends object
				? {readonly [K in keyof T]: DeepReadonly<T[K]>}
				: T;

// ============================================================================
// Internal Storage Shape
// ============================================================================

/**
 * Internal storage structure with timestamps stored separately from user data.
 */
export type InternalStorage<S extends Schema> = {
	/** Schema version for migration tracking */
	$version: number;

	/** User's clean data */
	data: DataOf<S>;

	/** Timestamps for permanent fields */
	$timestamps: {
		[K in PermanentKeys<S>]?: number;
	};

	/** Per-item timestamps for map fields */
	$itemTimestamps: {
		[K in MapKeys<S>]?: Record<string, number>;
	};

	/** Tombstones for deleted map items (stores deleteAt time) */
	$tombstones: {
		[K in MapKeys<S>]?: Record<string, number>;
	};
};

// ============================================================================
// State Events
// ============================================================================

/**
 * State lifecycle events - emitted on async state transitions.
 * The 'idle' event includes an optional error when load failed.
 */
export type StateEvent = {type: 'idle'; error?: Error} | {type: 'loading'} | {type: 'ready'};

// ============================================================================
// Storage Status and Events
// ============================================================================

/**
 * Storage status - local persistence state.
 */
export interface StorageStatus {
	/** True when a storage save operation is in progress */
	readonly isSaving: boolean;

	/** Last successful save timestamp */
	readonly lastSavedAt: number | null;

	/** Last storage error, null if healthy */
	readonly storageError: Error | null;

	/** Display state for simple UI: saving > error > idle */
	readonly displayState: 'saving' | 'error' | 'idle';
}

/**
 * Storage lifecycle events - point-in-time notifications.
 */
export type StorageEvent =
	| {type: 'saving'}
	| {type: 'saved'; timestamp: number}
	| {type: 'failed'; error: Error};

// ============================================================================
// Type-Safe Event Map
// ============================================================================

/**
 * Base store events that are always present (not schema-derived).
 */
type BaseStoreEvents<S extends Schema> = {
	'$store:state': StateEvent;
	'$store:storage': StorageEvent;
};

/**
 * Helper type - events for permanent fields.
 */
type PermanentEvents<S extends Schema> = {
	[K in PermanentKeys<S> as `${K & string}:changed`]: ExtractPermanent<S[K]>;
};

/**
 * Helper type - events for map fields.
 */
type MapEvents<S extends Schema> = {
	[K in MapKeys<S> as `${K & string}:added`]: {
		key: string;
		item: ExtractMapItem<S[K]> & {deleteAt: number};
	};
} & {
	[K in MapKeys<S> as `${K & string}:updated`]: {
		key: string;
		item: ExtractMapItem<S[K]> & {deleteAt: number};
	};
} & {
	[K in MapKeys<S> as `${K & string}:removed`]: {
		key: string;
		item: ExtractMapItem<S[K]> & {deleteAt: number};
	};
};

/**
 * Schema-derived events.
 */
type SchemaEvents<S extends Schema> = Omit<
	PermanentEvents<S> & MapEvents<S>,
	keyof BaseStoreEvents<S>
>;

/**
 * Complete event map for a store (without sync events).
 * Sync events are added when using server sync.
 */
export type StoreEvents<S extends Schema> = BaseStoreEvents<S> & SchemaEvents<S>;

// ============================================================================
// Async State Types
// ============================================================================

/**
 * Base async state fields common to all states.
 */
interface AsyncStateBase {
	/** Whether the store is currently loading */
	isLoading: boolean;
	/** Load error if the last load attempt failed */
	loadError: Error | null;
}

/**
 * Async state for store data.
 * Uses isLoading/loadError pattern consistent with storageStatus/syncStatus.
 */
export type AsyncState<T> =
	| (AsyncStateBase & {status: 'idle'; account: `0x${string}` | undefined})
	| (AsyncStateBase & {status: 'ready'; account: `0x${string}`; data: T});

// ============================================================================
// Change Tracking Types
// ============================================================================

/**
 * Represents a change detected during merge.
 */
export type StoreChange =
	| {event: `${string}:changed`; data: unknown}
	| {event: `${string}:added`; data: {key: string; item: unknown}}
	| {event: `${string}:updated`; data: {key: string; item: unknown}}
	| {event: `${string}:removed`; data: {key: string; item: unknown}};

// ============================================================================
// Mutation Options
// ============================================================================

/**
 * Options for mutation operations.
 */
export interface MutationOptions {
	/**
	 * Force immediate storage save, bypassing debounce.
	 * Use for critical data that must persist immediately.
	 */
	immediate?: boolean;
}

// ============================================================================
// Readable Store Interface (Svelte store contract)
// ============================================================================

export interface Readable<T> {
	subscribe(callback: (value: T) => void): () => void;
}

// ============================================================================
// Store Configuration
// ============================================================================

export interface SyncableStoreConfig<S extends Schema> {
	/** Schema definition */
	schema: S;

	/** Static account address - store is bound to this account */
	account: `0x${string}`;

	/** Optional private key for encryption */
	privateKey?: `0x${string}`;

	/** Storage configuration: adapter factory, key, and options */
	storage: StorageConfig<InternalStorage<S>>;

	/** Default data factory */
	defaultData: () => DataOf<S>;

	/** Clock function for timestamps (default: Date.now) */
	clock?: () => number;

	/** Schema version for migrations */
	schemaVersion?: number;

	/** Optional: Sync configuration: adapter and options */
	sync?: SyncConfig<S>;

	/** Migration functions keyed by target version */
	migrations?: Record<number, (oldData: unknown) => InternalStorage<S>>;
}

// ============================================================================
// Store Interface
// ============================================================================

export interface SyncableStore<S extends Schema> {
	/** Current async state (deeply readonly to prevent direct mutation) */
	get(): DeepReadonly<AsyncState<DataOf<S>>>;

	/** The account this store is bound to */
	readonly account: `0x${string}`;

	/** Set a permanent field value */
	set<K extends PermanentKeys<S>>(
		field: K,
		value: ExtractPermanent<S[K]>,
		options?: MutationOptions,
	): void;

	/** Update a permanent field with partial updates (deep merge) */
	update<K extends PermanentKeys<S>>(
		field: K,
		value: DeepPartial<ExtractPermanent<S[K]>>,
		options?: MutationOptions,
	): void;

	/** Add an item to a map field */
	addItem<K extends MapKeys<S>>(
		field: K,
		key: string,
		value: ExtractMapItem<S[K]>,
		options: {deleteAt: number; immediate?: boolean},
	): void;

	/** Set an existing map item (full replacement, preserves deleteAt) */
	setItem<K extends MapKeys<S>>(
		field: K,
		key: string,
		value: ExtractMapItem<S[K]>,
		options?: MutationOptions,
	): void;

	/** Update an existing map item with partial updates (deep merge, preserves deleteAt) */
	updateItem<K extends MapKeys<S>>(
		field: K,
		key: string,
		value: DeepPartial<ExtractMapItem<S[K]>>,
		options?: MutationOptions,
	): void;

	/** Remove an item from a map field */
	removeItem<K extends MapKeys<S>>(field: K, key: string, options?: MutationOptions): void;

	/** Subscribe to state changes (Svelte store contract) */
	subscribe(callback: (state: AsyncState<DataOf<S>>) => void): () => void;

	/** Subscribe to type-safe events */
	on<E extends keyof StoreEventsWithSync<S>>(
		event: E,
		callback: (data: StoreEventsWithSync<S>[E]) => void,
	): () => void;

	/** Unsubscribe from events */
	off<E extends keyof StoreEventsWithSync<S>>(
		event: E,
		callback: (data: StoreEventsWithSync<S>[E]) => void,
	): void;

	/** Load data from storage - must be called to initialize */
	load(): Promise<void>;

	/** Stop watching and clean up */
	stop(): void;

	/** Watch a specific map item reactively */
	watchItem<K extends MapKeys<S>>(
		field: K,
		key: string,
	): Readable<(ExtractMapItem<S[K]> & {deleteAt: number}) | undefined>;

	/** Watch a top-level field reactively */
	watchField<K extends keyof S>(field: K): Readable<DataOf<S>[K] | undefined>;

	/** Watch map field IDs reactively - only notifies on additions and removals, not updates */
	watchItemIds<K extends MapKeys<S>>(field: K): Readable<string[]>;

	/** Reactive sync status */
	readonly syncStatus$: Readable<SyncStatus>;

	/** Reactive storage status */
	readonly storageStatus$: Readable<StorageStatus>;

	/** Force sync to server now */
	syncNow(): Promise<void>;

	/** Retry loading after a migration failure */
	retryLoad(): void;

	/** Wait for all pending storage saves to complete */
	flush(timeoutMs?: number): Promise<void>;
}
