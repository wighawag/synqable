import {describe, it, expect, vi, beforeEach} from 'vitest';
import {
	createSyncableStore,
	defineSchema,
	permanent,
	map,
	type AsyncStorage,
	type InternalStorage,
	type PullResponse,
	type PushResponse,
	type SyncAdapter,
	type SyncStatus,
	type StorageStatus,
	type StateEvent,
	type StoreLifecycleState,
	type DataOf,
} from '../src/index.js';

// Test schema with volume for more complex testing
const schema = defineSchema({
	settings: permanent<{theme: string; volume: number}>(),
	operations: map<{tx: string; status: string}>(),
});

type TestSchema = typeof schema;

function createMockStorage(): AsyncStorage<InternalStorage<TestSchema>> & {
	data: Map<string, InternalStorage<TestSchema>>;
} {
	const data = new Map<string, InternalStorage<TestSchema>>();

	return {
		data,
		async load(key) {
			return data.get(key);
		},
		async save(key, value) {
			data.set(key, value);
		},
		async remove(key) {
			data.delete(key);
		},
		async exists(key) {
			return data.has(key);
		},
	};
}

// Helper to create a mock sync adapter
function createMockSyncAdapter(options?: {
	onPull?: () => Promise<PullResponse<TestSchema>>;
	onPush?: (
		account: `0x${string}`,
		data: InternalStorage<TestSchema>,
		counter: bigint,
	) => Promise<PushResponse>;
	pullCount?: {value: number};
	pushCount?: {value: number};
}): SyncAdapter<TestSchema> {
	const {
		onPull = async () => ({success: true as const, data: null, counter: 0n}),
		onPush = async () => ({success: true as const}),
		pullCount,
		pushCount,
	} = options ?? {};

	return {
		async pull(account: `0x${string}`) {
			if (pullCount) pullCount.value++;
			return onPull();
		},
		async push(account: `0x${string}`, data: InternalStorage<TestSchema>, counter: bigint) {
			if (pushCount) pushCount.value++;
			return onPush(account, data, counter);
		},
	};
}

