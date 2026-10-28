import {describe, it, expect} from 'vitest';
import {
	createMultiAccountStore,
	createSyncableStore,
	defineSchema,
	value,
	map,
	type AsyncStorage,
	type InternalStorage,
	type StoreLifecycleState,
} from '../src/index.js';

/**
 * `idle` with no account means exactly "no account connected", and only a
 * multi-account store with no current store produces it. A single-account store
 * knows its account from its config, so its `idle` always carries it.
 */

const schema = defineSchema({
	settings: value<{theme: string}>(),
	operations: map<{tx: string}>(),
});
type Stored = InternalStorage<typeof schema>;

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;

function defaultData() {
	return {settings: {theme: 'dark'}, operations: {}};
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Storage whose loads fail while `failing` is set. */
function createStorage() {
	const data = new Map<string, Stored>();
	const control = {failing: false};
	const storage: AsyncStorage<Stored> = {
		async load(key) {
			if (control.failing) throw new Error('boom');
			return data.get(key);
		},
		async save(key, v) {
			data.set(key, v);
		},
		async remove(key) {
			data.delete(key);
		},
		async exists(key) {
			return data.has(key);
		},
	};
	return {storage, control};
}

function createStore(storage: AsyncStorage<Stored>) {
	return createSyncableStore({
		schema,
		account: A,
		storage: {adapterFactory: () => storage, key: 'k'},
		defaultData,
	});
}

describe('single-account store: idle carries the account', () => {
	it('a fresh store reports its account while idle, through get() and state$', () => {
		const {storage} = createStorage();
		const store = createStore(storage);

		const state = store.get();
		expect(state.status).toBe('idle');
		expect(state.account).toBe(A);

		const states: StoreLifecycleState[] = [];
		const unsubscribe = store.state$.subscribe((s) => states.push(s));
		expect(states).toEqual([{status: 'idle', account: A, isLoading: false, loadError: null}]);
		unsubscribe();
	});

	// retryLoad() resets to idle and calls load(), which moves to loading before
	// anything can observe the reset, so this guards the observable values rather
	// than the reset itself (it was already green before the fix).
	it('retryLoad() after a failed load keeps the account through idle and loading', async () => {
		const {storage, control} = createStorage();
		const store = createStore(storage);

		control.failing = true;
		await store.load();
		expect(store.get().status).toBe('error');
		control.failing = false;

		// Record every value state$ emits, and what get() says at that moment.
		const seen: {status: string; account: string | undefined; getAccount: string | undefined}[] =
			[];
		const unsubscribe = store.state$.subscribe((s) =>
			seen.push({status: s.status, account: s.account, getAccount: store.get().account}),
		);
		seen.length = 0;

		store.retryLoad();
		// Synchronously after retryLoad(): the store is loading, for account A.
		expect(store.get().account).toBe(A);
		expect(store.get().status).toBe('idle');
		expect(store.get().isLoading).toBe(true);

		await tick(10);
		expect(store.get().status).toBe('ready');

		expect(seen.map((s) => s.status)).toEqual(['loading', 'ready']);
		for (const s of seen) {
			expect(s.account).toBe(A);
			expect(s.getAccount).toBe(A);
		}
		unsubscribe();
	});

	it('a load stopped mid-flight leaves idle with the account', async () => {
		const {storage} = createStorage();
		const store = createStore(storage);
		const loading = store.load();
		store.stop();
		await loading;
		expect(store.get().status).toBe('idle');
		expect(store.get().account).toBe(A);
	});
});

type Signer = {owner: `0x${string}`; privateKey: `0x${string}`};

function createSignerAccountStore() {
	let current: Signer | undefined;
	const subscribers = new Set<(v: Signer | undefined) => void>();
	return {
		store: {
			subscribe(cb: (v: Signer | undefined) => void) {
				subscribers.add(cb);
				cb(current);
				return () => subscribers.delete(cb);
			},
		},
		set(v: Signer | undefined) {
			current = v;
			for (const cb of subscribers) cb(v);
		},
		get current() {
			return current;
		},
	};
}

function createAddressAccountStore() {
	let current: `0x${string}` | undefined;
	const subscribers = new Set<(v: `0x${string}` | undefined) => void>();
	return {
		store: {
			subscribe(cb: (v: `0x${string}` | undefined) => void) {
				subscribers.add(cb);
				cb(current);
				return () => subscribers.delete(cb);
			},
		},
		set(v: `0x${string}` | undefined) {
			current = v;
			for (const cb of subscribers) cb(v);
		},
		get current() {
			return current;
		},
	};
}

/**
 * Record every state$ value with the address connected at the moment it was
 * emitted, then check: while connected, every value carries that address; with
 * no account, every value is `idle` with no account.
 */
function expectEveryValueMatchesConnection(
	recorded: {state: StoreLifecycleState; connected: `0x${string}` | undefined}[],
) {
	expect(recorded.length).toBeGreaterThan(0);
	for (const {state, connected} of recorded) {
		if (connected) {
			expect(state, `connected to ${connected}`).toMatchObject({account: connected});
		} else {
			expect(state).toEqual({
				status: 'idle',
				account: undefined,
				isLoading: false,
				loadError: null,
			});
		}
	}
}

describe('multi-account store: idle with no account means no account', () => {
	it('connect, switch address, change private key, disconnect (signer account store)', async () => {
		const {storage} = createStorage();
		const accounts = createSignerAccountStore();
		const multi = createMultiAccountStore({
			schema,
			accountStore: accounts.store,
			factory: (account, privateKey) =>
				createSyncableStore({
					schema,
					account,
					privateKey,
					storage: {adapterFactory: () => storage, key: account},
					defaultData,
				}),
		});

		const recorded: {state: StoreLifecycleState; connected: `0x${string}` | undefined}[] = [];
		const unsubscribe = multi.state$.subscribe((state) =>
			recorded.push({state, connected: accounts.current?.owner}),
		);

		// Before any account.
		expect(recorded.map((r) => r.state)).toEqual([
			{status: 'idle', account: undefined, isLoading: false, loadError: null},
		]);

		// Connect.
		accounts.set({owner: A, privateKey: '0x01'});
		await tick(10);
		expect(multi.get()?.get().status).toBe('ready');

		// Switch to another address.
		accounts.set({owner: B, privateKey: '0x02'});
		await tick(10);
		expect(multi.get()?.get().account).toBe(B);

		// Same address, different private key: a new store for B.
		const before = multi.get();
		const keyChangeStart = recorded.length;
		accounts.set({owner: B, privateKey: '0x03'});
		expect(multi.get()).not.toBe(before);
		await tick(10);
		// The new store passes through idle, loading and ready, all for B.
		expect(recorded.slice(keyChangeStart).map((r) => r.state)).toEqual([
			{status: 'idle', account: B, isLoading: false, loadError: null},
			{status: 'loading', account: B, isLoading: true, loadError: null},
			{status: 'ready', account: B, isLoading: false, loadError: null},
		]);

		// Switch before the previous load finished.
		accounts.set({owner: A, privateKey: '0x04'});
		accounts.set({owner: B, privateKey: '0x05'});
		await tick(10);

		// Disconnect, then reconnect.
		accounts.set(undefined);
		await tick(10);
		accounts.set({owner: A, privateKey: '0x06'});
		await tick(10);

		expectEveryValueMatchesConnection(recorded);
		// A connect or switch passes through the new store's idle WITH its account.
		expect(recorded.some((r) => r.state.status === 'idle' && r.state.account === B)).toBe(true);
		// idle with no account appears only before any account and on disconnect.
		const noAccount = recorded.filter((r) => r.state.account === undefined);
		expect(noAccount.map((r) => r.connected)).toEqual([undefined, undefined]);
		unsubscribe();
	});

	it('connect, switch address, disconnect (address account store)', async () => {
		const {storage} = createStorage();
		const accounts = createAddressAccountStore();
		const multi = createMultiAccountStore({
			schema,
			accountStore: accounts.store,
			factory: (account) =>
				createSyncableStore({
					schema,
					account,
					storage: {adapterFactory: () => storage, key: account},
					defaultData,
				}),
		});

		const recorded: {state: StoreLifecycleState; connected: `0x${string}` | undefined}[] = [];
		const unsubscribe = multi.state$.subscribe((state) =>
			recorded.push({state, connected: accounts.current}),
		);

		accounts.set(A);
		await tick(10);
		accounts.set(B);
		await tick(10);
		accounts.set(undefined);
		await tick(10);

		expectEveryValueMatchesConnection(recorded);
		expect(recorded.at(-1)!.state).toEqual({
			status: 'idle',
			account: undefined,
			isLoading: false,
			loadError: null,
		});
		unsubscribe();
	});
});
