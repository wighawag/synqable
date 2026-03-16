import type {Serializer} from '../serializer/types.js';
import type {EncryptionProvider} from './types.js';
import {ENCRYPTED_PREFIX, isEncrypted, EncryptedDataError} from './types.js';

/**
 * Wraps a Serializer with encryption logic.
 * - If encryption provided: saves with `enc:` prefix, decrypts on load
 * - If no encryption: saves plain, throws EncryptedDataError on encrypted data
 *
 * Note: When no encryption is provided, the returned serializer preserves
 * the sync/async nature of the base serializer to avoid microtask overhead.
 */
export function wrapWithEncryption<T>(baseSerializer: Serializer<T>, encryption?: EncryptionProvider): Serializer<T> {
	if (!encryption) {
		// No encryption: preserve sync behavior of base serializer
		return {
			serialize: baseSerializer.serialize,
			deserialize: (data: string) => {
				if (isEncrypted(data)) {
					throw new EncryptedDataError();
				}
				return baseSerializer.deserialize(data);
			},
		};
	}

	// With encryption: must be async
	return {
		serialize: async (data: T) => {
			// Check if base serializer is sync to avoid unnecessary microtask
			const resultOrPromise = baseSerializer.serialize(data);
			const serialized = resultOrPromise instanceof Promise ? await resultOrPromise : resultOrPromise;
			const encrypted = await encryption.encrypt(serialized);
			return ENCRYPTED_PREFIX + encrypted;
		},
		deserialize: async (data: string) => {
			if (isEncrypted(data)) {
				const decrypted = await encryption.decrypt(data.slice(ENCRYPTED_PREFIX.length));
				// Check if base deserializer is sync
				const resultOrPromise = baseSerializer.deserialize(decrypted);
				return resultOrPromise instanceof Promise ? await resultOrPromise : resultOrPromise;
			}
			// Plain data — readable (migration-friendly)
			const resultOrPromise = baseSerializer.deserialize(data);
			return resultOrPromise instanceof Promise ? await resultOrPromise : resultOrPromise;
		},
	};
}
