export interface EncryptionProvider {
	encrypt(data: string): Promise<string>;
	decrypt(encryptedData: string): Promise<string>;
}

export type EncryptionProviderFactory = (privateKey: `0x${string}`) => EncryptionProvider;

export const ENCRYPTED_PREFIX = 'enc:';

export function isEncrypted(data: string): boolean {
	return data.startsWith(ENCRYPTED_PREFIX);
}

export class EncryptedDataError extends Error {
	constructor(message = 'Cannot load encrypted data without encryption key') {
		super(message);
		this.name = 'EncryptedDataError';
	}
}
