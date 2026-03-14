export {
	type AsyncStorage,
	type WatchableStorage,
	type StorageChangeCallback,
	type StorageOptions,
	type StorageConfig,
	type StorageAdapterFactory,
	isWatchable,
} from './types.js';

export {createLocalStorageAdapter, type LocalStorageAdapterOptions} from './LocalStorageAdapter.js';
