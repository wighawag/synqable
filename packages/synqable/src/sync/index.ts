/**
 * Single-Account Syncable Store - Public API
 */

// Schema definition
export {
	defineSchema,
	permanent,
	map,
	combineStatus,
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
	type SyncStatus,
	type SyncEvent,
	type StorageStatus,
	type StorageEvent,
	type StoreChange,
	type StoreEvents,
	type SyncAdapter,
	type SyncConfig,
	type PullResponse,
	type PushResponse,
} from './types.js';

// Store creation
export {
	createSyncableStore,
	type SyncableStore,
	type SyncableStoreConfig,
	type Readable,
} from './createSyncableStore.js';

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
export { cleanup, type CleanupResult } from './cleanup.js';
