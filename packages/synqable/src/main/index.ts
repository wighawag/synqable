/**
 * Syncable Store - Main Module Public API
 *
 * Core store functionality, types, cleanup, and merge.
 */

// Schema definition and core types
export {
	defineSchema,
	permanent,
	map,
	type PermanentField,
	type MapField,
	type Schema,
	type DataOf,
	type PermanentKeys,
	type MapKeys,
	type ExtractPermanent,
	type ExtractMapItem,
	type DeepPartial,
	type DeepReadonly,
	type InternalStorage,
	type AsyncState,
	type StateEvent,
	type StorageStatus,
	type StorageEvent,
	type StoreChange,
	type StoreEvents,
	type MutationOptions,
	type SyncableStore,
	type SyncableStoreConfig,
	type Readable,
} from './types.js';

// Combined status utility
export {combineStatus} from './combineStatus.js';

// Store creation
export {createSyncableStore} from './createSyncableStore.js';

// Merge functions (for advanced use)
export {
	tiebreaker,
	mergePermanent,
	mergeMap,
	mergeStore,
	mergeAndCleanup,
	type PermanentMergeInput,
	type PermanentMergeResult,
	type MapState,
	type MapChange,
	type MapMergeResult,
	type StoreMergeResult,
	type MergeAndCleanupResult,
} from './merge.js';

// Cleanup function
export {cleanup, type CleanupResult} from './cleanup.js';
