import {createSyncableStore} from '../main/createSyncableStore.js';
import {Schema} from '../main/types.js';
import {SyncableStoreFactory} from '../multi-account/types.js';
import {SyncableStoreFactoryConfig} from './types.js';

export function createSyncableStoreFactory<S extends Schema>(
	config: SyncableStoreFactoryConfig<S>,
): SyncableStoreFactory<S> {
	return (account: `0x${string}`) => {
		return createSyncableStore({
			schema: config.schema,
			account,
			storage: {
				adapter: config.storage.adapter,
				key: config.storage.key(account),
				options: config.storage.options,
			},
			defaultData: config.defaultData,
			clock: config.clock,
			schemaVersion: config.schemaVersion,
			sync: config.sync,
			migrations: config.migrations,
		});
	};
}
