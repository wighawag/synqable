import {describe, it, expect, vi, beforeEach} from 'vitest';
import {Secp256k1DBSyncAdapter} from '../src/sync/adapters/secp256k1-db/adapter.js';
import {Secp256k1DBClient} from '../src/sync/adapters/secp256k1-db/client.js';
import type {Secp256k1Signer} from '../src/sync/adapters/secp256k1-db/types.js';
import {fromEthersSigner, fromViemWalletClient} from '../src/sync/adapters/secp256k1-db/signer.js';
import {createSecp256k1DBSyncAdapterFactory} from '../src/sync/adapters/secp256k1-db/index.js';
import {permanent, map} from '../src/main/types.js';

// Test schema
const TestSchema = {
	settings: permanent<{theme: string}>(),
	items: map<{name: string}>(),
};

type TestSchema = typeof TestSchema;

// Mock signer
function createMockSigner(): Secp256k1Signer {
	return {
		signMessage: vi.fn().mockResolvedValue(('0x' + '00'.repeat(65) + '1b') as `0x${string}`),
	};
}

// Mock fetch helper
function createMockFetch(response: unknown) {
	return vi.fn().mockResolvedValue({
		ok: true,
		json: () =>
			Promise.resolve({
				jsonrpc: '2.0',
				id: 1,
				result: response,
			}),
	});
}

// Mock fetch with error
function createMockFetchError(status: number, statusText: string) {
	return vi.fn().mockResolvedValue({
		ok: false,
		status,
		statusText,
	});
}

describe('Secp256k1DBClient', () => {
	it('sends correct JSON-RPC request for getString', async () => {
		const mockFetch = createMockFetch({data: '', counter: '0', signature: ''});
		const client = new Secp256k1DBClient({
			endpoint: 'https://test.example.com',
			fetch: mockFetch,
		});

		await client.getString('0x1234567890123456789012345678901234567890', 'test-ns');

		expect(mockFetch).toHaveBeenCalledWith(
			'https://test.example.com',
			expect.objectContaining({
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: expect.stringContaining('"method":"wallet_getString"'),
			}),
		);

		const callArgs = mockFetch.mock.calls[0];
		const body = JSON.parse(callArgs[1].body);
		expect(body.params).toEqual(['0x1234567890123456789012345678901234567890', 'test-ns']);
	});

	it('sends correct JSON-RPC request for putString', async () => {
		const mockFetch = createMockFetch({success: true});
		const client = new Secp256k1DBClient({
			endpoint: 'https://test.example.com',
			fetch: mockFetch,
		});

		await client.putString(
			'0x1234567890123456789012345678901234567890',
			'test-ns',
			'1000',
			'{"data":"test"}',
			'0xsignature',
		);

		expect(mockFetch).toHaveBeenCalledWith(
			'https://test.example.com',
			expect.objectContaining({
				method: 'POST',
				body: expect.stringContaining('"method":"wallet_putString"'),
			}),
		);

		const callArgs = mockFetch.mock.calls[0];
		const body = JSON.parse(callArgs[1].body);
		expect(body.params).toEqual([
			'0x1234567890123456789012345678901234567890',
			'test-ns',
			'1000',
			'{"data":"test"}',
			'0xsignature',
		]);
	});

	it('throws error on HTTP failure', async () => {
		const mockFetch = createMockFetchError(500, 'Internal Server Error');
		const client = new Secp256k1DBClient({
			endpoint: 'https://test.example.com',
			fetch: mockFetch,
		});

		await expect(
			client.getString('0x1234567890123456789012345678901234567890', 'test-ns'),
		).rejects.toThrow('HTTP 500: Internal Server Error');
	});

	it('throws error on JSON-RPC error', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					jsonrpc: '2.0',
					id: 1,
					error: 'Invalid signature',
				}),
		});
		const client = new Secp256k1DBClient({
			endpoint: 'https://test.example.com',
			fetch: mockFetch,
		});

		await expect(
			client.getString('0x1234567890123456789012345678901234567890', 'test-ns'),
		).rejects.toThrow('Invalid signature');
	});

	it('respects timeout setting', async () => {
		// Mock fetch that checks for AbortSignal and throws when aborted
		const mockFetch = vi.fn().mockImplementation((_url, options) => {
			return new Promise((_, reject) => {
				const signal = options?.signal as AbortSignal | undefined;
				if (signal) {
					signal.addEventListener('abort', () => {
						reject(new DOMException('The operation was aborted.', 'AbortError'));
					});
				}
			});
		});
		const client = new Secp256k1DBClient({
			endpoint: 'https://test.example.com',
			fetch: mockFetch,
			timeoutMs: 50,
		});

		// The abort should be triggered after 50ms
		await expect(
			client.getString('0x1234567890123456789012345678901234567890', 'test-ns'),
		).rejects.toThrow('aborted');
	});
});