describe('createSyncableStore', () => {
	let storage: ReturnType<typeof createMockStorage>;
	let clock: number;

	beforeEach(() => {
		storage = createMockStorage();
		clock = 1000;
	});

	it('starts in idle state', () => {
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => storage, key: 'test-key'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});

		expect(store.get().status).toBe('idle');
	});

	it('transitions to ready state after load', async () => {
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => storage, key: 'test-key'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});

		await store.load();

		expect(store.get().status).toBe('ready');
		expect(store.get().account).toBe('0x1234567890123456789012345678901234567890');
	});

	it('returns account it was bound to', () => {
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => storage, key: 'test-key'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});

		expect(store.account).toBe('0x1234567890123456789012345678901234567890');
	});

	it('sets permanent field value', async () => {
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => storage, key: 'test-key'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});

		await store.load();
		store.set('settings', {theme: 'light', volume: 0.8});

		const state = store.get();
		if (state.status === 'ready') {
			expect(state.data.settings.theme).toBe('light');
			expect(state.data.settings.volume).toBe(0.8);
		} else {
			expect.fail('Store should be ready');
		}
	});

	it('adds item to map field with deleteAt', async () => {
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => storage, key: 'test-key'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});

		await store.load();
		store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

		const state = store.get();
		if (state.status === 'ready') {
			expect(state.data.operations['op-1']).toBeDefined();
			expect(state.data.operations['op-1'].tx).toBe('0xabc');
			expect(state.data.operations['op-1'].status).toBe('pending');
			expect(state.data.operations['op-1'].deleteAt).toBe(9999);
		} else {
			expect.fail('Store should be ready');
		}
	});

	it('updates existing map item', async () => {
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => storage, key: 'test-key'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});

		await store.load();
		store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});
		clock = 2000; // Advance clock
		store.setItem('operations', 'op-1', {tx: '0xabc', status: 'confirmed'});

		const state = store.get();
		if (state.status === 'ready') {
			expect(state.data.operations['op-1'].status).toBe('confirmed');
			// deleteAt should be preserved
			expect(state.data.operations['op-1'].deleteAt).toBe(9999);
		} else {
			expect.fail('Store should be ready');
		}
	});

	it('removes map item by creating tombstone', async () => {
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => storage, key: 'test-key'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});

		await store.load();
		store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});
		store.removeItem('operations', 'op-1');

		const state = store.get();
		if (state.status === 'ready') {
			expect(state.data.operations['op-1']).toBeUndefined();
		} else {
			expect.fail('Store should be ready');
		}
	});

	it('throws when removing non-existent item', async () => {
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => storage, key: 'test-key'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});

		await store.load();

		expect(() => store.removeItem('operations', 'non-existent')).toThrow(
			'Item non-existent does not exist in operations',
		);
	});

	it('throws when updating non-existent item', async () => {
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => storage, key: 'test-key'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});

		await store.load();

		expect(() => {
			store.setItem('operations', 'non-existent', {tx: '0x', status: 'test'});
		}).toThrow('Item non-existent does not exist in operations');
	});

	it('throws when modifying before load', () => {
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => storage, key: 'test-key'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});

		expect(() => {
			store.set('settings', {theme: 'light', volume: 0.9});
		}).toThrow('Store is not ready');
	});

	it('persists data to storage', async () => {
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => storage, key: 'test-key'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});

		await store.load();
		store.set('settings', {theme: 'light', volume: 0.9});
		await store.flush();

		// Check storage
		const saved = storage.data.get('test-key');
		expect(saved).toBeDefined();
		expect(saved?.data.settings.theme).toBe('light');
	});

	it('loads existing data from storage', async () => {
		// Pre-populate storage
		storage.data.set('test-key', {
			$version: 1,
			data: {
				settings: {theme: 'custom', volume: 0.3},
				operations: {
					'existing-op': {tx: '0xdef', status: 'confirmed', deleteAt: 99999},
				},
			},
			$timestamps: {settings: 500},
			$itemTimestamps: {operations: {'existing-op': 400}},
			$tombstones: {operations: {}},
		});

		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => storage, key: 'test-key'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});

		await store.load();

		const state = store.get();
		if (state.status === 'ready') {
			expect(state.data.settings.theme).toBe('custom');
			expect(state.data.operations['existing-op']).toBeDefined();
		} else {
			expect.fail('Store should be ready');
		}
	});

	it('cleans up on stop', async () => {
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => storage, key: 'test-key'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});

		await store.load();

		// Should not throw
		store.stop();
	});

	describe('type-safe events', () => {
		it('emits settings:changed event when permanent field is set', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			let receivedValue: {theme: string; volume: number} | undefined;
			store.on('settings:changed', (value) => {
				receivedValue = value;
			});

			store.set('settings', {theme: 'light', volume: 0.9});

			expect(receivedValue).toEqual({theme: 'light', volume: 0.9});
		});

		it('emits operations:added event when item is added', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			let receivedEvent:
				| {key: string; item: {tx: string; status: string; deleteAt: number}}
				| undefined;
			store.on('operations:added', (event) => {
				receivedEvent = event;
			});

			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			expect(receivedEvent?.key).toBe('op-1');
			expect(receivedEvent?.item.tx).toBe('0xabc');
			expect(receivedEvent?.item.deleteAt).toBe(9999);
		});

		it('emits operations:updated event when item is updated', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			let receivedEvent:
				| {key: string; item: {tx: string; status: string; deleteAt: number}}
				| undefined;
			store.on('operations:updated', (event) => {
				receivedEvent = event;
			});

			store.setItem('operations', 'op-1', {tx: '0xabc', status: 'confirmed'});

			expect(receivedEvent?.key).toBe('op-1');
			expect(receivedEvent?.item.status).toBe('confirmed');
		});

		it('emits operations:removed event when item is removed', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			let receivedEvent:
				| {key: string; item: {tx: string; status: string; deleteAt: number}}
				| undefined;
			store.on('operations:removed', (event) => {
				receivedEvent = event;
			});

			store.removeItem('operations', 'op-1');

			expect(receivedEvent?.key).toBe('op-1');
		});

		it('emits state event with StateEvent (lifecycle signal)', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			const events: StateEvent[] = [];
			store.on('$store:state', (event) => events.push(event));

			await store.load();

			expect(events.length).toBeGreaterThan(0);
			expect(events[events.length - 1].type).toBe('ready');
		});

		it('emits settings:changed event on patch()', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			let receivedValue: {theme: string; volume: number} | undefined;
			store.on('settings:changed', (value) => {
				receivedValue = value;
			});

			store.update('settings', {volume: 0.9});

			expect(receivedValue?.volume).toBe(0.9);
			expect(receivedValue?.theme).toBe('dark'); // original value preserved
		});
	});

	describe('watchItem', () => {
		it('returns undefined when store is not ready', () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			// Store is idle - not loaded
			let itemValue: unknown;
			const itemStore = store.watchItem('operations', 'op-1');
			itemStore.subscribe((v) => (itemValue = v));

			expect(itemValue).toBeUndefined();
		});

		it('returns item value when it exists', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Add an item first
			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			// Get item store and subscribe
			let itemValue: {tx: string; status: string; deleteAt: number} | undefined;
			const itemStore = store.watchItem('operations', 'op-1');
			itemStore.subscribe((v) => (itemValue = v));

			expect(itemValue).toBeDefined();
			expect(itemValue?.tx).toBe('0xabc');
			expect(itemValue?.status).toBe('pending');
			expect(itemValue?.deleteAt).toBe(9999);
		});

		it('updates when item is added', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Subscribe to item store BEFORE adding item
			let itemValue: {tx: string; status: string; deleteAt: number} | undefined;
			const itemStore = store.watchItem('operations', 'op-1');
			itemStore.subscribe((v) => (itemValue = v));

			// Initially undefined
			expect(itemValue).toBeUndefined();

			// Add the item
			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			// Should be updated
			expect(itemValue).toBeDefined();
			expect(itemValue?.tx).toBe('0xabc');
		});

		it('updates when item is updated', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Add an item first
			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			// Subscribe to item store
			let itemValue: {tx: string; status: string; deleteAt: number} | undefined;
			const itemStore = store.watchItem('operations', 'op-1');
			itemStore.subscribe((v) => (itemValue = v));

			expect(itemValue?.status).toBe('pending');

			// Update the item
			clock = 2000;
			store.setItem('operations', 'op-1', {tx: '0xabc', status: 'confirmed'});

			// Should be updated
			expect(itemValue?.status).toBe('confirmed');
		});

		it('returns undefined when item is removed', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Add an item first
			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			// Subscribe to item store
			let itemValue: {tx: string; status: string; deleteAt: number} | undefined;
			const itemStore = store.watchItem('operations', 'op-1');
			itemStore.subscribe((v) => (itemValue = v));

			expect(itemValue).toBeDefined();

			// Remove the item
			store.removeItem('operations', 'op-1');

			// Should be undefined
			expect(itemValue).toBeUndefined();
		});

		it('returns cached store instance for same field/key', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Get item store twice for same key
			const itemStore1 = store.watchItem('operations', 'op-1');
			const itemStore2 = store.watchItem('operations', 'op-1');

			// Should be the same instance
			expect(itemStore1).toBe(itemStore2);

			// Different key should return different instance
			const itemStore3 = store.watchItem('operations', 'op-2');
			expect(itemStore1).not.toBe(itemStore3);
		});
	});

	describe('syncStatus$ and storageStatus$', () => {
		it('syncStatus$ provides current sync status on subscribe', () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			let receivedStatus: SyncStatus | undefined;
			store.syncStatus$.subscribe((status) => {
				receivedStatus = status;
			});

			expect(receivedStatus).toBeDefined();
			expect(receivedStatus?.displayState).toBe('idle');
			expect(receivedStatus?.hasPendingSync).toBe(false);
		});

		it('storageStatus$ provides current storage status on subscribe', () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			let receivedStatus: StorageStatus | undefined;
			store.storageStatus$.subscribe((status) => {
				receivedStatus = status;
			});

			expect(receivedStatus).toBeDefined();
			expect(receivedStatus?.displayState).toBe('idle');
			expect(receivedStatus?.isSaving).toBe(false);
		});

		it('syncStatus$ notifies when syncState changes', async () => {
			let pushResolve: (() => void) | undefined;
			const pushPromise = new Promise<void>((resolve) => {
				pushResolve = resolve;
			});

			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					await pushPromise;
					return {success: true};
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
				sync: {adapterFactory: () => mockSyncAdapter, options: {debounceMs: 10}},
			});

			await store.load();

			// Track status changes
			const statusHistory: string[] = [];
			store.syncStatus$.subscribe((status) => {
				statusHistory.push(status.displayState);
			});

			// Trigger sync by making a change
			store.set('settings', {theme: 'light', volume: 0.8});

			// Wait for sync to start
			await new Promise((r) => setTimeout(r, 50));

			// At this point, sync should be in 'syncing' state
			expect(statusHistory).toContain('syncing');

			// Complete the sync
			pushResolve!();
			await new Promise((r) => setTimeout(r, 20));

			// Should be back to idle
			expect(statusHistory[statusHistory.length - 1]).toBe('idle');
		});

		it('storageStatus$ notifies when storageState changes', async () => {
			// Create a slow storage that we can control
			let saveResolve: (() => void) | undefined;
			const savePromise = new Promise<void>((resolve) => {
				saveResolve = resolve;
			});
			let firstSave = true;

			const slowStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key: string) {
					return storage.data.get(key);
				},
				async save(key: string, value: InternalStorage<TestSchema>) {
					if (!firstSave) {
						await savePromise;
					}
					firstSave = false;
					storage.data.set(key, value);
				},
				async remove(key: string) {
					storage.data.delete(key);
				},
				async exists(key: string) {
					return storage.data.has(key);
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => slowStorage, key: 'test-key', options: {debounceMs: 0}},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Track status changes
			const statusHistory: string[] = [];
			store.storageStatus$.subscribe((status) => {
				statusHistory.push(status.displayState);
			});

			// Trigger storage save by making a change
			store.set('settings', {theme: 'light', volume: 0.8});

			// Give it time to start saving
			await new Promise((r) => setTimeout(r, 10));

			// Should show 'saving' in history
			expect(statusHistory).toContain('saving');

			// Complete the save
			saveResolve!();
			await new Promise((r) => setTimeout(r, 30));

			// Should be back to idle
			expect(statusHistory[statusHistory.length - 1]).toBe('idle');
		});
	});

	describe('flush', () => {
		it('resolves immediately when no pending saves', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// No pending saves - should resolve immediately
			let storageStatusValue: StorageStatus | undefined;
			store.storageStatus$.subscribe((s) => (storageStatusValue = s));
			expect(storageStatusValue?.isSaving).toBe(false);
			await expect(store.flush()).resolves.toBeUndefined();
		});

		it('waits for pending saves to complete', async () => {
			// Create a slow storage that we can control
			let saveResolve: (() => void) | undefined;
			let saveCount = 0;

			const slowStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key: string) {
					return storage.data.get(key);
				},
				async save(key: string, value: InternalStorage<TestSchema>) {
					saveCount++;
					// Make the second save slow (first save is from set(), second save won't happen in this test)
					// But to test flush, we make the FIRST set() save slow
					if (saveCount >= 1) {
						await new Promise<void>((resolve) => {
							saveResolve = resolve;
						});
					}
					storage.data.set(key, value);
				},
				async remove(key: string) {
					storage.data.delete(key);
				},
				async exists(key: string) {
					return storage.data.has(key);
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => slowStorage, key: 'test-key', options: {debounceMs: 0}},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Trigger a save - this will be the first save and will be slow
			store.set('settings', {theme: 'light', volume: 0.8});

			// Wait a moment for the save to start
			await new Promise((r) => setTimeout(r, 10));

			// Should be saving
			let storageStatusValue: StorageStatus | undefined;
			store.storageStatus$.subscribe((s) => (storageStatusValue = s));
			expect(storageStatusValue?.isSaving).toBe(true);

			// Start flush - it should wait
			let flushComplete = false;
			const flushPromise = store.flush().then(() => {
				flushComplete = true;
			});

			// Flush should not be complete yet
			await new Promise((r) => setTimeout(r, 20));
			expect(flushComplete).toBe(false);

			// Complete the save
			saveResolve!();

			// Now flush should complete
			await flushPromise;
			expect(flushComplete).toBe(true);
			expect(storageStatusValue?.isSaving).toBe(false);
		});
	});

	describe('syncNow', () => {
		it('handles no sync adapter gracefully', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Should not throw - just returns without error
			await expect(store.syncNow()).resolves.toBeUndefined();
		});

		it('handles not-ready state gracefully', async () => {
			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					return {success: true};
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
				sync: {adapterFactory: () => mockSyncAdapter},
			});

			// Store is still idle (not loaded)
			expect(store.get().status).toBe('idle');

			// Should not throw - just returns without error
			await expect(store.syncNow()).resolves.toBeUndefined();
		});

		it('bypasses debounce and syncs immediately', async () => {
			let pushCallCount = 0;
			let pushResolve: (() => void) | undefined;

			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					pushCallCount++;
					await new Promise<void>((resolve) => {
						pushResolve = resolve;
					});
					return {success: true};
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
				sync: {adapterFactory: () => mockSyncAdapter, options: {debounceMs: 5000}}, // Long debounce
			});

			await store.load();
			pushCallCount = 0; // Reset after initial sync

			// Make a change (this would normally start a 5 second debounce)
			store.set('settings', {theme: 'light', volume: 0.8});

			// Sync hasn't started yet (debounce not elapsed)
			expect(pushCallCount).toBe(0);

			// Call syncNow - should bypass debounce
			const syncPromise = store.syncNow();

			// Give it a moment to start
			await new Promise((r) => setTimeout(r, 10));

			// Sync should have started immediately
			expect(pushCallCount).toBe(1);

			// Complete the sync
			pushResolve!();
			await syncPromise;
		});
	});

	describe('syncOnVisible', () => {
		it('can be disabled via sync.options.syncOnVisible = false', async () => {
			let pullCallCount = 0;
			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					pullCallCount++;
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					return {success: true};
				},
			};

			// Mock document visibility API
			let visibilityState = 'visible';
			let visibilityHandler: (() => void) | undefined;
			const originalDocument = globalThis.document;

			(globalThis as unknown as {document: unknown}).document = {
				get visibilityState() {
					return visibilityState;
				},
				addEventListener(event: string, handler: () => void) {
					if (event === 'visibilitychange') {
						visibilityHandler = handler;
					}
				},
				removeEventListener() {},
			};

			try {
				const store = createSyncableStore({
					schema,
					account: '0x1234567890123456789012345678901234567890',
					storage: {adapterFactory: () => storage, key: 'test-key'},
					defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
					clock: () => clock,
					sync: {adapterFactory: () => mockSyncAdapter, options: {syncOnVisible: false}}, // Disable syncOnVisible
				});

				await store.load();

				const initialPullCount = pullCallCount;

				// Simulate tab becoming visible
				visibilityState = 'visible';
				visibilityHandler?.();

				await new Promise((r) => setTimeout(r, 20));

				// Should NOT have triggered an additional pull because disabled
				expect(pullCallCount).toBe(initialPullCount);

				store.stop();
			} finally {
				globalThis.document = originalDocument;
			}
		});

		it('triggers pull when tab becomes visible', async () => {
			let pullCallCount = 0;
			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					pullCallCount++;
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					return {success: true};
				},
			};

			// Mock document visibility API
			let visibilityState = 'visible';
			let visibilityHandler: (() => void) | undefined;
			const originalDocument = globalThis.document;

			(globalThis as unknown as {document: unknown}).document = {
				get visibilityState() {
					return visibilityState;
				},
				addEventListener(event: string, handler: () => void) {
					if (event === 'visibilitychange') {
						visibilityHandler = handler;
					}
				},
				removeEventListener() {},
			};

			try {
				const store = createSyncableStore({
					schema,
					account: '0x1234567890123456789012345678901234567890',
					storage: {adapterFactory: () => storage, key: 'test-key'},
					defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
					clock: () => clock,
					sync: {adapterFactory: () => mockSyncAdapter},
				});

				await store.load();

				// Record pull count after initial load
				const initialPullCount = pullCallCount;

				// Simulate tab becoming hidden then visible
				visibilityState = 'hidden';
				visibilityState = 'visible';
				visibilityHandler?.();

				// Wait for async pull to complete
				await new Promise((r) => setTimeout(r, 20));

				// Should have triggered an additional pull
				expect(pullCallCount).toBeGreaterThan(initialPullCount);

				store.stop();
			} finally {
				globalThis.document = originalDocument;
			}
		});
	});

	describe('syncOnReconnect', () => {
		it('triggers push sync when coming back online', async () => {
			let pushCallCount = 0;
			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					pushCallCount++;
					return {success: true};
				},
			};

			// Mock window online/offline events
			let onlineHandler: (() => void) | undefined;
			let offlineHandler: (() => void) | undefined;
			const originalWindow = globalThis.window;

			(globalThis as unknown as {window: unknown}).window = {
				addEventListener(event: string, handler: () => void) {
					if (event === 'online') onlineHandler = handler;
					if (event === 'offline') offlineHandler = handler;
				},
				removeEventListener() {},
			};

			try {
				const store = createSyncableStore({
					schema,
					account: '0x1234567890123456789012345678901234567890',
					storage: {adapterFactory: () => storage, key: 'test-key'},
					defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
					clock: () => clock,
					sync: {adapterFactory: () => mockSyncAdapter, options: {debounceMs: 10}},
				});

				await store.load();

				// Make a local change so there's data to push
				store.set('settings', {theme: 'custom', volume: 0.9});

				const initialPushCount = pushCallCount;

				// Simulate going offline then online
				offlineHandler?.();
				await new Promise((r) => setTimeout(r, 10));
				onlineHandler?.();
				await new Promise((r) => setTimeout(r, 20));

				// Should have triggered a push sync
				expect(pushCallCount).toBeGreaterThan(initialPushCount);

				store.stop();
			} finally {
				globalThis.window = originalWindow;
			}
		});

		it('updates syncState to offline when going offline', async () => {
			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					return {success: true};
				},
			};

			// Mock window online/offline events
			let offlineHandler: (() => void) | undefined;
			const originalWindow = globalThis.window;

			(globalThis as unknown as {window: unknown}).window = {
				addEventListener(event: string, handler: () => void) {
					if (event === 'offline') offlineHandler = handler;
				},
				removeEventListener() {},
			};

			try {
				const store = createSyncableStore({
					schema,
					account: '0x1234567890123456789012345678901234567890',
					storage: {adapterFactory: () => storage, key: 'test-key'},
					defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
					clock: () => clock,
					sync: {adapterFactory: () => mockSyncAdapter},
				});

				await store.load();

				// Track sync status
				let syncStatusValue: SyncStatus | undefined;
				store.syncStatus$.subscribe((s) => (syncStatusValue = s));

				// Initial state should be online and idle
				expect(syncStatusValue?.isOnline).toBe(true);
				expect(syncStatusValue?.displayState).toBe('idle');

				// Simulate going offline
				offlineHandler?.();

				// Status should be offline
				expect(syncStatusValue?.isOnline).toBe(false);
				expect(syncStatusValue?.displayState).toBe('offline');

				store.stop();
			} finally {
				globalThis.window = originalWindow;
			}
		});

		it('can be disabled via sync.options.syncOnReconnect = false', async () => {
			let pushCallCount = 0;
			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					pushCallCount++;
					return {success: true};
				},
			};

			// Mock window online/offline events
			let onlineHandler: (() => void) | undefined;
			const originalWindow = globalThis.window;

			(globalThis as unknown as {window: unknown}).window = {
				addEventListener(event: string, handler: () => void) {
					if (event === 'online') onlineHandler = handler;
				},
				removeEventListener() {},
			};

			try {
				const store = createSyncableStore({
					schema,
					account: '0x1234567890123456789012345678901234567890',
					storage: {adapterFactory: () => storage, key: 'test-key'},
					defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
					clock: () => clock,
					sync: {adapterFactory: () => mockSyncAdapter, options: {syncOnReconnect: false}}, // Disable
				});

				await store.load();

				const initialPushCount = pushCallCount;

				// Simulate coming online
				onlineHandler?.();
				await new Promise((r) => setTimeout(r, 20));

				// Should NOT have triggered a push because disabled
				expect(pushCallCount).toBe(initialPushCount);

				store.stop();
			} finally {
				globalThis.window = originalWindow;
			}
		});
	});

	describe('intervalMs - Periodic Sync', () => {
		it('triggers periodic pull at configured interval', async () => {
			let pullCallCount = 0;
			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					pullCallCount++;
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					return {success: true};
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
				sync: {adapterFactory: () => mockSyncAdapter, options: {intervalMs: 50}}, // Very short interval for testing
			});

			await store.load();

			const initialPullCount = pullCallCount;

			// Wait for two intervals to pass
			await new Promise((r) => setTimeout(r, 120));

			// Should have triggered at least one additional pull
			expect(pullCallCount).toBeGreaterThan(initialPullCount);

			store.stop();
		});

		it('respects 0 to disable periodic sync', async () => {
			let pullCallCount = 0;
			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					pullCallCount++;
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					return {success: true};
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
				sync: {adapterFactory: () => mockSyncAdapter, options: {intervalMs: 0}}, // Disabled
			});

			await store.load();

			const initialPullCount = pullCallCount;

			// Wait for a period
			await new Promise((r) => setTimeout(r, 100));

			// Should NOT have triggered additional pulls (only initial)
			expect(pullCallCount).toBe(initialPullCount);

			store.stop();
		});

		it('cleans up interval timer on stop', async () => {
			let pullCallCount = 0;
			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					pullCallCount++;
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					return {success: true};
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
				sync: {adapterFactory: () => mockSyncAdapter, options: {intervalMs: 50}},
			});

			await store.load();

			// Stop the store
			store.stop();

			const countAfterStop = pullCallCount;

			// Wait for periods to pass
			await new Promise((r) => setTimeout(r, 150));

			// Should NOT have triggered additional pulls after stop
			expect(pullCallCount).toBe(countAfterStop);
		});
	});

	describe('hasPendingSync', () => {
		it('is false when no changes have been made', async () => {
			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					return {success: true};
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
				sync: {adapterFactory: () => mockSyncAdapter},
			});

			await store.load();

			// No changes made - should be false
			let syncStatusValue: SyncStatus | undefined;
			store.syncStatus$.subscribe((s) => (syncStatusValue = s));
			expect(syncStatusValue?.hasPendingSync).toBe(false);
		});

		it('becomes true after a mutation is made', async () => {
			// Use a push that will hang to prevent auto-completion
			let pushResolve: (() => void) | undefined;
			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					await new Promise<void>((resolve) => {
						pushResolve = resolve;
					});
					return {success: true};
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
				sync: {adapterFactory: () => mockSyncAdapter, options: {debounceMs: 5000}}, // Long debounce so sync doesn't complete
			});

			await store.load();
			pushResolve?.(); // Complete initial sync
			await new Promise((r) => setTimeout(r, 10));

			// Track sync status
			let syncStatusValue: SyncStatus | undefined;
			store.syncStatus$.subscribe((s) => (syncStatusValue = s));

			// Initially false
			expect(syncStatusValue?.hasPendingSync).toBe(false);

			// Make a change
			store.set('settings', {theme: 'light', volume: 0.8});

			// Should now be true - we have pending changes
			expect(syncStatusValue?.hasPendingSync).toBe(true);
		});

		it('resets to false after successful sync', async () => {
			let pushResolve: (() => void) | undefined;
			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					await new Promise<void>((resolve) => {
						pushResolve = resolve;
					});
					return {success: true};
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
				sync: {adapterFactory: () => mockSyncAdapter, options: {debounceMs: 10}}, // Short debounce
			});

			await store.load();
			pushResolve?.(); // Complete initial sync
			await new Promise((r) => setTimeout(r, 20));

			// Track sync status
			let syncStatusValue: SyncStatus | undefined;
			store.syncStatus$.subscribe((s) => (syncStatusValue = s));

			// Make a change
			store.set('settings', {theme: 'light', volume: 0.8});
			expect(syncStatusValue?.hasPendingSync).toBe(true);

			// Wait for sync to start
			await new Promise((r) => setTimeout(r, 30));

			// Complete the sync
			pushResolve!();
			await new Promise((r) => setTimeout(r, 20));

			// Should be false after successful sync
			expect(syncStatusValue?.hasPendingSync).toBe(false);
		});

		it('notifies syncStatus$ subscribers when hasPendingSync changes', async () => {
			let pushResolve: (() => void) | undefined;
			const mockSyncAdapter = {
				async pull(): Promise<PullResponse<TestSchema>> {
					return {success: true, data: null, counter: 0n};
				},
				async push(): Promise<PushResponse> {
					await new Promise<void>((resolve) => {
						pushResolve = resolve;
					});
					return {success: true};
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
				sync: {adapterFactory: () => mockSyncAdapter, options: {debounceMs: 10}},
			});

			await store.load();
			pushResolve?.(); // Complete initial sync
			await new Promise((r) => setTimeout(r, 20));

			// Track hasPendingSync changes via syncStatus$
			const pendingHistory: boolean[] = [];
			store.syncStatus$.subscribe((status) => {
				pendingHistory.push(status.hasPendingSync);
			});

			// Clear initial subscription value
			pendingHistory.length = 0;

			// Make a change - should notify with true
			store.set('settings', {theme: 'light', volume: 0.8});

			// Should have notified with true
			expect(pendingHistory).toContain(true);

			// Wait for sync to start and complete
			await new Promise((r) => setTimeout(r, 30));
			pushResolve!();
			await new Promise((r) => setTimeout(r, 20));

			// Should have notified with false
			expect(pendingHistory).toContain(false);
		});
	});

	describe('state transition events', () => {
		it('emits state events during load: loading -> ready', async () => {
			const events: StateEvent[] = [];

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			store.on('$store:state', (event) => events.push(event));

			await store.load();

			// Should have: loading -> ready
			const types = events.map((e) => e.type);
			expect(types).toContain('loading');
			expect(types).toContain('ready');
		});

		it('does NOT emit state event when data is modified (use field events instead)', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			const events: StateEvent[] = [];
			store.on('$store:state', (event) => events.push(event));

			// Clear any events from the initial setup
			events.length = 0;

			store.set('settings', {theme: 'light', volume: 0.8});

			// State event should NOT be emitted on data modifications
			// (use field-level events like 'settings:changed' instead)
			expect(events.length).toBe(0);
		});
	});

	describe('migrations', () => {
		it('runs migrations sequentially when loading data with older version', async () => {
			// Pre-populate storage with version 1 data
			storage.data.set('test-key', {
				$version: 1,
				data: {
					settings: {theme: 'dark', volume: 0.5},
					operations: {},
				},
				$timestamps: {settings: 500},
				$itemTimestamps: {operations: {}},
				$tombstones: {operations: {}},
			});

			// Track migration calls
			const migrationCalls: number[] = [];

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
				schemaVersion: 3, // Target version 3
				migrations: {
					2: (oldData: unknown) => {
						migrationCalls.push(2);
						const data = oldData as InternalStorage<TestSchema>;
						// Migration from v1 to v2
						return {
							...data,
							$version: 2,
							data: {
								...data.data,
								settings: {
									...data.data.settings,
								},
							},
						};
					},
					3: (oldData: unknown) => {
						migrationCalls.push(3);
						const data = oldData as InternalStorage<TestSchema>;
						// Migration from v2 to v3
						return {
							...data,
							$version: 3,
							data: {
								...data.data,
								settings: {
									...data.data.settings,
								},
							},
						};
					},
				},
			});

			await store.load();

			// Verify migrations were called in order
			expect(migrationCalls).toEqual([2, 3]);

			// Verify store is ready
			expect(store.get().status).toBe('ready');
		});

		it('sets error when migration is missing', async () => {
			// Pre-populate storage with version 1 data
			storage.data.set('test-key', {
				$version: 1,
				data: {
					settings: {theme: 'dark', volume: 0.5},
					operations: {},
				},
				$timestamps: {settings: 500},
				$itemTimestamps: {operations: {}},
				$tombstones: {operations: {}},
			});

			// Create store with schemaVersion 3 but only migration for v3 (missing v2)
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
				schemaVersion: 3, // Target version 3
				migrations: {
					// Missing migration for version 2!
					3: (oldData: unknown) => {
						const data = oldData as InternalStorage<TestSchema>;
						return {
							...data,
							$version: 3,
						};
					},
				},
			});

			await store.load();

			// Store should be idle with loadError set
			expect(store.get().status).toBe('idle');
			expect(store.get().isLoading).toBe(false);
			expect(store.get().loadError).toBeDefined();
			expect(store.get().loadError?.message).toBe('Missing migration for version 2');
		});

		it('does not run migrations when schema version matches', async () => {
			// Pre-populate storage with version 3 data (same as target)
			storage.data.set('test-key', {
				$version: 3,
				data: {
					settings: {theme: 'existing', volume: 0.7},
					operations: {},
				},
				$timestamps: {settings: 500},
				$itemTimestamps: {operations: {}},
				$tombstones: {operations: {}},
			});

			const migrationCalls: number[] = [];

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
				schemaVersion: 3,
				migrations: {
					2: () => {
						migrationCalls.push(2);
						return {} as InternalStorage<TestSchema>;
					},
					3: () => {
						migrationCalls.push(3);
						return {} as InternalStorage<TestSchema>;
					},
				},
			});

			await store.load();

			// No migrations should have been called
			expect(migrationCalls).toEqual([]);

			// Store should be ready with existing data
			const state = store.get();
			if (state.status === 'ready') {
				expect(state.data.settings.theme).toBe('existing');
			} else {
				expect.fail('Store should be ready');
			}
		});

		it('uses default data for new storage (no migration needed)', async () => {
			// No pre-existing data in storage
			const migrationCalls: number[] = [];

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'default-theme', volume: 0.5}, operations: {}}),
				clock: () => clock,
				schemaVersion: 3,
				migrations: {
					2: () => {
						migrationCalls.push(2);
						return {} as InternalStorage<TestSchema>;
					},
					3: () => {
						migrationCalls.push(3);
						return {} as InternalStorage<TestSchema>;
					},
				},
			});

			await store.load();

			// No migrations should have been called (new storage uses default)
			expect(migrationCalls).toEqual([]);

			// Store should be ready with default data
			const state = store.get();
			if (state.status === 'ready') {
				expect(state.data.settings.theme).toBe('default-theme');
			} else {
				expect.fail('Store should be ready');
			}
		});
	});

	describe('watchField', () => {
		it('returns undefined when store is not ready (permanent field)', () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			// Store is idle - not loaded
			let fieldValue: unknown;
			const fieldStore = store.watchField('settings');
			fieldStore.subscribe((v) => (fieldValue = v));

			expect(fieldValue).toBeUndefined();
		});

		it('returns current value for permanent field', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			let fieldValue: {theme: string; volume: number} | undefined;
			const fieldStore = store.watchField('settings');
			fieldStore.subscribe((v) => (fieldValue = v));

			expect(fieldValue).toBeDefined();
			expect(fieldValue?.theme).toBe('dark');
			expect(fieldValue?.volume).toBe(0.5);
		});

		it('triggers on set() for permanent field', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			let fieldValue: {theme: string; volume: number} | undefined;
			const fieldStore = store.watchField('settings');
			fieldStore.subscribe((v) => (fieldValue = v));

			// Change the field
			store.set('settings', {theme: 'light', volume: 0.9});

			expect(fieldValue?.theme).toBe('light');
			expect(fieldValue?.volume).toBe(0.9);
		});

		it('triggers on patch() for permanent field', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			let fieldValue: {theme: string; volume: number} | undefined;
			const fieldStore = store.watchField('settings');
			fieldStore.subscribe((v) => (fieldValue = v));

			// Patch the field
			store.update('settings', {volume: 0.9});

			expect(fieldValue?.theme).toBe('dark'); // unchanged
			expect(fieldValue?.volume).toBe(0.9); // patched
		});

		it('returns current value for map field', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Add some items first
			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			let fieldValue: Record<string, {tx: string; status: string; deleteAt: number}> | undefined;
			const fieldStore = store.watchField('operations');
			fieldStore.subscribe((v) => (fieldValue = v as typeof fieldValue));

			expect(fieldValue).toBeDefined();
			expect(Object.keys(fieldValue || {}).length).toBe(1);
			expect(fieldValue?.['op-1']?.tx).toBe('0xabc');
		});

		it('triggers on add() for map field', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			let fieldValue: Record<string, {tx: string; status: string; deleteAt: number}> | undefined;
			const fieldStore = store.watchField('operations');
			fieldStore.subscribe((v) => (fieldValue = v as typeof fieldValue));

			// Initially empty
			expect(Object.keys(fieldValue || {}).length).toBe(0);

			// Add an item
			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			// Should now have the item
			expect(Object.keys(fieldValue || {}).length).toBe(1);
			expect(fieldValue?.['op-1']?.tx).toBe('0xabc');
		});

		it('triggers on remove() for map field', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Add item first
			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			let fieldValue: Record<string, {tx: string; status: string; deleteAt: number}> | undefined;
			const fieldStore = store.watchField('operations');
			fieldStore.subscribe((v) => (fieldValue = v as typeof fieldValue));

			// Has item
			expect(Object.keys(fieldValue || {}).length).toBe(1);

			// Remove it
			store.removeItem('operations', 'op-1');

			// Should be empty
			expect(Object.keys(fieldValue || {}).length).toBe(0);
		});

		it('triggers on update() for map field', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Add item first
			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			let subscribeCallCount = 0;
			let lastValue: Record<string, {tx: string; status: string; deleteAt: number}> | undefined;
			const fieldStore = store.watchField('operations');
			fieldStore.subscribe((v) => {
				subscribeCallCount++;
				lastValue = v as typeof lastValue;
			});

			// Reset count after initial subscription
			subscribeCallCount = 0;

			// Update item
			clock = 2000;
			store.setItem('operations', 'op-1', {tx: '0xabc', status: 'confirmed'});

			// Should have triggered the field store with updated value
			expect(subscribeCallCount).toBe(1);
			expect(lastValue?.['op-1']?.status).toBe('confirmed');
		});

		it('returns cached instance for same field', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Get field store twice
			const fieldStore1 = store.watchField('settings');
			const fieldStore2 = store.watchField('settings');

			// Should be the same instance
			expect(fieldStore1).toBe(fieldStore2);

			// Different field should return different instance
			const fieldStore3 = store.watchField('operations');
			expect(fieldStore1).not.toBe(fieldStore3);
		});
	});

	describe('watchItemIds', () => {
		it('returns empty array when store is not ready', () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			// Store is idle - not loaded
			let ids: string[] | undefined;
			const idsStore = store.watchItemIds('operations');
			idsStore.subscribe((v) => (ids = v));

			expect(ids).toEqual([]);
		});

		it('returns current IDs for map field', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Add some items first
			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});
			store.addItem('operations', 'op-2', {tx: '0xdef', status: 'pending'}, {deleteAt: 9999});

			let ids: string[] | undefined;
			const idsStore = store.watchItemIds('operations');
			idsStore.subscribe((v) => (ids = v));

			expect(ids).toBeDefined();
			expect(ids?.sort()).toEqual(['op-1', 'op-2']);
		});

		it('triggers on add() for map field', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			let ids: string[] | undefined;
			const idsStore = store.watchItemIds('operations');
			idsStore.subscribe((v) => (ids = v));

			// Initially empty
			expect(ids).toEqual([]);

			// Add an item
			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			// Should now have the ID
			expect(ids).toEqual(['op-1']);
		});

		it('triggers on remove() for map field', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Add item first
			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			let ids: string[] | undefined;
			const idsStore = store.watchItemIds('operations');
			idsStore.subscribe((v) => (ids = v));

			// Has ID
			expect(ids).toEqual(['op-1']);

			// Remove it
			store.removeItem('operations', 'op-1');

			// Should be empty
			expect(ids).toEqual([]);
		});

		it('does NOT trigger on update() for map field', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Add item first
			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			let subscribeCallCount = 0;
			const idsStore = store.watchItemIds('operations');
			idsStore.subscribe(() => {
				subscribeCallCount++;
			});

			// Reset count after initial subscription
			subscribeCallCount = 0;

			// Update item
			clock = 2000;
			store.setItem('operations', 'op-1', {tx: '0xabc', status: 'confirmed'});

			// Should NOT have triggered - IDs didn't change
			expect(subscribeCallCount).toBe(0);
		});

		it('returns cached instance for same field', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Get ids store twice
			const idsStore1 = store.watchItemIds('operations');
			const idsStore2 = store.watchItemIds('operations');

			// Should be the same instance
			expect(idsStore1).toBe(idsStore2);
		});
	});

	describe('state$ (lifecycle state)', () => {
		it('triggers on state transitions', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			const states: {status: string; isLoading: boolean}[] = [];
			store.state$.subscribe((state) => states.push({status: state.status, isLoading: state.isLoading}));

			// Clear initial subscription
			states.length = 0;

			// Trigger state transitions
			await store.load();

			// Should have loading (isLoading: true) -> ready (isLoading: false) transitions
			expect(states.some((s) => s.isLoading === true)).toBe(true);
			expect(states.some((s) => s.status === 'ready' && s.isLoading === false)).toBe(true);
		});

		it('does NOT trigger on permanent field set()', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Track subscription calls after ready state
			let subscriptionCallCount = 0;
			store.state$.subscribe(() => {
				subscriptionCallCount++;
			});

			// Reset count after initial subscription
			subscriptionCallCount = 0;

			// Make a change to permanent field
			store.set('settings', {theme: 'light', volume: 0.8});

			// Should NOT have triggered another subscription call
			expect(subscriptionCallCount).toBe(0);
		});

		it('does NOT trigger on map add/update/remove', async () => {
			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			// Track subscription calls after ready state
			let subscriptionCallCount = 0;
			store.state$.subscribe(() => {
				subscriptionCallCount++;
			});

			// Reset count after initial subscription
			subscriptionCallCount = 0;

			// Add item
			store.addItem('operations', 'op-1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});
			expect(subscriptionCallCount).toBe(0);

			// Update item
			clock = 2000;
			store.setItem('operations', 'op-1', {tx: '0xabc', status: 'confirmed'});
			expect(subscriptionCallCount).toBe(0);

			// Remove item
			store.removeItem('operations', 'op-1');
			expect(subscriptionCallCount).toBe(0);
		});
	});

	describe('SyncAdapter integration', () => {
		it('pulls from server on load', async () => {
			const pullCount = {value: 0};
			const mockAdapter = createMockSyncAdapter({
				pullCount,
				onPull: async () => ({
					success: true,
					data: {
						$version: 1,
						data: {settings: {theme: 'server', volume: 0.7}, operations: {}},
						$timestamps: {settings: 100},
						$itemTimestamps: {operations: {}},
						$tombstones: {operations: {}},
					},
					counter: 1000n,
				}),
			});

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {adapterFactory: () => mockAdapter},
				clock: () => clock,
			});

			await store.load();

			expect(pullCount.value).toBe(1);
		});

		it('merges server response with local state (server wins with higher timestamp)', async () => {
			// Pre-populate storage with local data
			storage.data.set('test-key', {
				$version: 1,
				data: {
					settings: {theme: 'local', volume: 0.5},
					operations: {},
				},
				$timestamps: {settings: 100}, // Local timestamp
				$itemTimestamps: {operations: {}},
				$tombstones: {operations: {}},
			});

			let pushResolve: (() => void) | undefined;
			const mockAdapter = createMockSyncAdapter({
				onPull: async () => ({
					success: true,
					data: {
						$version: 1,
						data: {settings: {theme: 'server', volume: 0.7}, operations: {}},
						$timestamps: {settings: 5000}, // Higher timestamp than local
						$itemTimestamps: {operations: {}},
						$tombstones: {operations: {}},
					},
					counter: 1000n,
				}),
				onPush: async () => {
					await new Promise<void>((resolve) => {
						pushResolve = resolve;
					});
					return {success: true};
				},
			});

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {adapterFactory: () => mockAdapter},
				clock: () => clock,
			});

			await store.load();
			// Wait for sync to complete (pull and merge happen async after load)
			await new Promise((r) => setTimeout(r, 50));
			pushResolve?.();
			await new Promise((r) => setTimeout(r, 20));

			// Server data should win (higher timestamp)
			const state = store.get();
			if (state.status === 'ready') {
				expect(state.data.settings.theme).toBe('server');
				expect(state.data.settings.volume).toBe(0.7);
			} else {
				expect.fail('Store should be ready');
			}
		});

		it('keeps local state when local timestamp is higher', async () => {
			// Pre-populate storage with local data with HIGH timestamp
			storage.data.set('test-key', {
				$version: 1,
				data: {
					settings: {theme: 'local', volume: 0.9},
					operations: {},
				},
				$timestamps: {settings: 10000}, // Higher than server
				$itemTimestamps: {operations: {}},
				$tombstones: {operations: {}},
			});

			const mockAdapter = createMockSyncAdapter({
				onPull: async () => ({
					success: true,
					data: {
						$version: 1,
						data: {settings: {theme: 'server', volume: 0.7}, operations: {}},
						$timestamps: {settings: 100}, // Lower timestamp than local
						$itemTimestamps: {operations: {}},
						$tombstones: {operations: {}},
					},
					counter: 1000n,
				}),
			});

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {adapterFactory: () => mockAdapter},
				clock: () => clock,
			});

			await store.load();

			// Local data should win (higher timestamp)
			const state = store.get();
			if (state.status === 'ready') {
				expect(state.data.settings.theme).toBe('local');
				expect(state.data.settings.volume).toBe(0.9);
			} else {
				expect.fail('Store should be ready');
			}
		});

		it('pushes changes to server after mutation', async () => {
			const pushCount = {value: 0};
			const mockAdapter = createMockSyncAdapter({
				pushCount,
			});

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {adapterFactory: () => mockAdapter, options: {debounceMs: 10}}, // Short debounce for testing
				clock: () => clock,
			});

			await store.load();
			const initialPushCount = pushCount.value;

			store.set('settings', {theme: 'light', volume: 0.9});

			// Wait for debounce
			await new Promise((r) => setTimeout(r, 50));

			expect(pushCount.value).toBeGreaterThan(initialPushCount);
		});
	});

	describe('sync events', () => {
		it('emits sync started event when sync begins', async () => {
			let pushResolve: (() => void) | undefined;

			const mockAdapter = createMockSyncAdapter({
				onPush: async () => {
					// Simulate network delay
					await new Promise<void>((resolve) => {
						pushResolve = resolve;
					});
					return {success: true};
				},
			});

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {adapterFactory: () => mockAdapter, options: {debounceMs: 10}},
				clock: () => clock,
			});

			await store.load();
			pushResolve?.(); // Complete initial sync
			await new Promise((r) => setTimeout(r, 20));

			const syncEvents: {type: string}[] = [];
			store.on('$store:sync', (e) => syncEvents.push(e));

			store.set('settings', {theme: 'light', volume: 0.9});

			// Wait for debounce to trigger and sync to start
			await new Promise((r) => setTimeout(r, 30));

			expect(syncEvents.some((e) => e.type === 'started')).toBe(true);

			// Complete the sync
			pushResolve!();
			await new Promise((r) => setTimeout(r, 20));
		});

		it('emits sync completed event when sync succeeds', async () => {
			let pushResolve: (() => void) | undefined;

			const mockAdapter = createMockSyncAdapter({
				onPush: async () => {
					await new Promise<void>((resolve) => {
						pushResolve = resolve;
					});
					return {success: true};
				},
			});

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {adapterFactory: () => mockAdapter, options: {debounceMs: 10}},
				clock: () => clock,
			});

			await store.load();
			pushResolve?.(); // Complete initial sync
			await new Promise((r) => setTimeout(r, 20));

			const syncEvents: {type: string; timestamp?: number}[] = [];
			store.on('$store:sync', (e) => syncEvents.push(e));

			store.set('settings', {theme: 'light', volume: 0.9});

			// Wait for debounce and sync to start
			await new Promise((r) => setTimeout(r, 30));

			// Complete the sync
			pushResolve!();
			await new Promise((r) => setTimeout(r, 30));

			expect(syncEvents.some((e) => e.type === 'completed')).toBe(true);
			const completedEvent = syncEvents.find((e) => e.type === 'completed');
			expect(completedEvent?.timestamp).toBeDefined();
		});

		it('emits sync failed event when push fails', async () => {
			const mockAdapter = createMockSyncAdapter({
				onPush: async () => {
					throw new Error('Network error');
				},
			});

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {adapterFactory: () => mockAdapter, options: {debounceMs: 10, maxRetries: 0}}, // No retries for this test
				clock: () => clock,
			});

			await store.load();

			const syncEvents: {type: string; error?: Error}[] = [];
			store.on('$store:sync', (e) => syncEvents.push(e));

			store.set('settings', {theme: 'light', volume: 0.9});

			// Wait for debounce and sync to fail
			await new Promise((r) => setTimeout(r, 50));

			expect(syncEvents.some((e) => e.type === 'failed')).toBe(true);
			const failedEvent = syncEvents.find((e) => e.type === 'failed');
			expect((failedEvent?.error as Error)?.message).toBe('Network error');
		});

		it('updates store syncStatus isSyncing during sync', async () => {
			let isSyncingWhilePushing: boolean | undefined;
			let syncDisplayStateWhilePushing: string | undefined;
			let pushResolve: (() => void) | undefined;

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {
					adapterFactory: () => ({
						async pull() {
							return {success: true, data: null, counter: 0n};
						},
						async push() {
							// Capture sync status during push
							let syncStatus: SyncStatus | undefined;
							store.syncStatus$.subscribe((s) => (syncStatus = s))();
							isSyncingWhilePushing = syncStatus?.isSyncing;
							syncDisplayStateWhilePushing = syncStatus?.displayState;

							await new Promise<void>((resolve) => {
								pushResolve = resolve;
							});
							return {success: true};
						},
					}),
					options: {debounceMs: 10},
				},
				clock: () => clock,
			});

			await store.load();
			pushResolve?.(); // Complete initial sync
			await new Promise((r) => setTimeout(r, 20));

			store.set('settings', {theme: 'light', volume: 0.9});

			// Wait for debounce and sync to start
			await new Promise((r) => setTimeout(r, 30));

			expect(isSyncingWhilePushing).toBe(true);
			expect(syncDisplayStateWhilePushing).toBe('syncing');

			// Complete the sync
			pushResolve!();
			await new Promise((r) => setTimeout(r, 20));

			// Check final sync status
			let finalSyncStatus: SyncStatus | undefined;
			store.syncStatus$.subscribe((s) => (finalSyncStatus = s))();
			expect(finalSyncStatus?.isSyncing).toBe(false);
			expect(finalSyncStatus?.displayState).toBe('idle');
		});

		it('sets syncError on sync status when push fails', async () => {
			const mockAdapter = createMockSyncAdapter({
				onPush: async () => {
					throw new Error('Network failure');
				},
			});

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {adapterFactory: () => mockAdapter, options: {debounceMs: 10, maxRetries: 0}}, // No retries for this test
				clock: () => clock,
			});

			await store.load();

			store.set('settings', {theme: 'light', volume: 0.9});

			// Wait for debounce and sync to fail
			await new Promise((r) => setTimeout(r, 50));

			let syncStatus: SyncStatus | undefined;
			store.syncStatus$.subscribe((s) => (syncStatus = s))();
			expect(syncStatus?.syncError?.message).toBe('Network failure');
		});

		it('updates lastSyncedAt on successful sync', async () => {
			let pushResolve: (() => void) | undefined;

			const mockAdapter = createMockSyncAdapter({
				onPush: async () => {
					await new Promise<void>((resolve) => {
						pushResolve = resolve;
					});
					return {success: true};
				},
			});

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {adapterFactory: () => mockAdapter, options: {debounceMs: 10}},
				clock: () => clock,
			});

			await store.load();
			pushResolve?.(); // Complete initial sync
			await new Promise((r) => setTimeout(r, 20));

			let syncStatus: SyncStatus | undefined;
			store.syncStatus$.subscribe((s) => (syncStatus = s))();

			// Initial lastSyncedAt after first sync should be set
			const initialSyncedAt = syncStatus?.lastSyncedAt;

			store.set('settings', {theme: 'light', volume: 0.9});

			// Wait for sync to start
			await new Promise((r) => setTimeout(r, 30));

			// Complete the sync
			pushResolve!();
			await new Promise((r) => setTimeout(r, 20));

			expect(syncStatus?.lastSyncedAt).not.toBeNull();
			expect(typeof syncStatus?.lastSyncedAt).toBe('number');
			if (initialSyncedAt) {
				expect(syncStatus?.lastSyncedAt).toBeGreaterThanOrEqual(initialSyncedAt);
			}
		});
	});

	describe('sync lifecycle', () => {
		it('debounces rapid changes into single sync', async () => {
			const pushCount = {value: 0};
			let pushResolve: (() => void) | undefined;

			const mockAdapter = createMockSyncAdapter({
				pushCount,
				onPush: async () => {
					await new Promise<void>((resolve) => {
						pushResolve = resolve;
					});
					return {success: true};
				},
			});

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {adapterFactory: () => mockAdapter, options: {debounceMs: 50}},
				clock: () => clock,
			});

			await store.load();
			// Wait for initial sync to start and complete it
			await new Promise((r) => setTimeout(r, 20));
			pushResolve?.();
			await new Promise((r) => setTimeout(r, 20));

			const initialPushCount = pushCount.value;

			// Make 5 rapid changes
			for (let i = 0; i < 5; i++) {
				store.set('settings', {theme: `theme-${i}`, volume: i / 10});
			}

			// Wait for debounce
			await new Promise((r) => setTimeout(r, 100));

			// Complete the sync
			pushResolve?.();
			await new Promise((r) => setTimeout(r, 20));

			// Should only push once (after the initial sync)
			expect(pushCount.value - initialPushCount).toBe(1);
		});
	});

	describe('retry logic', () => {
		it('retries push on failure up to maxRetries', async () => {
			let attempts = 0;
			const mockAdapter: SyncAdapter<TestSchema> = {
				async pull() {
					return {success: true, data: null, counter: 0n};
				},
				async push() {
					attempts++;
					if (attempts < 3) {
						throw new Error('Network error');
					}
					return {success: true};
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {
					adapterFactory: () => mockAdapter,
					options: {debounceMs: 10, maxRetries: 3, retryBackoffMs: 10},
				},
				clock: () => clock,
			});

			await store.load();
			attempts = 0; // Reset after initial sync

			store.set('settings', {theme: 'light', volume: 0.9});

			// Wait for retries (debounce + retries with backoff)
			await new Promise((r) => setTimeout(r, 300));

			// Should have retried and eventually succeeded
			expect(attempts).toBe(3);
		});

		it('stops retrying after maxRetries failures', async () => {
			let attempts = 0;
			const mockAdapter: SyncAdapter<TestSchema> = {
				async pull() {
					return {success: true, data: null, counter: 0n};
				},
				async push() {
					attempts++;
					throw new Error('Persistent error');
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {
					adapterFactory: () => mockAdapter,
					options: {debounceMs: 10, maxRetries: 2, retryBackoffMs: 10},
				},
				clock: () => clock,
			});

			await store.load();
			attempts = 0; // Reset after initial sync

			const syncEvents: {type: string; error?: Error}[] = [];
			store.on('$store:sync', (e) => syncEvents.push(e));

			store.set('settings', {theme: 'light', volume: 0.9});

			// Wait for all retries
			await new Promise((r) => setTimeout(r, 300));

			// Should have tried maxRetries + 1 times (initial + retries)
			expect(attempts).toBe(3); // 1 initial + 2 retries

			// Should have failed event
			expect(syncEvents.some((e) => e.type === 'failed')).toBe(true);

			let syncStatus: SyncStatus | undefined;
			store.syncStatus$.subscribe((s) => (syncStatus = s))();
			expect(syncStatus?.syncError?.message).toBe('Persistent error');
		});

		it('uses exponential backoff between retries', async () => {
			const callTimes: number[] = [];

			const mockAdapter: SyncAdapter<TestSchema> = {
				async pull() {
					return {success: true, data: null, counter: 0n};
				},
				async push() {
					callTimes.push(Date.now());
					throw new Error('Keep failing');
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {
					adapterFactory: () => mockAdapter,
					options: {debounceMs: 10, maxRetries: 3, retryBackoffMs: 20},
				},
				clock: () => clock,
			});

			await store.load();
			callTimes.length = 0; // Clear after initial sync

			store.set('settings', {theme: 'light', volume: 0.9});

			// Wait for all retries (debounce + 3 retries with increasing backoff)
			await new Promise((r) => setTimeout(r, 500));

			// Verify exponential backoff timing
			// Backoffs should be: 20ms (1x), 40ms (2x), 80ms (4x)
			if (callTimes.length >= 3) {
				const gap1 = callTimes[1] - callTimes[0];
				const gap2 = callTimes[2] - callTimes[1];
				// Allow some timing tolerance - second gap should be longer than first
				expect(gap2).toBeGreaterThanOrEqual(gap1 * 1.5);
			}

			store.stop();
		});
	});

	describe('cleanup on stop', () => {
		it('cancels pending sync when stop is called', async () => {
			const pushCount = {value: 0};
			let pushResolve: (() => void) | undefined;

			const mockAdapter = createMockSyncAdapter({
				pushCount,
				onPush: async () => {
					await new Promise<void>((resolve) => {
						pushResolve = resolve;
					});
					return {success: true};
				},
			});

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {adapterFactory: () => mockAdapter, options: {debounceMs: 100}}, // Long debounce
				clock: () => clock,
			});

			await store.load();
			// Wait for initial sync to start and complete it
			await new Promise((r) => setTimeout(r, 20));
			pushResolve?.();
			await new Promise((r) => setTimeout(r, 20));

			const initialPushCount = pushCount.value;

			store.set('settings', {theme: 'light', volume: 0.9});

			// Stop before debounce fires (debounce is 100ms)
			await new Promise((r) => setTimeout(r, 20));
			store.stop();

			// Wait for would-be debounce
			await new Promise((r) => setTimeout(r, 150));

			// Push should not have been called after initial sync (debounce was cancelled)
			expect(pushCount.value).toBe(initialPushCount);
		});
	});

	describe('storage debouncing', () => {
		it('should coalesce rapid saves into single storage write', async () => {
			let saveCallCount = 0;
			let lastSavedData: InternalStorage<TestSchema> | undefined;

			const trackingStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key: string) {
					return storage.data.get(key);
				},
				async save(key: string, value: InternalStorage<TestSchema>) {
					saveCallCount++;
					lastSavedData = value;
					storage.data.set(key, value);
				},
				async remove(key: string) {
					storage.data.delete(key);
				},
				async exists(key: string) {
					return storage.data.has(key);
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {
					adapterFactory: () => trackingStorage,
					key: 'test-key',
					options: {debounceMs: 50},
				},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();
			saveCallCount = 0; // Reset after load

			// Rapid mutations
			store.set('settings', {theme: 'value1', volume: 0.1});
			store.set('settings', {theme: 'value2', volume: 0.2});
			store.set('settings', {theme: 'value3', volume: 0.3});

			// Wait for debounce
			await new Promise((r) => setTimeout(r, 100));
			await store.flush();

			// Should only have saved once with final value
			expect(saveCallCount).toBe(1);
			expect(lastSavedData?.data.settings.theme).toBe('value3');
		});

		it('should batch multiple field changes within debounce window', async () => {
			let saveCallCount = 0;
			let lastSavedData: InternalStorage<TestSchema> | undefined;

			const trackingStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key: string) {
					return storage.data.get(key);
				},
				async save(key: string, value: InternalStorage<TestSchema>) {
					saveCallCount++;
					lastSavedData = value;
					storage.data.set(key, value);
				},
				async remove(key: string) {
					storage.data.delete(key);
				},
				async exists(key: string) {
					return storage.data.has(key);
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {
					adapterFactory: () => trackingStorage,
					key: 'test-key',
					options: {debounceMs: 50},
				},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();
			saveCallCount = 0; // Reset after load

			store.set('settings', {theme: 'newTheme', volume: 0.9});
			store.addItem('operations', 'op1', {tx: '0xabc', status: 'pending'}, {deleteAt: 9999});

			await new Promise((r) => setTimeout(r, 100));
			await store.flush();

			expect(saveCallCount).toBe(1);
			expect(lastSavedData?.data.settings.theme).toBe('newTheme');
			expect(lastSavedData?.data.operations['op1']).toBeDefined();
		});
	});

	describe('storage queue', () => {
		it('should queue save when one is in progress', async () => {
			let saveCallCount = 0;
			let saveResolve: (() => void) | undefined;

			const slowStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key: string) {
					return storage.data.get(key);
				},
				async save(key: string, value: InternalStorage<TestSchema>) {
					saveCallCount++;
					// Make saves slow
					await new Promise<void>((resolve) => {
						saveResolve = resolve;
					});
					storage.data.set(key, value);
				},
				async remove(key: string) {
					storage.data.delete(key);
				},
				async exists(key: string) {
					return storage.data.has(key);
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => slowStorage, key: 'test-key', options: {debounceMs: 0}},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();
			saveResolve?.(); // Complete initial load save if any
			await new Promise((r) => setTimeout(r, 20));
			saveCallCount = 0;

			// First save starts immediately
			store.set('settings', {theme: 'value1', volume: 0.1});

			// Wait for save to start
			await new Promise((r) => setTimeout(r, 20));

			// This should queue while first is in progress (uses internalStorage reference)
			store.set('settings', {theme: 'value2', volume: 0.2});

			// Complete first save - but it will save latest state (value2)
			// because we use internalStorage reference directly
			saveResolve?.();
			await new Promise((r) => setTimeout(r, 50));

			// Complete second save
			saveResolve?.();
			await store.flush();

			// Should have 2 saves: initial + queued
			// Both save the final value because we use internalStorage reference
			// This is correct - CRDT timestamps ensure the latest state is always saved
			expect(saveCallCount).toBe(2);
		});
	});

	describe('immediate save option', () => {
		it('should bypass debounce when immediate=true', async () => {
			let saveCallCount = 0;

			const trackingStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key: string) {
					return storage.data.get(key);
				},
				async save(key: string, value: InternalStorage<TestSchema>) {
					saveCallCount++;
					storage.data.set(key, value);
				},
				async remove(key: string) {
					storage.data.delete(key);
				},
				async exists(key: string) {
					return storage.data.has(key);
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {
					adapterFactory: () => trackingStorage,
					key: 'test-key',
					options: {debounceMs: 1000},
				},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();
			saveCallCount = 0;

			const startTime = Date.now();
			store.set('settings', {theme: 'critical', volume: 0.9}, {immediate: true});
			await store.flush();

			// Should save immediately, not after 1000ms
			expect(Date.now() - startTime).toBeLessThan(100);
			expect(saveCallCount).toBe(1);
		});

		it('should clear pending debounce timer when immediate=true', async () => {
			let saveCallCount = 0;
			let lastSavedTheme: string | undefined;

			const trackingStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key: string) {
					return storage.data.get(key);
				},
				async save(key: string, value: InternalStorage<TestSchema>) {
					saveCallCount++;
					lastSavedTheme = value.data.settings.theme;
					storage.data.set(key, value);
				},
				async remove(key: string) {
					storage.data.delete(key);
				},
				async exists(key: string) {
					return storage.data.has(key);
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {
					adapterFactory: () => trackingStorage,
					key: 'test-key',
					options: {debounceMs: 500},
				},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();
			saveCallCount = 0;

			store.set('settings', {theme: 'debounced', volume: 0.1});
			store.set('settings', {theme: 'immediate', volume: 0.2}, {immediate: true});

			await store.flush();

			// Only immediate save should occur
			expect(saveCallCount).toBe(1);
			expect(lastSavedTheme).toBe('immediate');
		});

		it('should work for all mutation types', async () => {
			let saveCallCount = 0;

			const trackingStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key: string) {
					return storage.data.get(key);
				},
				async save(key: string, value: InternalStorage<TestSchema>) {
					saveCallCount++;
					storage.data.set(key, value);
				},
				async remove(key: string) {
					storage.data.delete(key);
				},
				async exists(key: string) {
					return storage.data.has(key);
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {
					adapterFactory: () => trackingStorage,
					key: 'test-key',
					options: {debounceMs: 1000},
				},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();
			saveCallCount = 0;

			store.update('settings', {volume: 0.9}, {immediate: true});
			await store.flush();
			expect(saveCallCount).toBe(1);

			store.addItem(
				'operations',
				'key1',
				{tx: '0x123', status: 'pending'},
				{deleteAt: 999, immediate: true},
			);
			await store.flush();
			expect(saveCallCount).toBe(2);

			clock = 2000;
			store.setItem('operations', 'key1', {tx: '0x123', status: 'confirmed'}, {immediate: true});
			await store.flush();
			expect(saveCallCount).toBe(3);

			store.removeItem('operations', 'key1', {immediate: true});
			await store.flush();
			expect(saveCallCount).toBe(4);
		});
	});

	describe('sync queue protection', () => {
		it('should prevent concurrent syncs', async () => {
			let concurrentCalls = 0;
			let maxConcurrent = 0;

			const mockAdapter: SyncAdapter<TestSchema> = {
				async pull() {
					concurrentCalls++;
					maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
					await new Promise((r) => setTimeout(r, 100));
					concurrentCalls--;
					return {success: true as const, data: null, counter: 0n};
				},
				async push() {
					concurrentCalls++;
					maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
					await new Promise((r) => setTimeout(r, 100));
					concurrentCalls--;
					return {success: true as const};
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {adapterFactory: () => mockAdapter, options: {debounceMs: 0}},
				clock: () => clock,
			});

			await store.load();
			maxConcurrent = 0;

			// Trigger multiple syncs rapidly
			store.syncNow();
			store.syncNow();
			store.syncNow();

			await new Promise((r) => setTimeout(r, 500));

			// Should never have more than 1 concurrent sync
			expect(maxConcurrent).toBe(1);
		});

		it('should coalesce multiple queued syncs into one', async () => {
			let syncCount = 0;
			let syncResolve: (() => void) | undefined;

			const mockAdapter: SyncAdapter<TestSchema> = {
				async pull() {
					syncCount++;
					await new Promise<void>((resolve) => {
						syncResolve = resolve;
					});
					return {success: true as const, data: null, counter: 0n};
				},
				async push() {
					return {success: true as const};
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {adapterFactory: () => storage, key: 'test-key'},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				sync: {adapterFactory: () => mockAdapter, options: {debounceMs: 0}},
				clock: () => clock,
			});

			await store.load();
			syncResolve?.(); // Complete initial sync
			await new Promise((r) => setTimeout(r, 20));
			syncCount = 0; // Reset after initial load

			// Start sync #1
			store.syncNow();
			await new Promise((r) => setTimeout(r, 20)); // Wait for sync to start

			// Queue multiple syncs while first is in progress
			store.syncNow();
			store.syncNow();
			store.syncNow();

			// Complete first sync
			syncResolve?.();
			await new Promise((r) => setTimeout(r, 20)); // Wait for second sync to start

			// Complete second sync
			syncResolve?.();
			await new Promise((r) => setTimeout(r, 50));

			// Should be exactly 2: original + one queued (others coalesced)
			expect(syncCount).toBe(2);

			store.stop();
		});
	});

	describe('flush with debouncing', () => {
		it('should wait for debounced storage operations', async () => {
			let saveCallCount = 0;

			const trackingStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key: string) {
					return storage.data.get(key);
				},
				async save(key: string, value: InternalStorage<TestSchema>) {
					saveCallCount++;
					storage.data.set(key, value);
				},
				async remove(key: string) {
					storage.data.delete(key);
				},
				async exists(key: string) {
					return storage.data.has(key);
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {
					adapterFactory: () => trackingStorage,
					key: 'test-key',
					options: {debounceMs: 500},
				},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();
			saveCallCount = 0;

			store.set('settings', {theme: 'test', volume: 0.5});

			// Flush should trigger immediate save
			const startTime = Date.now();
			await store.flush();

			expect(Date.now() - startTime).toBeLessThan(100);
			expect(saveCallCount).toBe(1);
		});

		it('should clear debounce timer and save pending data', async () => {
			let lastSavedData: InternalStorage<TestSchema> | undefined;

			const trackingStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key: string) {
					return storage.data.get(key);
				},
				async save(key: string, value: InternalStorage<TestSchema>) {
					lastSavedData = value;
					storage.data.set(key, value);
				},
				async remove(key: string) {
					storage.data.delete(key);
				},
				async exists(key: string) {
					return storage.data.has(key);
				},
			};

			const store = createSyncableStore({
				schema,
				account: '0x1234567890123456789012345678901234567890',
				storage: {
					adapterFactory: () => trackingStorage,
					key: 'test-key',
					options: {debounceMs: 10000},
				},
				defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
				clock: () => clock,
			});

			await store.load();

			store.set('settings', {theme: 'a', volume: 0.1});
			store.set('settings', {theme: 'b', volume: 0.2});
			store.set('settings', {theme: 'c', volume: 0.3});

			// Without flush, would wait 10 seconds
			await store.flush();

			expect(lastSavedData?.data.settings.theme).toBe('c');
			expect(lastSavedData?.data.settings.volume).toBe(0.3);
		});
	});
});
