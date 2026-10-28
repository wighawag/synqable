import {describe, it, expect, beforeEach} from 'vitest';
import {
	createMultiAccountStore,
	createSyncableStore,
	defineSchema,
	value,
	map,
	StoreUnavailableError,
	type AccountStore,
	type AsyncStorage,
	type InternalStorage,
	type StateEvent,
	type StoreLifecycleState,
	type SyncAdapter,
	type WatchableStorage,
} from '../src/index.js';

const schema = defineSchema({
	settings: value<{theme: string}>(),
	operations: map<{tx: string}>(),
});
type TestSchema = typeof schema;
type Stored = InternalStorage<TestSchema>;

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;

function defaultData() {
	return {settings: {theme: 'dark'}, operations: {}};
}

/**
 * Storage whose loads are held until released, so a test can act while a store
 * is loading. Every save is recorded. `watch` is recorded too, to prove a
 * stopped load installs no listeners.
 */
function createGatedStorage() {
	const data = new Map<string, Stored>();
	const saves: {key: string; value: Stored}[] = [];
	const pending: {key: string; resolve: () => void; reject: (e: Error) => void}[] = [];
	let watchCalls = 0;
	let gated = true;

	const storage: AsyncStorage<Stored> & WatchableStorage<Stored> = {
		load(key) {
			if (!gated)
				return Promise.resolve(data.has(key) ? structuredClone(data.get(key)) : undefined);
			return new Promise<Stored | undefined>((resolve, reject) => {
				pending.push({
					key,
					resolve: () => resolve(data.has(key) ? structuredClone(data.get(key)) : undefined),
					reject,
				});
			});
		},
		async save(key, value) {
			const copy = structuredClone(value);
			data.set(key, copy);
			saves.push({key, value: copy});
		},
		async remove(key) {
			data.delete(key);
		},
		async exists(key) {
			return data.has(key);
		},
		watch() {
			watchCalls++;
			return () => {};
		},
	};

	return {
		storage,
		data,
		saves,
		get watchCalls() {
			return watchCalls;
		},
		ungate() {
			gated = false;
		},
		/** Release the oldest pending load. */
		release() {
			const next = pending.shift();
			if (!next) throw new Error('no pending load');
			next.resolve();
		},
		/** Fail the oldest pending load. */
		fail(error: Error) {
			const next = pending.shift();
			if (!next) throw new Error('no pending load');
			next.reject(error);
		},
		get pendingCount() {
			return pending.length;
		},
	};
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function expectUnavailable(
	promise: Promise<unknown>,
	reason: StoreUnavailableError['reason'],
) {
	const error = await promise.then(
		() => {
			throw new Error('expected a rejection');
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(StoreUnavailableError);
	expect((error as StoreUnavailableError).reason).toBe(reason);
	return error as StoreUnavailableError;
}

function createStore(gated: ReturnType<typeof createGatedStorage>, sync?: SyncAdapter<TestSchema>) {
	return createSyncableStore({
		schema,
		account: A,
		storage: {adapterFactory: () => gated.storage, key: 'k', options: {debounceMs: 5}},
		defaultData,
		...(sync ? {sync: {adapterFactory: () => sync, options: {debounceMs: 5}}} : {}),
	});
}

describe('single store: writer() (R2)', () => {
	let gated: ReturnType<typeof createGatedStorage>;
	beforeEach(() => {
		gated = createGatedStorage();
	});

	it('is undefined before load, while loading, and defined once loaded', async () => {
		const store = createStore(gated);
		expect(store.writer()).toBeUndefined();

		const loading = store.load();
		expect(store.get().isLoading).toBe(true);
		expect(store.writer()).toBeUndefined();

		gated.release();
		await loading;
		const writer = store.writer();
		expect(writer).toBeDefined();
		expect(writer!.account).toBe(A);
	});

	it('returns the same handle every time, and writes through it are visible to reads', async () => {
		gated.ungate();
		const store = createStore(gated);
		await store.load();

		const writer = store.writer()!;
		expect(store.writer()).toBe(writer);

		writer.set('settings', {theme: 'light'});
		writer.addItem('operations', 'op', {tx: '0x1'}, {deleteAt: Date.now() + 60_000});

		const state = store.get();
		expect(state.status).toBe('ready');
		if (state.status === 'ready') {
			expect(state.data.settings.theme).toBe('light');
			expect(state.data.operations.op.tx).toBe('0x1');
		}
		expect(writer.read().settings.theme).toBe('light');
		expect(writer.read().operations.op.tx).toBe('0x1');
	});

	it('is undefined after a load error', async () => {
		const store = createStore(gated);
		const loading = store.load();
		gated.fail(new Error('boom'));
		await loading;
		expect(store.get().status).toBe('error');
		expect(store.writer()).toBeUndefined();
	});

	it('is undefined after stop()', async () => {
		gated.ungate();
		const store = createStore(gated);
		await store.load();
		store.stop();
		expect(store.writer()).toBeUndefined();
	});
});

describe('single store: ready() (R3)', () => {
	let gated: ReturnType<typeof createGatedStorage>;
	beforeEach(() => {
		gated = createGatedStorage();
	});

	it('resolves to the handle when called before load()', async () => {
		const store = createStore(gated);
		const ready = store.ready();
		const loading = store.load();
		gated.release();
		await loading;
		const writer = await ready;
		expect(writer).toBe(store.writer());
	});

	it('resolves to the handle when called while loading', async () => {
		const store = createStore(gated);
		const loading = store.load();
		const ready = store.ready();
		gated.release();
		await loading;
		expect(await ready).toBe(store.writer());
	});

	it('resolves at once when already loaded', async () => {
		gated.ungate();
		const store = createStore(gated);
		await store.load();
		expect(await store.ready()).toBe(store.writer());
	});

	it('rejects with load-failed, the load error as cause, when the load fails', async () => {
		const store = createStore(gated);
		const loading = store.load();
		const ready = store.ready();
		const cause = new Error('decrypt failed');
		gated.fail(cause);
		await loading;
		const error = await expectUnavailable(ready, 'load-failed');
		expect(error.cause).toBe(cause);
		expect(error.account).toBe(A);
	});

	it('rejects with load-failed at once when the load has already failed', async () => {
		const store = createStore(gated);
		const loading = store.load();
		const cause = new Error('boom');
		gated.fail(cause);
		await loading;
		const error = await expectUnavailable(store.ready(), 'load-failed');
		expect(error.cause).toBe(cause);
	});

	it('resolves after retryLoad() succeeds', async () => {
		const store = createStore(gated);
		const loading = store.load();
		gated.fail(new Error('boom'));
		await loading;

		store.retryLoad();
		const ready = store.ready();
		gated.release();
		expect(await ready).toBe(store.writer());
		expect(store.get().status).toBe('ready');
	});

	it('rejects with stopped when stopped before load() was called', async () => {
		const store = createStore(gated);
		const ready = store.ready();
		store.stop();
		await expectUnavailable(ready, 'stopped');
	});

	it('rejects with stopped when stopped while loading, and the load never reaches ready', async () => {
		const store = createStore(gated);
		const states: StoreLifecycleState['status'][] = [];
		store.state$.subscribe((s) => states.push(s.status));

		const loading = store.load();
		const ready = store.ready();
		store.stop();
		await expectUnavailable(ready, 'stopped');

		gated.release();
		await loading;
		expect(store.get().status).toBe('idle');
		expect(store.get().isLoading).toBe(false);
		expect(store.writer()).toBeUndefined();
		// No storage watch installed by a load that finished after stop().
		expect(gated.watchCalls).toBe(0);
		expect(states).not.toContain('ready');
	});

	it('rejects with stopped at once when already stopped', async () => {
		gated.ungate();
		const store = createStore(gated);
		await store.load();
		store.stop();
		await expectUnavailable(store.ready(), 'stopped');
	});

	it('load() after stop() rejects with stopped', async () => {
		const store = createStore(gated);
		store.stop();
		await expectUnavailable(store.load(), 'stopped');
		expect(gated.pendingCount).toBe(0);
	});
});

describe('the error state (R4)', () => {
	it('get(), state$ and the $store:state event report error with the load error', async () => {
		const gated = createGatedStorage();
		const store = createStore(gated);
		const lifecycle: StoreLifecycleState[] = [];
		const events: StateEvent[] = [];
		store.state$.subscribe((s) => lifecycle.push(s));
		store.on('$store:state', (e) => events.push(e));

		const loading = store.load();
		const cause = new Error('boom');
		gated.fail(cause);
		await loading;

		const state = store.get();
		expect(state.status).toBe('error');
		if (state.status === 'error') {
			expect(state.loadError).toBe(cause);
			expect(state.isLoading).toBe(false);
			expect(state.account).toBe(A);
		}

		expect(lifecycle.map((s) => s.status)).toEqual(['idle', 'loading', 'error']);
		const last = lifecycle[lifecycle.length - 1];
		expect(last.loadError).toBe(cause);
		// idle never carries an error now.
		expect(lifecycle[0].loadError).toBeNull();

		expect(events).toEqual([{type: 'loading'}, {type: 'error', error: cause}]);
	});

	it('retryLoad() is only allowed from error', async () => {
		const gated = createGatedStorage();
		gated.ungate();
		const store = createStore(gated);
		expect(() => store.retryLoad()).toThrow('Can only retry when load has failed');
		await store.load();
		expect(() => store.retryLoad()).toThrow('Can only retry when load has failed');
	});
});

describe('a handle held after its store is stopped (R5)', () => {
	it('throws stopped on every mutator and on read(), and nothing is saved or pushed', async () => {
		const gated = createGatedStorage();
		gated.ungate();
		let pushes = 0;
		const sync: SyncAdapter<TestSchema> = {
			async pull() {
				return {success: true, data: null, counter: 0n};
			},
			async push() {
				pushes++;
				return {success: true};
			},
		};
		const store = createStore(gated, sync);
		await store.load();
		const writer = store.writer()!;
		writer.addItem('operations', 'op', {tx: '0x1'}, {deleteAt: Date.now() + 60_000});
		await tick(50);

		const savesBefore = gated.saves.length;
		const pushesBefore = pushes;
		store.stop();

		const attempts: [string, () => unknown][] = [
			['set', () => writer.set('settings', {theme: 'light'})],
			['patch', () => writer.patch('settings', (s) => ({...s, theme: 'x'}))],
			['addItem', () => writer.addItem('operations', 'op2', {tx: '0x2'}, {deleteAt: 1})],
			['setItem', () => writer.setItem('operations', 'op', {tx: '0x3'})],
			['updateItem', () => writer.updateItem('operations', 'op', {tx: '0x4'})],
			['patchItem', () => writer.patchItem('operations', 'op', (o) => o)],
			['removeItem', () => writer.removeItem('operations', 'op')],
			['read', () => writer.read()],
		];
		for (const [name, attempt] of attempts) {
			let thrown: unknown;
			try {
				attempt();
			} catch (e) {
				thrown = e;
			}
			expect(thrown, name).toBeInstanceOf(StoreUnavailableError);
			expect((thrown as StoreUnavailableError).reason, name).toBe('stopped');
		}

		await tick(50);
		expect(gated.saves.length).toBe(savesBefore);
		expect(pushes).toBe(pushesBefore);
		const state = store.get();
		if (state.status === 'ready') {
			// Reads of a stopped store still show its last data (R7).
			expect(state.data.settings.theme).toBe('dark');
		}
	});

	it('update() on a record field is revoked too', async () => {
		const {record} = await import('../src/index.js');
		const recordSchema = defineSchema({prefs: record<{a: number; b: number}>()});
		const store = createSyncableStore({
			schema: recordSchema,
			account: A,
			storage: {
				adapterFactory: () => ({
					async load() {
						return undefined;
					},
					async save() {},
					async remove() {},
					async exists() {
						return false;
					},
				}),
				key: 'k',
			},
			defaultData: () => ({prefs: {a: 1, b: 2}}),
		});
		await store.load();
		const writer = store.writer()!;
		store.stop();
		expect(() => writer.update('prefs', {a: 3})).toThrow(StoreUnavailableError);
	});
});

// ============================================================================
// Multi-account (R6)
// ============================================================================

function createMockAccountStore() {
	let current: `0x${string}` | undefined;
	const subscribers = new Set<(a: `0x${string}` | undefined) => void>();
	const store: AccountStore = {
		subscribe(cb) {
			subscribers.add(cb);
			cb(current);
			return () => subscribers.delete(cb);
		},
	};
	return {
		store,
		set(account: `0x${string}` | undefined) {
			current = account;
			for (const cb of subscribers) cb(account);
		},
	};
}

function createMulti(gated: ReturnType<typeof createGatedStorage>) {
	const accounts = createMockAccountStore();
	const multi = createMultiAccountStore({
		schema,
		accountStore: accounts.store,
		factory: (account) =>
			createSyncableStore({
				schema,
				account,
				storage: {adapterFactory: () => gated.storage, key: account, options: {debounceMs: 5}},
				defaultData,
			}),
	});
	return {multi, accounts};
}

describe('multi-account store: writer() and ready() (R6)', () => {
	let gated: ReturnType<typeof createGatedStorage>;
	beforeEach(() => {
		gated = createGatedStorage();
	});

	it('writer() is undefined with no subscriber, no account, and while loading; defined once loaded', async () => {
		const {multi, accounts} = createMulti(gated);
		expect(multi.writer()).toBeUndefined();

		const unsubscribe = multi.subscribe(() => {});
		expect(multi.writer()).toBeUndefined();

		accounts.set(A);
		expect(multi.writer()).toBeUndefined();

		gated.release();
		await tick();
		const writer = multi.writer();
		expect(writer).toBeDefined();
		expect(writer!.account).toBe(A);
		expect(writer).toBe(multi.get()!.writer());
		unsubscribe();
	});

	it('ready() rejects with no-account at once when there is no current store', async () => {
		const {multi} = createMulti(gated);
		await expectUnavailable(multi.ready(), 'no-account');

		const unsubscribe = multi.subscribe(() => {});
		await expectUnavailable(multi.ready(), 'no-account');
		unsubscribe();
	});

	it('ready() resolves to the current account handle once it loads', async () => {
		const {multi, accounts} = createMulti(gated);
		const unsubscribe = multi.subscribe(() => {});
		accounts.set(A);
		const ready = multi.ready();
		gated.release();
		const writer = await ready;
		expect(writer.account).toBe(A);
		writer.set('settings', {theme: 'light'});
		expect(multi.get()!.get().status).toBe('ready');
		unsubscribe();
	});

	it('ready() rejects with account-switched when the account changes before it loads', async () => {
		const {multi, accounts} = createMulti(gated);
		const unsubscribe = multi.subscribe(() => {});
		accounts.set(A);
		const ready = multi.ready();
		accounts.set(B);
		const error = await expectUnavailable(ready, 'account-switched');
		expect(error.account).toBe(A);
		expect(error.cause).toBeInstanceOf(StoreUnavailableError);
		unsubscribe();
	});

	it('ready() rejects with account-switched when the account disconnects before it loads', async () => {
		const {multi, accounts} = createMulti(gated);
		const unsubscribe = multi.subscribe(() => {});
		accounts.set(A);
		const ready = multi.ready();
		accounts.set(undefined);
		await expectUnavailable(ready, 'account-switched');
		unsubscribe();
	});

	it('ready() rejects with stopped when the last subscriber leaves before it loads', async () => {
		const {multi, accounts} = createMulti(gated);
		const unsubscribe = multi.subscribe(() => {});
		accounts.set(A);
		const ready = multi.ready();
		unsubscribe();
		await expectUnavailable(ready, 'stopped');
	});

	it('ready() rejects with load-failed when the current store fails to load', async () => {
		const {multi, accounts} = createMulti(gated);
		const unsubscribe = multi.subscribe(() => {});
		accounts.set(A);
		const ready = multi.ready();
		const cause = new Error('boom');
		gated.fail(cause);
		const error = await expectUnavailable(ready, 'load-failed');
		expect(error.cause).toBe(cause);
		unsubscribe();
	});

	it('a load that finishes after its account switched away never becomes ready', async () => {
		const {multi, accounts} = createMulti(gated);
		const unsubscribe = multi.subscribe(() => {});
		accounts.set(A);
		const storeA = multi.get()!;
		accounts.set(B);
		gated.release(); // A's load
		await tick();
		expect(storeA.get().status).toBe('idle');
		expect(storeA.writer()).toBeUndefined();
		unsubscribe();
	});

	it('a handle held across a switch throws instead of being lost under the fresh store (R5)', async () => {
		gated.ungate();
		const {multi, accounts} = createMulti(gated);
		const unsubscribe = multi.subscribe(() => {});
		accounts.set(A);
		const stale = await multi.ready();

		accounts.set(B);
		await multi.ready();
		accounts.set(A);
		const fresh = await multi.ready();
		expect(fresh).not.toBe(stale);

		let thrown: unknown;
		try {
			stale.set('settings', {theme: 'secret'});
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(StoreUnavailableError);
		expect((thrown as StoreUnavailableError).reason).toBe('stopped');
		expect((thrown as StoreUnavailableError).account).toBe(A);

		fresh.set('settings', {theme: 'fresh'});
		await tick(30);
		expect(gated.data.get(A)!.data.settings.theme).toBe('fresh');
		unsubscribe();
	});
});

describe('reads do not change (R7)', () => {
	it('get(), watchField, watchItem and state$ behave as before around the load', async () => {
		const gated = createGatedStorage();
		const store = createStore(gated);
		const settings: ({theme: string} | undefined)[] = [];
		const item: ({tx: string} | undefined)[] = [];
		const states: string[] = [];
		store.watchField('settings').subscribe((s) => settings.push(s));
		store.watchItem('operations', 'op').subscribe((i) => item.push(i));
		store.state$.subscribe((s) => states.push(s.status));

		const loading = store.load();
		gated.release();
		await loading;

		const writer = store.writer()!;
		writer.set('settings', {theme: 'light'});
		writer.addItem('operations', 'op', {tx: '0x1'}, {deleteAt: Date.now() + 60_000});

		expect(settings[0]).toBeUndefined();
		expect(settings[settings.length - 1]).toEqual({theme: 'light'});
		expect(item[0]).toBeUndefined();
		expect(item[item.length - 1]?.tx).toBe('0x1');
		expect(states).toEqual(['idle', 'loading', 'ready']);

		const state = store.get();
		if (state.status !== 'ready') throw new Error('expected ready');
		expect(state.data.settings.theme).toBe('light');
	});
});
