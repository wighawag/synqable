import {describe, it, expect, beforeEach, vi} from 'vitest';
import {
	createLocalStorageAdapterFactory,
	createLocalStorageAdapter,
} from '../src/storage/LocalStorageAdapter.js';

// Mock localStorage
const localStorageMock = (() => {
	let store: Record<string, string> = {};
	return {
		getItem: vi.fn((key: string) => store[key] ?? null),
		setItem: vi.fn((key: string, value: string) => {
			store[key] = value;
		}),
		removeItem: vi.fn((key: string) => {
			delete store[key];
		}),
		clear: vi.fn(() => {
			store = {};
		}),
		get length() {
			return Object.keys(store).length;
		},
		key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
	};
})();

// Mock window for addEventListener
const windowMock = {
	addEventListener: vi.fn(),
	removeEventListener: vi.fn(),
};

// Set up globals
Object.defineProperty(globalThis, 'localStorage', {
	value: localStorageMock,
	writable: true,
});

Object.defineProperty(globalThis, 'window', {
	value: windowMock,
	writable: true,
});

describe('createLocalStorageAdapterFactory', () => {
	beforeEach(() => {
		localStorageMock.clear();
		vi.clearAllMocks();
	});

	describe('basic operations', () => {
		it('should save and load data', async () => {
			const factory = createLocalStorageAdapterFactory();
			const adapter = factory();

			await adapter.save('test-key', {foo: 'bar'});
			const result = await adapter.load('test-key');

			expect(result).toEqual({foo: 'bar'});
		});

		it('should return undefined for missing key', async () => {
			const factory = createLocalStorageAdapterFactory();
			const adapter = factory();

			const result = await adapter.load('nonexistent');
			expect(result).toBeUndefined();
		});

		it('should remove data', async () => {
			const factory = createLocalStorageAdapterFactory();
			const adapter = factory();

			await adapter.save('remove-key', {data: 'value'});
			expect(await adapter.exists('remove-key')).toBe(true);

			await adapter.remove('remove-key');
			expect(await adapter.exists('remove-key')).toBe(false);
		});

		it('should check if key exists', async () => {
			const factory = createLocalStorageAdapterFactory();
			const adapter = factory();

			expect(await adapter.exists('check-key')).toBe(false);
			await adapter.save('check-key', {data: 'value'});
			expect(await adapter.exists('check-key')).toBe(true);
		});
	});

	describe('shared listener', () => {
		it('multiple adapters from same factory share state', async () => {
			const factory = createLocalStorageAdapterFactory();
			const adapter1 = factory();
			const adapter2 = factory();

			await adapter1.save('shared', {from: 'adapter1'});

			// adapter2 can read what adapter1 wrote
			const result = await adapter2.load('shared');
			expect(result).toEqual({from: 'adapter1'});
		});
	});

	describe('custom serialization', () => {
		it('should use custom serializer (standalone adapter)', async () => {
			// Note: Custom serializers are supported via the standalone createLocalStorageAdapter
			// The factory now accepts encryptionFactory for encryption support
			const customSerializer = {
				serialize: (data: {test: string}) => `custom:${JSON.stringify(data)}`,
				deserialize: (data: string) => JSON.parse(data.replace('custom:', '')) as {test: string},
			};
			const adapter = createLocalStorageAdapter(customSerializer);

			await adapter.save('custom-key', {test: 'value'});

			const raw = localStorage.getItem('custom-key');
			expect(raw).toBe('custom:{"test":"value"}');

			const result = await adapter.load('custom-key');
			expect(result).toEqual({test: 'value'});
		});
	});

	describe('watch functionality', () => {
		it('should have watch method', () => {
			const factory = createLocalStorageAdapterFactory();
			const adapter = factory();

			expect(typeof adapter.watch).toBe('function');
		});

		it('should return unsubscribe function from watch', () => {
			const factory = createLocalStorageAdapterFactory();
			const adapter = factory();

			const unsubscribe = adapter.watch('watch-key', () => {});

			expect(typeof unsubscribe).toBe('function');
			unsubscribe();
		});
	});
});
