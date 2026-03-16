/**
 * Storage configuration options.
 */
export interface StorageOptions {
	/** Debounce delay for local storage saves (default: 100ms) */
	debounceMs?: number;
}

/**
 * Factory function that creates a storage adapter.
 */
export type StorageAdapterFactory<T> = () => AsyncStorage<T>;

/**
 * Factory function that creates a watchable storage adapter.
 */
export type WatchableStorageAdapterFactory<T> = () => WatchableStorage<T>;

/**
 * Combined storage configuration with adapter factory, key, and options.
 */
export interface StorageConfig<T> {
	/** Factory to create storage adapter */
	adapterFactory: StorageAdapterFactory<T>;

	/** Storage key for this store instance */
	key: string;

	/** Storage options */
	options?: StorageOptions;
}

/**
 * Generic async storage interface for key-value persistence.
 * All operations are async to support various backends.
 */
export interface AsyncStorage<T> {
	/**
	 * Load data for the given key.
	 * @returns The stored data, or undefined if not found
	 */
	load(key: string): Promise<T | undefined>;

	/**
	 * Save data for the given key.
	 * @param key Storage key
	 * @param data Data to persist
	 */
	save(key: string, data: T): Promise<void>;

	/**
	 * Remove data for the given key.
	 * @param key Storage key
	 */
	remove(key: string): Promise<void>;

	/**
	 * Check if data exists for the given key.
	 * @param key Storage key
	 */
	exists(key: string): Promise<boolean>;
}

/**
 * Callback invoked when storage changes externally.
 * @param key The key that changed
 * @param newValue The new value, or undefined if removed
 */
export type StorageChangeCallback<T> = (key: string, newValue: T | undefined) => void;

/**
 * Extended storage interface with watch capability.
 * Adapters that support external change notifications implement this.
 */
export interface WatchableStorage<T> extends AsyncStorage<T> {
	/**
	 * Subscribe to external changes for a specific key.
	 * @param key The storage key to watch
	 * @param callback Called when external changes occur
	 * @returns Unsubscribe function
	 */
	watch(key: string, callback: StorageChangeCallback<T>): () => void;
}

/**
 * Type guard to check if storage supports watching.
 */
export function isWatchable<T>(storage: AsyncStorage<T>): storage is WatchableStorage<T> {
	return 'watch' in storage && typeof (storage as WatchableStorage<T>).watch === 'function';
}