describe('Secp256k1DBSyncAdapter', () => {
	const account = '0x1234567890123456789012345678901234567890' as const;

	it('returns null data when server has no data', async () => {
		const mockFetch = createMockFetch({data: '', counter: '0', signature: ''});

		const adapter = new Secp256k1DBSyncAdapter<TestSchema>({
			endpoint: 'https://test.example.com',
			namespace: 'test',
			signer: createMockSigner(),
			fetch: mockFetch,
		});

		const result = await adapter.pull(account);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toBeNull();
			expect(result.counter).toBe(0n);
		}
	});

	it('correctly deserializes data from server', async () => {
		const serverData = {
			$version: 1,
			data: {settings: {theme: 'dark'}, items: {}},
			$timestamps: {settings: 1000},
			$itemTimestamps: {items: {}},
			$tombstones: {items: {}},
		};

		const mockFetch = createMockFetch({
			data: JSON.stringify(serverData),
			counter: '1000',
			signature: '0x...',
		});

		const adapter = new Secp256k1DBSyncAdapter<TestSchema>({
			endpoint: 'https://test.example.com',
			namespace: 'test',
			signer: createMockSigner(),
			fetch: mockFetch,
		});

		const result = await adapter.pull(account);

		expect(result.success).toBe(true);
		if (result.success && result.data) {
			expect(result.data.data.settings.theme).toBe('dark');
			expect(result.counter).toBe(1000n);
		}
	});

	it('returns error on pull failure', async () => {
		const mockFetch = createMockFetchError(500, 'Server Error');

		const adapter = new Secp256k1DBSyncAdapter<TestSchema>({
			endpoint: 'https://test.example.com',
			namespace: 'test',
			signer: createMockSigner(),
			fetch: mockFetch,
		});

		const result = await adapter.pull(account);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toContain('HTTP 500');
		}
	});

	it('signs message with correct format on push', async () => {
		const mockSigner = createMockSigner();
		const mockFetch = createMockFetch({success: true, currentData: {counter: '2000'}});

		const adapter = new Secp256k1DBSyncAdapter<TestSchema>({
			endpoint: 'https://test.example.com',
			namespace: 'my-app',
			signer: mockSigner,
			fetch: mockFetch,
		});

		const data = {
			$version: 1,
			data: {settings: {theme: 'light'}, items: {}},
			$timestamps: {settings: 2000},
			$itemTimestamps: {items: {}},
			$tombstones: {items: {}},
		};

		await adapter.push(account, data, 2000n);

		// Verify signature message format: put:<namespace>:<counter>:<data>
		expect(mockSigner.signMessage).toHaveBeenCalledWith(
			expect.stringMatching(/^put:my-app:2000:\{.*\}$/),
		);
	});

	it('returns success on successful push', async () => {
		const mockFetch = createMockFetch({success: true, currentData: {counter: '2000'}});

		const adapter = new Secp256k1DBSyncAdapter<TestSchema>({
			endpoint: 'https://test.example.com',
			namespace: 'test',
			signer: createMockSigner(),
			fetch: mockFetch,
		});

		const data = {
			$version: 1,
			data: {settings: {theme: 'light'}, items: {}},
			$timestamps: {settings: 2000},
			$itemTimestamps: {items: {}},
			$tombstones: {items: {}},
		};

		const result = await adapter.push(account, data, 2000n);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.currentCounter).toBe(2000n);
		}
	});

	it('returns conflict error when server rejects push', async () => {
		const mockFetch = createMockFetch({
			success: false,
			currentData: {data: '...', counter: '3000', signature: '...'},
		});

		const adapter = new Secp256k1DBSyncAdapter<TestSchema>({
			endpoint: 'https://test.example.com',
			namespace: 'test',
			signer: createMockSigner(),
			fetch: mockFetch,
		});

		const data = {
			$version: 1,
			data: {settings: {theme: 'light'}, items: {}},
			$timestamps: {},
			$itemTimestamps: {items: {}},
			$tombstones: {items: {}},
		};

		const result = await adapter.push(account, data, 2000n);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.currentCounter).toBe(3000n);
			expect(result.error).toContain('counter conflict');
		}
	});

	it('handles network error on push', async () => {
		const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

		const adapter = new Secp256k1DBSyncAdapter<TestSchema>({
			endpoint: 'https://test.example.com',
			namespace: 'test',
			signer: createMockSigner(),
			fetch: mockFetch,
		});

		const data = {
			$version: 1,
			data: {settings: {theme: 'light'}, items: {}},
			$timestamps: {},
			$itemTimestamps: {items: {}},
			$tombstones: {items: {}},
		};

		const result = await adapter.push(account, data, 2000n);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBe('Network error');
		}
	});

	it('works with custom serializer', async () => {
		const mockFetch = createMockFetch({success: true, currentData: {counter: '2000'}});

		// Custom serializer that adds a prefix
		const customSerializer = {
			serialize: (data: unknown) => 'ENCRYPTED:' + JSON.stringify(data),
			deserialize: (data: string) => JSON.parse(data.replace('ENCRYPTED:', '')),
		};

		const adapter = new Secp256k1DBSyncAdapter<TestSchema>({
			endpoint: 'https://test.example.com',
			namespace: 'test',
			signer: createMockSigner(),
			fetch: mockFetch,
			serializer: customSerializer,
		});

		const data = {
			$version: 1,
			data: {settings: {theme: 'light'}, items: {}},
			$timestamps: {settings: 2000},
			$itemTimestamps: {items: {}},
			$tombstones: {items: {}},
		};

		await adapter.push(account, data, 2000n);

		// Check that the serialized data contains our prefix
		const callArgs = mockFetch.mock.calls[0];
		const body = JSON.parse(callArgs[1].body);
		expect(body.params[3]).toMatch(/^ENCRYPTED:/);
	});
});

