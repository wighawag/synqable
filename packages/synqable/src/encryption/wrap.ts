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
export function wrapWithEncryption<T>(
	baseSerializer: Serializer<T>,
	encryption?: EncryptionProvider,
): Serializer<T> {
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

	// With encryption: may be sync or async depending on encryption provider
	return {
		serialize: async (data: T) => {
			// Check if base serializer is sync to avoid unnecessary microtask
			const serializeOrPromise = baseSerializer.serialize(data);
			const serialized =
				serializeOrPromise instanceof Promise ? await serializeOrPromise : serializeOrPromise;
			// Check if encryption is sync to avoid unnecessary microtask
			const encryptOrPromise = encryption.encrypt(serialized);
			const encrypted =
				encryptOrPromise instanceof Promise ? await encryptOrPromise : encryptOrPromise;
			return ENCRYPTED_PREFIX + encrypted;
		},
		deserialize: async (data: string) => {
			if (isEncrypted(data)) {
				// Check if decryption is sync to avoid unnecessary microtask
				const decryptOrPromise = encryption.decrypt(data.slice(ENCRYPTED_PREFIX.length));
				const decrypted =
					decryptOrPromise instanceof Promise ? await decryptOrPromise : decryptOrPromise;
				// Check if base deserializer is sync
				const deserializeOrPromise = baseSerializer.deserialize(decrypted);
				return deserializeOrPromise instanceof Promise
					? await deserializeOrPromise
					: deserializeOrPromise;
			}
			// Plain data — readable (migration-friendly)
			const deserializeOrPromise = baseSerializer.deserialize(data);
			return deserializeOrPromise instanceof Promise
				? await deserializeOrPromise
				: deserializeOrPromise;
		},
	};
}
