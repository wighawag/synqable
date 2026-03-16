import {describe, it, expect, vi, beforeEach} from 'vitest';
import {
	createMultiAccountStore,
	createSyncableStore,
	defineSchema,
	permanent,
	map,
	type AsyncStorage,
	type InternalStorage,
	type SyncableStore,
	type AccountStore,
	type SyncableStoreFactory,
	type AsyncState,
	type DataOf,
} from '../src/index.js';

// Test schema
const schema = defineSchema({
	settings: permanent<{theme: string}>(),
	operations: map<{tx: string; status: string}>(),
});

type TestSchema = typeof schema;

// Mock account store for testing
function createMockAccountStore(): {
	store: AccountStore;
	setAccount: (account: `0x${string}` | undefined) => void;
	getSubscriberCount: () => number;
} {
	let currentAccount: `0x${string}` | undefined;
	const subscribers = new Set<(account: `0x${string}` | undefined) => void>();

	return {
		store: {
			subscribe(callback) {
				subscribers.add(callback);
				callback(currentAccount);
				return () => subscribers.delete(callback);
			},
		},
		setAccount(account) {
			currentAccount = account;
			for (const cb of subscribers) {
				cb(account);
			}
		},
		getSubscriberCount: () => subscribers.size,
	};
}

// Mock storage adapter
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

// Mock factory for testing
function createMockFactory(storage: AsyncStorage<InternalStorage<TestSchema>>): {
	factory: SyncableStoreFactory<TestSchema>;
	getCreatedStores: () => Map<string, SyncableStore<TestSchema>>;
	getStoppedStores: () => Set<string>;
	getLoadCallCount: () => number;
} {
	const stores = new Map<string, SyncableStore<TestSchema>>();
	const stoppedStores = new Set<string>();
	let loadCallCount = 0;

	return {
		factory: (account) => {
			const store = createSyncableStore({
				schema,
				account,
				storage: {
					adapterFactory: () => storage,
					key: `test-${account}`,
				},
				defaultData: () => ({settings: {theme: 'dark'}, operations: {}}),
			});

			// Wrap load to track calls
			const originalLoad = store.load.bind(store);
			store.load = async () => {
				loadCallCount++;
				return originalLoad();
			};

			// Wrap stop to track calls
			const originalStop = store.stop.bind(store);
			store.stop = () => {
				stoppedStores.add(account);
				originalStop();
			};

			stores.set(account, store);
			return store;
		},
		getCreatedStores: () => stores,
		getStoppedStores: () => stoppedStores,
		getLoadCallCount: () => loadCallCount,
	};
}