describe('Signer helpers', () => {
	describe('fromEthersSigner', () => {
		it('creates signer from ethers-like signer', async () => {
			const mockEthersSigner = {
				signMessage: vi.fn().mockResolvedValue('0xabcd1234'),
			};

			const signer = fromEthersSigner(mockEthersSigner);
			const result = await signer.signMessage('test message');

			expect(mockEthersSigner.signMessage).toHaveBeenCalledWith('test message');
			expect(result).toBe('0xabcd1234');
		});
	});

	describe('fromViemWalletClient', () => {
		it('creates signer from viem-like wallet client', async () => {
			const mockWalletClient = {
				signMessage: vi.fn().mockResolvedValue('0xabcd1234' as `0x${string}`),
			};
			const account = '0x1234567890123456789012345678901234567890' as `0x${string}`;

			const signer = fromViemWalletClient(mockWalletClient, account);
			const result = await signer.signMessage('test message');

			expect(mockWalletClient.signMessage).toHaveBeenCalledWith({
				account,
				message: 'test message',
			});
			expect(result).toBe('0xabcd1234');
		});
	});
});

describe('createSecp256k1DBSyncAdapterFactory', () => {
	it('creates a factory function that returns adapter', () => {
		const factory = createSecp256k1DBSyncAdapterFactory<TestSchema>({
			endpoint: 'https://test.example.com',
			namespace: 'test',
			signer: createMockSigner(),
		});

		const adapter = factory();

		expect(adapter).toBeInstanceOf(Secp256k1DBSyncAdapter);
	});

	it('factory returns new adapter instance on each call', () => {
		const factory = createSecp256k1DBSyncAdapterFactory<TestSchema>({
			endpoint: 'https://test.example.com',
			namespace: 'test',
			signer: createMockSigner(),
		});

		const adapter1 = factory();
		const adapter2 = factory();

		expect(adapter1).not.toBe(adapter2);
	});

	it('passes configuration to adapter', async () => {
		const mockFetch = createMockFetch({data: '', counter: '0', signature: ''});
		const mockSigner = createMockSigner();

		const factory = createSecp256k1DBSyncAdapterFactory<TestSchema>({
			endpoint: 'https://custom-endpoint.example.com',
			namespace: 'custom-namespace',
			signer: mockSigner,
			fetch: mockFetch,
			timeoutMs: 5000,
		});

		const adapter = factory();
		await adapter.pull('0x1234567890123456789012345678901234567890');

		expect(mockFetch).toHaveBeenCalledWith(
			'https://custom-endpoint.example.com',
			expect.anything(),
		);
	});
});
