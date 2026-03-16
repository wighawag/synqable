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
import {createPrivateKeySigner} from './signer.js';
import {createJsonSerializer} from '../../../serializer/types.js';
import {wrapWithEncryption} from '../../../encryption/wrap.js';
import {createAesGcmProvider} from '../../../encryption/aes-gcm.js';

export type {Secp256k1DBConfig, Secp256k1Signer} from './types.js';
export {
	fromEthersSigner,
	fromViemWalletClient,
	fromPrivateKey,
	createPrivateKeySigner,
} from './signer.js';

/**
 * Configuration for creating a secp256k1-db sync adapter factory (legacy with explicit signer)
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
 * Configuration for creating a secp256k1-db sync adapter factory with privateKey-based signing/encryption.
 */
export interface Secp256k1DBPrivateKeyFactoryConfig {
	/** Base URL of the secp256k1-db service */
	endpoint: string;

	/** Namespace for data isolation */
	namespace: string;

	/** Optional: Custom fetch implementation */
	fetch?: typeof globalThis.fetch;

	/** Optional: Request timeout in milliseconds */
	timeoutMs?: number;

	/**
	 * Whether to encrypt data before sending to server.
	 * When true, uses AES-GCM encryption with the privateKey.
	 * Default: true
	 */
	encrypted?: boolean;
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

/**
 * Creates a secp256k1-db sync adapter factory that uses privateKey for signing and optional encryption.
 *
 * The privateKey is used for:
 * 1. Signing - Creating signatures for authenticated writes
 * 2. Encryption - Encrypting data before sending to server (if encrypted: true)
 *
 * @example With encryption (default)
 * ```typescript
 * const syncAdapterFactory = createSecp256k1DBAdapterFactory({
 *   endpoint: 'https://your-secp256k1-db.workers.dev',
 *   namespace: 'my-app',
 * });
 *
 * // privateKey used for BOTH signing AND encryption
 * const store = createSyncableStore({
 *   privateKey: '0x...',
 *   sync: { adapterFactory: syncAdapterFactory }
 * });
 * ```
 *
 * @example Without encryption
 * ```typescript
 * const syncAdapterFactory = createSecp256k1DBAdapterFactory({
 *   endpoint: 'https://your-secp256k1-db.workers.dev',
 *   namespace: 'my-app',
 *   encrypted: false,
 * });
 * ```
 */
export function createSecp256k1DBAdapterFactory<S extends Schema>(
	config: Secp256k1DBPrivateKeyFactoryConfig,
): SyncAdapterFactory<S> {
	const {endpoint, namespace, fetch: customFetch, timeoutMs, encrypted = true} = config;

	return (privateKey?: `0x${string}`) => {
		if (!privateKey) {
			throw new Error('secp256k1-db adapter requires privateKey for signing');
		}

		// Create signer from privateKey
		const signer = createPrivateKeySigner(privateKey);

		// Create serializer - optionally with encryption
		let serializer: Serializer<InternalStorage<S>> = createJsonSerializer<InternalStorage<S>>();
		if (encrypted) {
			const encryption = createAesGcmProvider(privateKey);
			serializer = wrapWithEncryption(serializer, encryption);
		}

		return new Secp256k1DBSyncAdapter<S>({
			endpoint,
			namespace,
			signer,
			serializer,
			fetch: customFetch,
			timeoutMs,
		});
	};
}
