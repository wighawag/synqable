/**
 * secp256k1-db Sync Adapter
 *
 * SyncAdapter implementation for the secp256k1-db service.
 */

import type {Schema, InternalStorage} from '../../../main/types.js';
import type {SyncAdapter, PullResponse, PushResponse} from '../../types.js';
import type {Secp256k1DBConfig, Secp256k1Signer} from './types.js';
import type {Serializer} from '../../../serializer/types.js';
import {createJsonSerializer, isPromise} from '../../../serializer/types.js';
import {Secp256k1DBClient} from './client.js';

export class Secp256k1DBSyncAdapter<S extends Schema> implements SyncAdapter<S> {
	private readonly client: Secp256k1DBClient;
	private readonly namespace: string;
	private readonly signer: Secp256k1Signer;
	private readonly serializer: Serializer<InternalStorage<S>>;

	constructor(config: Secp256k1DBConfig<S>) {
		this.client = new Secp256k1DBClient({
			endpoint: config.endpoint,
			fetch: config.fetch,
			timeoutMs: config.timeoutMs,
		});
		this.namespace = config.namespace;
		this.signer = config.signer;
		this.serializer = config.serializer ?? createJsonSerializer<InternalStorage<S>>();
	}

	async pull(account: `0x${string}`): Promise<PullResponse<S>> {
		try {
			const result = await this.client.getString(account, this.namespace);

			// Empty data case - no data stored yet
			if (!result.data || result.data === '') {
				return {
					success: true,
					data: null,
					counter: BigInt(result.counter || '0'),
				};
			}

			// Deserialize the stored data using the serializer
			const resultOrPromise = this.serializer.deserialize(result.data);
			const data = isPromise(resultOrPromise) ? await resultOrPromise : resultOrPromise;

			if (data === undefined) {
				return {
					success: false,
					error: 'Failed to deserialize server data',
				};
			}

			return {
				success: true,
				data,
				counter: BigInt(result.counter),
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async push(
		account: `0x${string}`,
		data: InternalStorage<S>,
		counter: bigint,
	): Promise<PushResponse> {
		try {
			// Serialize data using the serializer
			const serializeResultOrPromise = this.serializer.serialize(data);
			const dataString = isPromise(serializeResultOrPromise)
				? await serializeResultOrPromise
				: serializeResultOrPromise;

			// Create the message to sign: put:<namespace>:<counter>:<data>
			const message = `put:${this.namespace}:${counter}:${dataString}`;

			// Sign the message
			const signature = await this.signer.signMessage(message);

			// Send to server
			const result = await this.client.putString(
				account,
				this.namespace,
				counter.toString(),
				dataString,
				signature,
			);

			if (result.success) {
				return {
					success: true,
					currentCounter: result.currentData ? BigInt(result.currentData.counter) : counter,
				};
			}

			// Handle conflict - server has newer data
			return {
				success: false,
				currentCounter: result.currentData ? BigInt(result.currentData.counter) : undefined,
				error: 'Server rejected push - counter conflict',
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	// Optional: Real-time subscription support
	// The current secp256k1-db doesn't support WebSockets
	// This could be added in the future
	// subscribe?(...) { }
}
