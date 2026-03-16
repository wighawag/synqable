import type {EncryptionProviderFactory, EncryptionProvider} from './types.js';

function hexToBytes(hex: `0x${string}`): ArrayBuffer {
	const hexString = hex.slice(2);
	const bytes = new Uint8Array(hexString.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hexString.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes.buffer as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(base64: string): Uint8Array {
	return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export const createAesGcmProvider: EncryptionProviderFactory = (privateKey): EncryptionProvider => {
	let cryptoKey: CryptoKey | null = null;

	async function getKey(): Promise<CryptoKey> {
		if (cryptoKey) return cryptoKey;
		const keyBuffer = hexToBytes(privateKey);
		const keyMaterial = await crypto.subtle.importKey('raw', keyBuffer, 'HKDF', false, ['deriveKey']);
		cryptoKey = await crypto.subtle.deriveKey(
			{name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('synqable-v1'), info: new TextEncoder().encode('aes-gcm-key')},
			keyMaterial,
			{name: 'AES-GCM', length: 256},
			false,
			['encrypt', 'decrypt'],
		);
		return cryptoKey;
	}

	return {
		async encrypt(data) {
			const key = await getKey();
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, new TextEncoder().encode(data));
			const combined = new Uint8Array(iv.length + ciphertext.byteLength);
			combined.set(iv);
			combined.set(new Uint8Array(ciphertext), iv.length);
			return bytesToBase64(combined);
		},
		async decrypt(encryptedData) {
			const key = await getKey();
			const combined = base64ToBytes(encryptedData);
			const iv = combined.slice(0, 12);
			const ciphertext = combined.slice(12);
			const decrypted = await crypto.subtle.decrypt({name: 'AES-GCM', iv}, key, ciphertext);
			return new TextDecoder().decode(decrypted);
		},
	};
};
