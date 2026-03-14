import {DataOf, InternalStorage, Schema} from '../main/types.js';
import {AsyncStorage} from '../storage/types.js';
import {SyncAdapter, SyncConfig} from '../sync/types.js';

export interface SyncableStoreFactoryConfig<S extends Schema> {
	/** Schema definition */
	schema: S;

	/** Local storage adapter */
	storage: AsyncStorage<InternalStorage<S>>;

	/** Default data factory */
	defaultData: () => DataOf<S>;

	/** Clock function for timestamps (default: Date.now) */
	clock?: () => number;

	/** Schema version for migrations */
	schemaVersion?: number;

	/** Function to generate storage key from account address */
	storagKey: (account: `0x${string}`) => string;

	/** Optional: Server sync adapter */
	sync?: SyncAdapter<S>;

	/** Optional: Sync configuration */
	syncConfig?: SyncConfig;

	/** Migration functions keyed by target version */
	migrations?: Record<number, (oldData: unknown) => InternalStorage<S>>;
}
