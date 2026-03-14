import {createSyncableStore} from '../main/createSyncableStore.js';
import {Schema} from '../main/types.js';
import {SyncableStoreFactoryConfig} from './types.js';

export function createSyncableStoreFactory<S extends Schema>(
	config: SyncableStoreFactoryConfig<S>,
) {
	return (account: `0x${string}`) => {
		return createSyncableStore({
			...config,
			account,
			storageKey: config.storagKey(account),
		});
	};
}
