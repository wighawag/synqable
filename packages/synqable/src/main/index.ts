/**
 * Syncable Store - Main Module Public API
 *
 * Core store functionality, types, cleanup, and merge.
 */

// Schema definition and core types
export {
	defineSchema,
	value,
	record,
	map,
	type ValueField,
	type RecordField,
	type MapField,
	type Schema,
	type DataOf,
	type ValueKeys,
	type RecordKeys,
	type WholeFieldKeys,
	type MapKeys,
	type ExtractValue,
	type ExtractRecord,
	type ExtractMapItem,
	type DeepPartial,
	type DeepReadonly,
	type InternalStorage,
	type AsyncState,
	type StoreLifecycleState,
	type StateEvent,
	type StorageStatus,
	type StorageEvent,
	type StoreChange,
	type StoreEvents,
	type MutationOptions,
	type SyncableStore,
	type SyncableStoreConfig,
	type Readable,
	type FieldReadable,
	type ItemReadable,
	type ItemIdsReadable,
	type ReadableValue,
	type FieldReadables,
	type ItemReadables,
	type ItemIdsReadables,
} from './types.js';

// Combined status utility
export {combineStatus} from './combineStatus.js';

// Store creation
export {createSyncableStore} from './createSyncableStore.js';

// Merge functions (for advanced use)
export {
	tiebreaker,
	mergeValue,
	mergeRecord,
	mergeMap,
	mergeStore,
	mergeAndCleanup,
	type ValueMergeInput,
	type ValueMergeResult,
	type RecordState,
	type RecordMergeResult,
	type MapState,
	type MapChange,
	type MapMergeResult,
	type StoreMergeResult,
	type MergeAndCleanupResult,
} from './merge.js';

// Cleanup function
export {cleanup, type CleanupResult} from './cleanup.js';
