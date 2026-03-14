/**
 * Syncable Store - Core Type Definitions
 *
 * Two field types only:
 * - Permanent: Single value, updated as whole, never deleted
 * - Map: Key-value collection with per-item timestamps and deleteAt
 */

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
 */
export type StateEvent = {type: 'idle'} | {type: 'loading'} | {type: 'ready'};

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
 * Async state for store data.
 */
export type AsyncState<T> =
	| {status: 'idle'; account: undefined}
	| {status: 'loading'; account: `0x${string}`}
	| {status: 'ready'; account: `0x${string}`; data: T};

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
