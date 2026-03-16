import {describe, it, expect} from 'vitest';
import {
	createJsonSerializer,
	createAesGcmProvider,
	wrapWithEncryption,
	EncryptedDataError,
	isEncrypted,
	ENCRYPTED_PREFIX,
} from '../src/index.js';

describe('Serializer', () => {
	describe('createJsonSerializer', () => {
		it('round-trips data', () => {
			const serializer = createJsonSerializer<{name: string}>();
			const data = {name: 'test'};
			const serialized = serializer.serialize(data) as string; // JSON serializer is sync
			const deserialized = serializer.deserialize(serialized);
			expect(deserialized).toEqual(data);
		});

		it('handles complex nested objects', () => {
			const serializer = createJsonSerializer<{
				user: {name: string; age: number};
				items: string[];
			}>();
			const data = {
				user: {name: 'Alice', age: 30},
				items: ['a', 'b', 'c'],
			};
			const serialized = serializer.serialize(data) as string; // JSON serializer is sync
			const deserialized = serializer.deserialize(serialized);
			expect(deserialized).toEqual(data);
		});

		it('returns sync functions (not Promises)', () => {
			const serializer = createJsonSerializer<{value: number}>();
			const result = serializer.serialize({value: 42});
			expect(result).not.toBeInstanceOf(Promise);
			expect(result).toBe('{"value":42}');
		});
	});
});

describe('Encryption Helpers', () => {
	describe('isEncrypted', () => {
		it('returns true for encrypted data', () => {
			expect(isEncrypted('enc:somedata')).toBe(true);
		});

		it('returns false for plain data', () => {
			expect(isEncrypted('{"plain":"data"}')).toBe(false);
		});

		it('returns false for empty string', () => {
			expect(isEncrypted('')).toBe(false);
		});
	});

	describe('ENCRYPTED_PREFIX', () => {
		it('is "enc:"', () => {
			expect(ENCRYPTED_PREFIX).toBe('enc:');
		});
	});
});

describe('createAesGcmProvider', () => {
	const testPrivateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as const;

	it('encrypts and decrypts data', async () => {
		const provider = createAesGcmProvider(testPrivateKey);
		const plaintext = 'hello world';
		const encrypted = await provider.encrypt(plaintext);
		const decrypted = await provider.decrypt(encrypted);
		expect(decrypted).toBe(plaintext);
		expect(encrypted).not.toBe(plaintext);
	});

	it('produces different ciphertext each time (random IV)', async () => {
		const provider = createAesGcmProvider(testPrivateKey);
		const plaintext = 'same input';
		const encrypted1 = await provider.encrypt(plaintext);
		const encrypted2 = await provider.encrypt(plaintext);
		expect(encrypted1).not.toBe(encrypted2);
	});

	it('same key produces consistent decryption', async () => {
		const provider1 = createAesGcmProvider(testPrivateKey);
		const provider2 = createAesGcmProvider(testPrivateKey);
		const plaintext = 'consistent';
		const encrypted = await provider1.encrypt(plaintext);
		const decrypted = await provider2.decrypt(encrypted);
		expect(decrypted).toBe(plaintext);
	});

	it('different keys cannot decrypt each other', async () => {
		const provider1 = createAesGcmProvider(testPrivateKey);
		const provider2 = createAesGcmProvider(
			'0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
		);
		const encrypted = await provider1.encrypt('secret');
		await expect(provider2.decrypt(encrypted)).rejects.toThrow();
	});

	it('handles JSON data', async () => {
		const provider = createAesGcmProvider(testPrivateKey);
		const data = JSON.stringify({user: 'test', count: 42});
		const encrypted = await provider.encrypt(data);
		const decrypted = await provider.decrypt(encrypted);
		expect(JSON.parse(decrypted)).toEqual({user: 'test', count: 42});
	});

	it('handles empty string', async () => {
		const provider = createAesGcmProvider(testPrivateKey);
		const encrypted = await provider.encrypt('');
		const decrypted = await provider.decrypt(encrypted);
		expect(decrypted).toBe('');
	});

	it('handles unicode', async () => {
		const provider = createAesGcmProvider(testPrivateKey);
		const text = '你好世界 🌍 γειά σου κόσμε';
		const encrypted = await provider.encrypt(text);
		const decrypted = await provider.decrypt(encrypted);
		expect(decrypted).toBe(text);
	});
});

describe('wrapWithEncryption', () => {
	const testPrivateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as const;

	describe('without encryption', () => {
		it('preserves sync behavior of base serializer', () => {
			const serializer = wrapWithEncryption(createJsonSerializer());
			const data = {value: 42};
			const result = serializer.serialize(data);
			expect(result).not.toBeInstanceOf(Promise);
			expect(result).toBe('{"value":42}');
		});

		it('deserializes plain data', () => {
			const serializer = wrapWithEncryption(createJsonSerializer<{value: number}>());
			const result = serializer.deserialize('{"value":42}');
			expect(result).not.toBeInstanceOf(Promise);
			expect(result).toEqual({value: 42});
		});

		it('throws EncryptedDataError on encrypted data', () => {
			const serializer = wrapWithEncryption(createJsonSerializer());
			expect(() => serializer.deserialize('enc:...')).toThrow(EncryptedDataError);
		});

		it('EncryptedDataError has correct properties', () => {
			const serializer = wrapWithEncryption(createJsonSerializer());
			try {
				serializer.deserialize('enc:abc');
			} catch (e) {
				expect(e).toBeInstanceOf(EncryptedDataError);
				expect((e as Error).name).toBe('EncryptedDataError');
				expect((e as Error).message).toBe('Cannot load encrypted data without encryption key');
			}
		});
	});

	describe('with encryption', () => {
		it('adds prefix and encrypts', async () => {
			const provider = createAesGcmProvider(testPrivateKey);
			const serializer = wrapWithEncryption(createJsonSerializer<{value: number}>(), provider);

			const data = {value: 42};
			const serialized = await serializer.serialize(data);

			expect(serialized.startsWith('enc:')).toBe(true);
			expect(serialized).not.toContain('value');

			const deserialized = await serializer.deserialize(serialized);
			expect(deserialized).toEqual(data);
		});

		it('can read plain data (migration-friendly)', async () => {
			const provider = createAesGcmProvider(testPrivateKey);
			const serializer = wrapWithEncryption(createJsonSerializer<{migrated: boolean}>(), provider);

			// Plain JSON (not encrypted)
			const plainData = JSON.stringify({migrated: true});
			const deserialized = await serializer.deserialize(plainData);

			expect(deserialized).toEqual({migrated: true});
		});

		it('handles complex nested objects', async () => {
			const provider = createAesGcmProvider(testPrivateKey);
			const serializer = wrapWithEncryption(
				createJsonSerializer<{
					user: {name: string; settings: {theme: string}};
					items: number[];
				}>(),
				provider,
			);

			const data = {
				user: {name: 'Alice', settings: {theme: 'dark'}},
				items: [1, 2, 3],
			};

			const serialized = await serializer.serialize(data);
			const deserialized = await serializer.deserialize(serialized);
			expect(deserialized).toEqual(data);
		});
	});
});
