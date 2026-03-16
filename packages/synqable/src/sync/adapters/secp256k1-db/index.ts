/**
 * secp256k1-db Sync Adapter
 *
 * A sync adapter for communicating with secp256k1-db, a Cloudflare Workers-based
 * service that allows Ethereum wallets to store and retrieve signed data.
 */

import type {Schema, InternalStorage} from '../../../main/types.js';
import type {SyncAdapterFactory} from '../../types.js';
import type {Secp256k1DBConfig, Secp256k1Signer} from './types.js';
import type {Serializer} from '../../../serializer/types.js';
import {Secp256k1DBSyncAdapter} from './adapter.js';

export type {Secp256k1DBConfig, Secp256k1Signer} from './types.js';
export {fromEthersSigner, fromViemWalletClient, fromPrivateKey} from './signer.js';

/**
 * Configuration for creating a secp256k1-db sync adapter factory
 */
export interface Secp256k1DBFactoryConfig<S extends Schema> {
	/** Base URL of the secp256k1-db service */
	endpoint: string;

	/** Namespace for data isolation */
	namespace: string;

	/** Signer for creating signatures */
	signer: Secp256k1Signer;

	/**
	 * Optional: Serializer for data transformation.
	 * Defaults to JSON serializer if not provided.
	 * Can be used for encryption or custom encoding.
	 */
	serializer?: Serializer<InternalStorage<S>>;

	/** Optional: Custom fetch implementation */
	fetch?: typeof globalThis.fetch;

	/** Optional: Request timeout in milliseconds */
	timeoutMs?: number;
}

/**
 * Creates a sync adapter factory for secp256k1-db.
 *
 * @example Basic usage
 * ```typescript
 * import { createSecp256k1DBSyncAdapterFactory, fromViemWalletClient } from 'synqable/sync/adapters/secp256k1-db';
 *
 * const syncAdapterFactory = createSecp256k1DBSyncAdapterFactory({
 *   endpoint: 'https://your-secp256k1-db.workers.dev',
 *   namespace: 'my-app',
 *   signer: fromViemWalletClient(walletClient, account)
 * });
 *
 * const store = createSyncableStore({
 *   // ...other config
 *   sync: {
 *     adapterFactory: syncAdapterFactory,
 *     options: { debounceMs: 1000 }
 *   }
 * });
 * ```
 *
 * @example With custom serializer (e.g., encryption)
 * ```typescript
 * import { createEncryptedSerializer } from 'synqable/encryption';
 *
 * const encryptedSerializer = createEncryptedSerializer(privateKey);
 *
 * const syncAdapterFactory = createSecp256k1DBSyncAdapterFactory({
 *   endpoint: 'https://your-secp256k1-db.workers.dev',
 *   namespace: 'my-app',
 *   signer: fromViemWalletClient(walletClient, account),
 *   serializer: encryptedSerializer
 * });
 * ```
 */
export function createSecp256k1DBSyncAdapterFactory<S extends Schema>(
	config: Secp256k1DBFactoryConfig<S>,
): SyncAdapterFactory<S> {
	return () => new Secp256k1DBSyncAdapter<S>(config);
}
