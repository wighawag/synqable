/**
 * secp256k1-db Sync Adapter Types
 *
 * Types for the secp256k1-db sync adapter that communicates with
 * Ethereum wallet-based storage service.
 */

import type {Serializer} from '../../../serializer/types.js';
import type {Schema, InternalStorage} from '../../../main/types.js';

/**
 * Signer interface - abstracts wallet signing
 * Works with ethers.js Wallet, viem walletClient, or custom implementations
 */
export interface Secp256k1Signer {
	/**
	 * Sign a message using EIP-191 personal sign
	 * @param message - Plain text message to sign
	 * @returns Signature as 0x-prefixed hex string
	 */
	signMessage(message: string): Promise<`0x${string}`>;
}

/**
 * Configuration for the secp256k1-db sync adapter
 */
export interface Secp256k1DBConfig<S extends Schema> {
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

	/** Optional: Custom fetch implementation for environments without global fetch */
	fetch?: typeof globalThis.fetch;

	/** Optional: Request timeout in milliseconds - default 30000 */
	timeoutMs?: number;
}

/**
 * JSON-RPC request structure
 */
export interface JsonRpcRequest {
	jsonrpc: '2.0';
	method: string;
	params: unknown[];
	id: number;
}

/**
 * JSON-RPC response structure
 */
export interface JsonRpcResponse<T> {
	jsonrpc: '2.0';
	id: number;
	result?: T;
	error?: string;
}

/**
 * Response from wallet_getString
 */
export interface GetStringResult {
	data: string;
	counter: string;
	signature: string;
}

/**
 * Response from wallet_putString
 */
export interface PutStringResult {
	success: boolean;
	currentData?: {
		data: string;
		counter: string;
		signature: string;
	};
}
