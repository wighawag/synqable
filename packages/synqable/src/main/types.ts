/**
 * Syncable Store - Core Type Definitions
 *
 * Three field types, distinguished by MERGE GRANULARITY - the property that
 * decides whether a concurrent edit survives:
 *
 * | type       | merge granularity | key set                  | deletion        |
 * |------------|-------------------|--------------------------|-----------------|
 * | value<T>   | the whole value   | single value             | never deleted   |
 * | record<T>  | per property      | fixed, heterogeneous     | never deleted   |
 * | map<T>     | per key           | open, homogeneous        | deleteAt + TTL  |
 *
 * Choosing between them:
 * - Properties edited independently on different devices -> record.
 *   `value` resolves as one unit, so the losing device's edit to an untouched
 *   property is discarded.
 * - Entries that come and go -> map. Records have a fixed key set and no tombstones.
 * - Genuinely atomic data, replaced wholesale -> value.
 *
 * Record granularity is one level deep, by design. `record<{a: {b: 1}}>` stamps
 * `a` as a unit; per-path timestamps at arbitrary depth is a different data
 * structure (a full CRDT) and deliberately out of scope.
 */

import {StorageConfig} from '../storage/types.js';
import {StoreEventsWithSync, SyncConfig, SyncStatus} from '../sync/types.js';

// ============================================================================
// Field Type Markers
// ============================================================================

/**
 * Marker type for value fields - updated as a whole unit.
 */
export type ValueField<T> = {__type: 'value'; __value?: T};

/**
 * Marker type for record fields - properties merged individually.
 */
export type RecordField<T> = {__type: 'record'; __value?: T};

/**
 * Marker type for map fields - items merged individually.
 */
export type MapField<T> = {__type: 'map'; __item?: T};

// ============================================================================
// Schema Definition Helpers
// ============================================================================

/**
 * Define a value field in the schema.
 * Value fields are updated as a whole and never deleted.
 */
export function value<T>(): ValueField<T> {
	return {__type: 'value'} as ValueField<T>;
}

/**
 * Schema-time guard for `record<T>()`.
 *
 * An array can never be a record: its indices are jointly constrained by order
 * and length, so there are no independently mergeable properties. Returning a
 * branded error type instead of `RecordField<T>` makes that fail at the schema
 * field rather than as a corrupted merge at sync time.
 *
 * Primitives get the same treatment, since a primitive has no properties to
 * merge. Exotic objects (Date, Map, class instances) satisfy `object` and
 * cannot be excluded structurally, so `mergeRecord` rejects those at runtime.
 */
type RecordFieldFor<T> = T extends readonly unknown[]
	? {
			__synqableSchemaError: 'record<T> cannot be an array. Arrays merge as a whole because their indices are jointly constrained by order and length. Use value<T>() instead.';
		}
	: T extends object
		? RecordField<T>
		: {
				__synqableSchemaError: 'record<T> must be an object with independently mergeable properties. A primitive has none. Use value<T>() instead.';
			};

/**
 * Define a record field in the schema.
 *
 * Record fields hold a fixed set of named properties, each merged
 * independently by timestamp. Use this when two devices may edit different
 * properties of the same struct and both edits must survive.
 *
 * Only for structs whose properties can be observed independently. If the
 * properties carry a joint invariant (a `{start, end}` range, a `{x, y}`
 * point), use `value<T>()`: merging them independently can converge on a
 * combination that never existed on any device.
 *
 * Properties are never deleted - use a map field for entries that come and go.
 */
