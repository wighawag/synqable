import {DataOf, InternalStorage, Schema} from '../main/types.js';
import {AsyncStorage, StorageOptions} from '../storage/types.js';
import {SyncConfig} from '../sync/types.js';

/**
 * Storage configuration for factory - uses a key generator function.
 */
export interface FactoryStorageConfig<T> {
	/** Storage adapter */
	adapter: AsyncStorage<T>;

	/** Function to generate storage key from account address */
	key: (account: `0x${string}`) => string;

	/** Storage options */
	options?: StorageOptions;
}

export interface SyncableStoreFactoryConfig<S extends Schema> {
	/** Schema definition */
	schema: S;

	/** Storage configuration: adapter, key generator, and options */
	storage: FactoryStorageConfig<InternalStorage<S>>;

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
