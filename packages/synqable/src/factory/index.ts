import {createSyncableStore} from '../main/createSyncableStore.js';
import {Schema} from '../main/types.js';
import {SyncableStoreFactory} from '../multi-account/types.js';
import {SyncableStoreFactoryConfig} from './types.js';

/**
 * Creates a factory function that produces SyncableStore instances for accounts.
 *
 * The returned factory accepts an account address and optional privateKey.
 * When privateKey is provided, it enables:
 * - Storage encryption (if adapter factory supports it)
 * - Sync encryption and signing (if sync adapter requires it)
 *
 * @param config - Factory configuration
 * @returns Factory function that creates stores for accounts
 */
export function createSyncableStoreFactory<S extends Schema>(
	config: SyncableStoreFactoryConfig<S>,
): SyncableStoreFactory<S> {
	return (account: `0x${string}`, privateKey?: `0x${string}`) => {
		return createSyncableStore({
			schema: config.schema,
			account,
			privateKey, // Pass privateKey through to createSyncableStore
			storage: {
				adapterFactory: config.storage.adapterFactory,
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