describe('createMultiAccountStore', () => {
	let storage: ReturnType<typeof createMockStorage>;
	let mockAccount: ReturnType<typeof createMockAccountStore>;
	let mockFactory: ReturnType<typeof createMockFactory>;

	beforeEach(() => {
		storage = createMockStorage();
		mockAccount = createMockAccountStore();
		mockFactory = createMockFactory(storage);
	});

	describe('lazy initialization', () => {
		it('does not subscribe to account store before first subscriber', () => {
			createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			// No subscribers yet - should not be listening to account store
			expect(mockAccount.getSubscriberCount()).toBe(0);
		});

		it('starts listening to account store on first subscriber', () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			// Subscribe
			const unsubscribe = multiStore.subscribe(() => {});

			// Should now be listening
			expect(mockAccount.getSubscriberCount()).toBe(1);

			unsubscribe();
		});
	});

	describe('cleanup on last subscriber leaving', () => {
		it('stops listening to account store when last subscriber leaves', async () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			// Add two subscribers
			const unsub1 = multiStore.subscribe(() => {});
			const unsub2 = multiStore.subscribe(() => {});

			expect(mockAccount.getSubscriberCount()).toBe(1);

			// Remove first subscriber
			unsub1();
			expect(mockAccount.getSubscriberCount()).toBe(1); // Still listening

			// Remove last subscriber
			unsub2();
			expect(mockAccount.getSubscriberCount()).toBe(0); // Stopped listening
		});

		it('stops current store when last subscriber leaves', async () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			const account = '0x1234567890123456789012345678901234567890' as const;

			// Set account first
			mockAccount.setAccount(account);

			// Subscribe
			const unsubscribe = multiStore.subscribe(() => {});

			// Wait for store to load
			await new Promise((r) => setTimeout(r, 50));

			// Verify store was created
			expect(mockFactory.getCreatedStores().has(account)).toBe(true);

			// Unsubscribe
			unsubscribe();

			// Store should be stopped
			expect(mockFactory.getStoppedStores().has(account)).toBe(true);
		});

		it('resets currentAccount state when last subscriber leaves', async () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			const account = '0x1234567890123456789012345678901234567890' as const;
			mockAccount.setAccount(account);

			// Track currentAccount state
			let currentState: AsyncState<DataOf<TestSchema>> | undefined;
			const unsubCurrentAccount = multiStore.currentAccount.subscribe((state) => {
				currentState = state;
			});

			await new Promise((r) => setTimeout(r, 50));

			// Should be ready with the account
			expect(currentState!.status).toBe('ready');
			if (currentState!.status === 'ready') {
				expect(currentState!.account).toBe(account);
			}

			// Unsubscribe from currentAccount (this is the last subscriber overall)
			unsubCurrentAccount();

			// State should reset to idle when no subscribers
			// Re-subscribe to check - but this will restart the lifecycle
			let newState: AsyncState<DataOf<TestSchema>> | undefined;
			const unsub2 = multiStore.currentAccount.subscribe((state) => {
				newState = state;
			});

			// Initially should get the state (which will trigger a new load)
			// The state will start fresh
			await new Promise((r) => setTimeout(r, 50));
			expect(newState!.status).toBe('ready');

			unsub2();
		});
	});

	describe('basic account switching', () => {
		it('returns null when no account is connected', () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			let receivedStore: SyncableStore<TestSchema> | null = null;
			multiStore.subscribe((store) => {
				receivedStore = store;
			});

			expect(receivedStore).toBeNull();
			expect(multiStore.get()).toBeNull();
		});

		it('creates and loads store when account connects', async () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			let receivedStore: SyncableStore<TestSchema> | null = null;
			multiStore.subscribe((store) => {
				receivedStore = store;
			});

			const account = '0x1234567890123456789012345678901234567890' as const;
			mockAccount.setAccount(account);

			// Wait for async load
			await new Promise((r) => setTimeout(r, 50));

			expect(receivedStore).not.toBeNull();
			expect(receivedStore!.account).toBe(account);
			expect(receivedStore!.get().status).toBe('ready');
		});

		it('stops old store and creates new one when account changes', async () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			multiStore.subscribe(() => {});

			const account1 = '0x1111111111111111111111111111111111111111' as const;
			const account2 = '0x2222222222222222222222222222222222222222' as const;

			// First account
			mockAccount.setAccount(account1);
			await new Promise((r) => setTimeout(r, 50));

			expect(mockFactory.getCreatedStores().has(account1)).toBe(true);

			// Switch to second account
			mockAccount.setAccount(account2);
			await new Promise((r) => setTimeout(r, 50));

			// First store should be stopped
			expect(mockFactory.getStoppedStores().has(account1)).toBe(true);
			// Second store should be created
			expect(mockFactory.getCreatedStores().has(account2)).toBe(true);
		});

		it('notifies with new store immediately during transition', async () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			const storeHistory: (SyncableStore<TestSchema> | null)[] = [];
			multiStore.subscribe((store) => {
				storeHistory.push(store);
			});

			const account1 = '0x1111111111111111111111111111111111111111' as const;
			const account2 = '0x2222222222222222222222222222222222222222' as const;

			mockAccount.setAccount(account1);
			await new Promise((r) => setTimeout(r, 50));

			// Clear history to track transition
			storeHistory.length = 0;

			mockAccount.setAccount(account2);
			// First notification should be the new store in loading state (no null transition)
			expect(storeHistory[0]).not.toBeNull();
			expect(storeHistory[0]?.account).toBe(account2);
			expect(storeHistory[0]?.get().isLoading).toBe(true);

			await new Promise((r) => setTimeout(r, 50));

			// Store should now be ready (same store reference, state changed internally)
			expect(storeHistory[0]?.get().status).toBe('ready');
			expect(storeHistory[0]?.get().isLoading).toBe(false);
		});
	});

	describe('race condition handling', () => {
		it('handles rapid account switches correctly', async () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			let finalStore: SyncableStore<TestSchema> | null = null;
			multiStore.subscribe((store) => {
				finalStore = store;
			});

			// Also track currentAccount state
			let currentState: AsyncState<DataOf<TestSchema>> | undefined;
			multiStore.currentAccount.subscribe((state) => {
				currentState = state;
			});

			const accountA = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as const;
			const accountB = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as const;
			const accountC = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' as const;

			// Rapidly switch accounts
			mockAccount.setAccount(accountA);
			mockAccount.setAccount(accountB);
			mockAccount.setAccount(accountC);

			// Wait for all to settle
			await new Promise((r) => setTimeout(r, 100));

			// Only the last account should be current
			expect(finalStore!.account).toBe(accountC);
			expect(currentState!.status).toBe('ready');
			if (currentState!.status === 'ready') {
				expect(currentState!.account).toBe(accountC);
			}

			// Previous stores should be stopped
			expect(mockFactory.getStoppedStores().has(accountA)).toBe(true);
			expect(mockFactory.getStoppedStores().has(accountB)).toBe(true);
		});

		it('cleans up orphan stores when account changes during load', async () => {
			// Create a slow-loading factory
			const slowStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key) {
					await new Promise((r) => setTimeout(r, 100)); // Slow load
					return storage.data.get(key);
				},
				async save(key, value) {
					storage.data.set(key, value);
				},
				async remove(key) {
					storage.data.delete(key);
				},
				async exists(key) {
					return storage.data.has(key);
				},
			};

			const slowFactory = createMockFactory(slowStorage);

			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: slowFactory.factory,
			});

			multiStore.subscribe(() => {});

			// Track currentAccount state
			let currentState: AsyncState<DataOf<TestSchema>> | undefined;
			multiStore.currentAccount.subscribe((state) => {
				currentState = state;
			});

			const accountA = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as const;
			const accountB = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as const;

			// Start loading account A
			mockAccount.setAccount(accountA);

			// Immediately switch to B while A is still loading
			await new Promise((r) => setTimeout(r, 10));
			mockAccount.setAccount(accountB);

			// Wait for everything to complete
			await new Promise((r) => setTimeout(r, 200));

			// Account A's store should have been stopped (orphan cleanup)
			expect(slowFactory.getStoppedStores().has(accountA)).toBe(true);
			// Account B should be current - check via currentAccount state
			expect(currentState!.status).toBe('ready');
			if (currentState!.status === 'ready') {
				expect(currentState!.account).toBe(accountB);
			}
		});
	});

	describe('store reference capture safety', () => {
		it('captured store reference remains valid after account switch', async () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			multiStore.subscribe(() => {});

			const accountA = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as const;
			const accountB = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as const;

			mockAccount.setAccount(accountA);
			await new Promise((r) => setTimeout(r, 50));

			// Capture reference to account A's store
			const capturedStore = multiStore.get();
			expect(capturedStore?.account).toBe(accountA);

			// Switch to account B
			mockAccount.setAccount(accountB);
			await new Promise((r) => setTimeout(r, 50));

			// The captured reference should STILL point to account A
			// This is intentional for async operation safety
			expect(capturedStore?.account).toBe(accountA);

			// But multiStore.get() should return account B's store
			expect(multiStore.get()?.account).toBe(accountB);
		});
	});

	describe('edge cases', () => {
		it('handles same account emission as no-op', async () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			const notifications: (SyncableStore<TestSchema> | null)[] = [];
			multiStore.subscribe((store) => {
				notifications.push(store);
			});

			const account = '0x1234567890123456789012345678901234567890' as const;
			mockAccount.setAccount(account);
			await new Promise((r) => setTimeout(r, 50));

			const notificationCountAfterFirstSet = notifications.length;

			// Emit same account again
			mockAccount.setAccount(account);
			await new Promise((r) => setTimeout(r, 50));

			// Should NOT have triggered additional notifications
			expect(notifications.length).toBe(notificationCountAfterFirstSet);
			// Should NOT have created a new store
			expect(mockFactory.getLoadCallCount()).toBe(1);
		});

		it('handles all subscribers leaving during load', async () => {
			// Use slow storage to control timing
			const slowStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key) {
					await new Promise((r) => setTimeout(r, 100));
					return storage.data.get(key);
				},
				async save(key, value) {
					storage.data.set(key, value);
				},
				async remove(key) {
					storage.data.delete(key);
				},
				async exists(key) {
					return storage.data.has(key);
				},
			};

			const slowFactory = createMockFactory(slowStorage);

			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: slowFactory.factory,
			});

			const account = '0x1234567890123456789012345678901234567890' as const;
			mockAccount.setAccount(account);

			// Subscribe
			const unsubscribe = multiStore.subscribe(() => {});

			// Wait for load to start
			await new Promise((r) => setTimeout(r, 10));

			// Unsubscribe while loading
			unsubscribe();

			// Wait for load to complete
			await new Promise((r) => setTimeout(r, 150));

			// Store should have been stopped (orphan cleanup)
			expect(slowFactory.getStoppedStores().has(account)).toBe(true);
		});

		// Factory is expected to not throw, so no test for that case

		it('shows error state when load fails', async () => {
			const failingStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load() {
					throw new Error('Storage error');
				},
				async save() {},
				async remove() {},
				async exists() {
					return false;
				},
			};

			const failingFactory = createMockFactory(failingStorage);

			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: failingFactory.factory,
			});

			let receivedStore: SyncableStore<TestSchema> | null = null;
			multiStore.subscribe((store) => {
				receivedStore = store;
			});

			mockAccount.setAccount('0x1234567890123456789012345678901234567890');
			await new Promise((r) => setTimeout(r, 50));

			// Store exists but shows error state (store handles errors internally)
			expect(receivedStore).not.toBeNull();
			expect(receivedStore!.get().status).toBe('idle');
			expect(receivedStore!.get().loadError).toBeDefined();
			expect(receivedStore!.get().loadError?.message).toBe('Storage error');
		});

		it('re-subscribe after all subscribers left works correctly', async () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			const account = '0x1234567890123456789012345678901234567890' as const;
			mockAccount.setAccount(account);

			// First subscription
			const unsub1 = multiStore.subscribe(() => {});
			await new Promise((r) => setTimeout(r, 50));

			// Unsubscribe
			unsub1();

			// Account should be reset
			expect(mockAccount.getSubscriberCount()).toBe(0);

			// Re-subscribe
			let receivedStore: SyncableStore<TestSchema> | null = null;
			const unsub2 = multiStore.subscribe((store) => {
				receivedStore = store;
			});

			await new Promise((r) => setTimeout(r, 50));

			// Should have re-created the store
			expect(receivedStore).not.toBeNull();
			expect(receivedStore!.account).toBe(account);

			unsub2();
		});
	});

	describe('subscriber added during account load', () => {
		it('new subscriber receives store in loading state initially then ready when loaded', async () => {
			const slowStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key) {
					await new Promise((r) => setTimeout(r, 50));
					return storage.data.get(key);
				},
				async save(key, value) {
					storage.data.set(key, value);
				},
				async remove(key) {
					storage.data.delete(key);
				},
				async exists(key) {
					return storage.data.has(key);
				},
			};

			const slowFactory = createMockFactory(slowStorage);

			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: slowFactory.factory,
			});

			const account = '0x1234567890123456789012345678901234567890' as const;
			mockAccount.setAccount(account);

			// First subscriber triggers load
			multiStore.subscribe(() => {});

			// Wait a bit, then add second subscriber during load
			await new Promise((r) => setTimeout(r, 10));

			const receivedStores: (SyncableStore<TestSchema> | null)[] = [];
			multiStore.subscribe((store) => {
				receivedStores.push(store);
			});

			// Should receive store in loading state immediately (no null transition)
			expect(receivedStores[0]).not.toBeNull();
			expect(receivedStores[0]?.account).toBe(account);
			expect(receivedStores[0]?.get().isLoading).toBe(true);

			// Wait for load to complete
			await new Promise((r) => setTimeout(r, 100));

			// Store's internal state should now be ready
			expect(receivedStores[0]?.get().status).toBe('ready');
			expect(receivedStores[0]?.get().isLoading).toBe(false);
		});
	});

	describe('Svelte store contract', () => {
		it('calls callback immediately on subscribe', () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			let callCount = 0;
			multiStore.subscribe(() => {
				callCount++;
			});

			// Should be called immediately (synchronously)
			expect(callCount).toBe(1);
		});

		it('returns unsubscribe function', () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			const unsubscribe = multiStore.subscribe(() => {});

			expect(typeof unsubscribe).toBe('function');
			unsubscribe(); // Should not throw
		});
	});

	describe('get() method', () => {
		it('returns null when no subscribers', () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			mockAccount.setAccount('0x1234567890123456789012345678901234567890');

			// No subscribers - get() should return null
			expect(multiStore.get()).toBeNull();
		});

		it('returns current store when subscribed', async () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			const account = '0x1234567890123456789012345678901234567890' as const;
			mockAccount.setAccount(account);

			multiStore.subscribe(() => {});
			await new Promise((r) => setTimeout(r, 50));

			const store = multiStore.get();
			expect(store).not.toBeNull();
			expect(store?.account).toBe(account);
		});
	});

	describe('currentAccount reactive store', () => {
		it('returns idle state when no account connected', () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			let currentState: AsyncState<DataOf<TestSchema>> | undefined;
			multiStore.currentAccount.subscribe((state) => {
				currentState = state;
			});

			expect(currentState!.status).toBe('idle');
			expect(currentState!.account).toBeUndefined();
		});

		it('returns ready state with data when account connected', async () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			const account = '0x1234567890123456789012345678901234567890' as const;
			mockAccount.setAccount(account);

			let currentState: AsyncState<DataOf<TestSchema>> | undefined;
			multiStore.currentAccount.subscribe((state) => {
				currentState = state;
			});
			await new Promise((r) => setTimeout(r, 50));

			expect(currentState!.status).toBe('ready');
			if (currentState!.status === 'ready') {
				expect(currentState!.account).toBe(account);
				expect(currentState!.data).toBeDefined();
				expect(currentState!.data.settings.theme).toBe('dark');
			}
		});

		it('follows Svelte store contract - calls callback immediately', () => {
			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: mockFactory.factory,
			});

			let callCount = 0;
			multiStore.currentAccount.subscribe(() => {
				callCount++;
			});

			expect(callCount).toBe(1);
		});

		it('transitions from idle to loading to ready', async () => {
			const slowStorage: AsyncStorage<InternalStorage<TestSchema>> = {
				async load(key) {
					await new Promise((r) => setTimeout(r, 50));
					return storage.data.get(key);
				},
				async save(key, value) {
					storage.data.set(key, value);
				},
				async remove(key) {
					storage.data.delete(key);
				},
				async exists(key) {
					return storage.data.has(key);
				},
			};

			const slowFactory = createMockFactory(slowStorage);

			const multiStore = createMultiAccountStore({
				accountStore: mockAccount.store,
				factory: slowFactory.factory,
			});

			const states: AsyncState<DataOf<TestSchema>>[] = [];
			multiStore.currentAccount.subscribe((state) => {
				states.push(state);
			});

			// Should start idle
			expect(states[0].status).toBe('idle');

			const account = '0x1234567890123456789012345678901234567890' as const;
			mockAccount.setAccount(account);

			// Should transition to loading
			await new Promise((r) => setTimeout(r, 10));
			const loadingState = states[states.length - 1];
			expect(loadingState.isLoading).toBe(true);

			// Should transition to ready
			await new Promise((r) => setTimeout(r, 100));
			const readyState = states[states.length - 1];
			expect(readyState.status).toBe('ready');
			expect(readyState.isLoading).toBe(false);
		});
	});
});
