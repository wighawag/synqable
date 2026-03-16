export {
	type AsyncStorage,
	type WatchableStorage,
	type StorageChangeCallback,
	type StorageOptions,
	type StorageConfig,
	type StorageAdapterFactory,
	type WatchableStorageAdapterFactory,
	isWatchable,
} from './types.js';

export {createLocalStorageAdapter, createLocalStorageAdapterFactory} from './LocalStorageAdapter.js';
