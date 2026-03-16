/**
 * secp256k1-db Signer Utilities
 *
 * Helper functions to create signers from various Ethereum wallet implementations.
 */

import type {Secp256k1Signer} from './types.js';

/**
 * Create a signer from an ethers.js Wallet or Signer
 */
export function fromEthersSigner(signer: {
	signMessage(message: string | Uint8Array): Promise<string>;
}): Secp256k1Signer {
	return {
		signMessage: async (message: string) => {
			const sig = await signer.signMessage(message);
			return sig as `0x${string}`;
		},
	};
}

/**
 * Create a signer from a viem WalletClient
 */
export function fromViemWalletClient(
	walletClient: {
		signMessage(args: {account: `0x${string}`; message: string}): Promise<`0x${string}`>;
	},
	account: `0x${string}`,
): Secp256k1Signer {
	return {
		signMessage: async (message: string) => {
			return walletClient.signMessage({account, message});
		},
	};
}

/**
 * Create a signer from a raw private key using viem
 * Note: This is a convenience helper - in production, prefer wallet-based signing
 */
export async function fromPrivateKey(privateKey: `0x${string}`): Promise<Secp256k1Signer> {
	// Dynamic import to avoid bundling viem if not used
	const {privateKeyToAccount} = await import('viem/accounts');
	const account = privateKeyToAccount(privateKey);

	return {
		signMessage: async (message: string) => {
			return account.signMessage({message});
		},
	};
}

/**
 * Create a signer from a raw private key (sync factory, lazy initialization).
 *
 * This is a sync wrapper around viem's account creation that defers
 * the actual initialization to the first signMessage call.
 *
 * @param privateKey - The private key as a hex string
 * @returns A Secp256k1Signer that will initialize lazily
 */
export function createPrivateKeySigner(privateKey: `0x${string}`): Secp256k1Signer {
	// Cache the account after first initialization
	let cachedAccount: {signMessage: (args: {message: string}) => Promise<`0x${string}`>} | null =
		null;

	return {
		signMessage: async (message: string) => {
			if (!cachedAccount) {
				// Dynamic import to avoid bundling viem if not used
				const {privateKeyToAccount} = await import('viem/accounts');
				cachedAccount = privateKeyToAccount(privateKey);
			}
			return cachedAccount.signMessage({message});
		},
	};
}
