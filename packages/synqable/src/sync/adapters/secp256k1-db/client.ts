/**
 * secp256k1-db JSON-RPC Client
 *
 * Handles communication with the secp256k1-db service.
 */

import type {
	JsonRpcRequest,
	JsonRpcResponse,
	GetStringResult,
	PutStringResult,
	Secp256k1DBConfig,
} from './types.js';
import type {Schema} from '../../../main/types.js';

export class Secp256k1DBClient {
	private readonly endpoint: string;
	private readonly fetch: typeof globalThis.fetch;
	private readonly timeoutMs: number;
	private requestId = 0;

	constructor(config: Pick<Secp256k1DBConfig<Schema>, 'endpoint' | 'fetch' | 'timeoutMs'>) {
		this.endpoint = config.endpoint;
		this.fetch = config.fetch ?? globalThis.fetch;
		this.timeoutMs = config.timeoutMs ?? 30000;
	}

	async getString(address: string, namespace: string): Promise<GetStringResult> {
		const response = await this.rpc<GetStringResult>('wallet_getString', [address, namespace]);
		return response;
	}

	async putString(
		address: string,
		namespace: string,
		counter: string,
		data: string,
		signature: string,
	): Promise<PutStringResult> {
		const response = await this.rpc<PutStringResult>('wallet_putString', [
			address,
			namespace,
			counter,
			data,
			signature,
		]);
		return response;
	}

	private async rpc<T>(method: string, params: unknown[]): Promise<T> {
		const request: JsonRpcRequest = {
			jsonrpc: '2.0',
			method,
			params,
			id: ++this.requestId,
		};

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			const response = await this.fetch(this.endpoint, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(request),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const json: JsonRpcResponse<T> = await response.json();

			if (json.error && !json.result) {
				throw new Error(json.error);
			}

			return json.result as T;
		} finally {
			clearTimeout(timeoutId);
		}
	}
}