export function record<T>(): RecordFieldFor<T> {
	return {__type: 'record'} as RecordFieldFor<T>;
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
export type Schema = Record<string, ValueField<unknown> | RecordField<unknown> | MapField<unknown>>;

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
 * Extract value field keys from a schema.
 */
export type ValueKeys<S extends Schema> = {
	[K in keyof S]: S[K] extends ValueField<unknown> ? K : never;
}[keyof S];

/**
 * Extract record field keys from a schema.
 */
export type RecordKeys<S extends Schema> = {
	[K in keyof S]: S[K] extends RecordField<unknown> ? K : never;
}[keyof S];

/**
 * Extract map field keys from a schema.
 */
export type MapKeys<S extends Schema> = {
	[K in keyof S]: S[K] extends MapField<unknown> ? K : never;
}[keyof S];

/**
 * Keys of fields held as a single addressable value (value and record fields).
 * These are the fields `set` and `patch` operate on.
 */
export type WholeFieldKeys<S extends Schema> = ValueKeys<S> | RecordKeys<S>;

/**
 * Extract the inner type from a ValueField.
 */
export type ExtractValue<F> = F extends ValueField<infer T> ? T : never;

/**
 * Extract the inner type from a RecordField.
 */
export type ExtractRecord<F> = F extends RecordField<infer T> ? T : never;

/**
 * Extract the item type from a MapField.
 */
export type ExtractMapItem<F> = F extends MapField<infer T> ? T : never;

/**
 * Extract the user-facing data type from schema.
 * Map items include deleteAt in the data.
 */
export type DataOf<S extends Schema> = {
	[K in keyof S]: S[K] extends ValueField<infer T>
		? T
		: S[K] extends RecordField<infer T>
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

	/** Timestamps for value fields */
	$timestamps: {
		[K in ValueKeys<S>]?: number;
	};

	/**
	 * Per-key timestamps for record fields (keyed by property name) and map
	 * fields (keyed by item id).
	 */
	$itemTimestamps: {
		[K in RecordKeys<S> | MapKeys<S>]?: Record<string, number>;
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
 * Helper type - events for value fields.
 */
type ValueEvents<S extends Schema> = {
	[K in ValueKeys<S> as `${K & string}:changed`]: ExtractValue<S[K]>;
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
 * Helper type - events for record fields.
 *
 * Record fields emit one field-level event carrying the whole merged value,
 * matching value fields. Per-property event names (`settings.theme:changed`)
 * are deliberately not used: map fields already established that per-key
 * granularity travels in the payload, not the event name.
 */
type RecordEvents<S extends Schema> = {
	[K in RecordKeys<S> as `${K & string}:changed`]: ExtractRecord<S[K]>;
};

/**
 * Schema-derived events.
 */
type SchemaEvents<S extends Schema> = Omit<
	ValueEvents<S> & RecordEvents<S> & MapEvents<S>,
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

/**
 * Store lifecycle state - for observing load status.
 * Does NOT include data - use get() for current data or watchField/watchItem for reactivity.
 */
export type StoreLifecycleState =
	| {status: 'idle'; account: `0x${string}` | undefined; isLoading: false; loadError: Error | null}
	| {status: 'loading'; account: `0x${string}`; isLoading: true; loadError: null}
	| {status: 'ready'; account: `0x${string}`; isLoading: false; loadError: null};

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

export interface RemovalMutationOptions extends MutationOptions {
	ignoreMissing?: boolean;
}

// ============================================================================
// Readable Store Interface (Svelte store contract)
// ============================================================================

export interface Readable<T> {
	subscribe(callback: (value: T) => void): () => void;
}

// ============================================================================
// Readable Type Utilities
// ============================================================================

/**
 * Type of the Readable returned by watchField for a given field.
 * - For value and record fields: T | undefined (undefined before first set or when store not ready)
 * - For map fields: Always a Record (empty {} when store not ready, never undefined)
 *
 * @example
 * ```typescript
 * const settingsStore: FieldReadable<typeof schema, 'settings'> = store.watchField('settings');
 * const tasksStore: FieldReadable<typeof schema, 'tasks'> = store.watchField('tasks'); // Never undefined
 * ```
 */
export type FieldReadable<S extends Schema, K extends keyof S> =
	S[K] extends MapField<unknown> ? Readable<DataOf<S>[K]> : Readable<DataOf<S>[K] | undefined>;

/**
 * Type of the Readable returned by watchItem for a given map field.
 *
 * @example
 * ```typescript
 * const taskStore: ItemReadable<typeof schema, 'tasks'> = store.watchItem('tasks', taskId);
 * ```
 */
export type ItemReadable<S extends Schema, K extends MapKeys<S>> = Readable<
	(ExtractMapItem<S[K]> & {deleteAt: number}) | undefined
>;

/**
 * Type of the Readable returned by watchItemIds for a given map field.
 *
 * @example
 * ```typescript
 * const taskIdsStore: ItemIdsReadable<typeof schema, 'tasks'> = store.watchItemIds('tasks');
 * ```
 */
export type ItemIdsReadable<S extends Schema, K extends MapKeys<S>> = Readable<string[]>;

/**
 * Helper to get the value type inside a Readable.
 * Useful for typing callback parameters.
 *
 * @example
 * ```typescript
 * function handleSettings(settings: ReadableValue<FieldReadable<typeof schema, 'settings'>>) {
 *     // settings is Settings | undefined
 * }
 * ```
 */
export type ReadableValue<R> = R extends Readable<infer T> ? T : never;

/**
 * All field readable types for a schema.
 *
 * @example
 * ```typescript
 * type MyFieldStores = FieldReadables<typeof schema>;
 * // { settings: Readable<Settings | undefined>, tasks: Readable<Record<...>> }
 * ```
 */
export type FieldReadables<S extends Schema> = {
	[K in keyof S]: FieldReadable<S, K>;
};

/**
 * All item readable types for map fields in a schema.
 *
 * @example
 * ```typescript
 * type MyItemStores = ItemReadables<typeof schema>;
 * // { tasks: Readable<(Task & {deleteAt: number}) | undefined> }
 * ```
 */
export type ItemReadables<S extends Schema> = {
	[K in MapKeys<S>]: ItemReadable<S, K>;
};

/**
 * All item IDs readable types for map fields in a schema.
 *
 * @example
 * ```typescript
 * type MyItemIdsStores = ItemIdsReadables<typeof schema>;
 * // { tasks: Readable<string[]> }
 * ```
 */
export type ItemIdsReadables<S extends Schema> = {
	[K in MapKeys<S>]: ItemIdsReadable<S, K>;
};

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

	/**
	 * Replace a value or record field wholesale.
	 * On a record field this asserts every property, so every property is
	 * stamped with the current time.
	 */
	set<K extends WholeFieldKeys<S>>(field: K, value: DataOf<S>[K], options?: MutationOptions): void;

	/**
	 * Update a record field with partial updates (deep merge).
	 *
	 * Only the top-level properties present in `value` are stamped, so a
	 * concurrent edit to any other property survives the merge.
	 *
	 * Deliberately unavailable on value fields: a value field resolves as a
	 * single unit, so a partial update there cannot merge independently and the
	 * API would be claiming a granularity the merge does not provide. Use
	 * `set` or `patch` for value fields, or make the field a `record`.
	 */
	update<K extends RecordKeys<S>>(
		field: K,
		value: DeepPartial<ExtractRecord<S[K]>>,
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

	/**
	 * Patch a value or record field using an update function.
	 * Always creates a new reference.
	 *
	 * On a record field only the top-level properties whose value actually
	 * changed are stamped.
	 */
	patch<K extends WholeFieldKeys<S>>(
		field: K,
		updateFn: (current: DataOf<S>[K]) => DataOf<S>[K],
		options?: MutationOptions,
	): void;

	/** Patch an existing map item using an update function. Always creates a new reference. */
	patchItem<K extends MapKeys<S>>(
		field: K,
		key: string,
		updateFn: (current: ExtractMapItem<S[K]>) => ExtractMapItem<S[K]>,
		options?: MutationOptions,
	): void;

	/** Remove an item from a map field */
	removeItem<K extends MapKeys<S>>(field: K, key: string, options?: RemovalMutationOptions): void;

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
	watchField<K extends keyof S>(
		field: K,
	): S[K] extends MapField<unknown> ? Readable<DataOf<S>[K]> : Readable<DataOf<S>[K] | undefined>;

	/** Watch map field IDs reactively - only notifies on additions and removals, not updates */
	watchItemIds<K extends MapKeys<S>>(field: K): Readable<string[]>;

	/** Reactive store lifecycle state */
	readonly state$: Readable<StoreLifecycleState>;

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
