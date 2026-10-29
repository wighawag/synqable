import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {
	createMultiAccountStore,
	createSyncableStore,
	defineSchema,
	value,
	type AccountStore,
	type AsyncStorage,
	type InternalStorage,
	type SyncAdapter,
	type WatchableStorage,
} from '../src/index.js';

/**
 * A listener that throws must never leave the store half done. The store
 * commits its own state (data, save, sync, flags) before it notifies, and every
 * listener runs. An event with a synchronous caller (a mutator, load()) still
 * throws the first listener error to that caller; an event with no caller (save
 * and sync status, merges) reports it through `reportError` (stubbed here).
 */

const schema = defineSchema({
	a: value<number>(),
	b: value<number>(),
});
type TestSchema = typeof schema;
type Stored = InternalStorage<TestSchema>;

const A = '0x1111111111111111111111111111111111111111' as const;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function createStorage() {
	const saves: Stored[] = [];
	let watcher: ((key: string, value: Stored | undefined) => void) | undefined;
	const storage: AsyncStorage<Stored> & WatchableStorage<Stored> = {
		async load() {
			return undefined;
		},
		async save(_key, value) {
			saves.push(structuredClone(value));
		},
		async remove() {},
		async exists() {
			return false;
		},
		watch(_key, callback) {
			watcher = callback as typeof watcher;
			return () => {
				watcher = undefined;
			};
		},
	};
	return {
		storage,
		saves,
		/** Another tab wrote this value. */
		external(value: Stored) {
			watcher?.(A, value);
		},
	};
}

/** Stored data in which `a` was written, later than anything local. */
function newerA(a: number): Stored {
	return {
		$version: 1,
		data: {a, b: 0},
		$timestamps: {a: Date.now() + 60_000},
		$itemTimestamps: {},
		$tombstones: {},
	} as unknown as Stored;
}

function createSync(pullData: () => Stored | null = () => null) {
	const pushes: Stored[] = [];
	let pulls = 0;
	const sync: SyncAdapter<TestSchema> = {
		async pull() {
			pulls++;
			return {success: true, data: pullData(), counter: 1n};
		},
		async push(_account, data) {
			pushes.push(structuredClone(data));
			return {success: true};
		},
	};
	return {
		sync,
		pushes,
		get pulls() {
			return pulls;
		},
	};
}

function createStore(storage: AsyncStorage<Stored>, sync?: SyncAdapter<TestSchema>) {
	return createSyncableStore({
		schema,
		account: A,
		storage: {adapterFactory: () => storage, key: A, options: {debounceMs: 5}},
		defaultData: () => ({a: 0, b: 0}),
		...(sync
			? {
					sync: {
						adapterFactory: () => sync,
						// A long backoff, so a listener error mistaken for a sync failure shows.
						options: {debounceMs: 5, retryBackoffMs: 60_000},
					},
				}
			: {}),
	});
}

let reported: unknown[];
beforeEach(() => {
	reported = [];
	vi.stubGlobal('reportError', (error: unknown) => reported.push(error));
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('a data listener that throws on a write', () => {
	it('the write is still saved and synced; the mutator throws the listener error', async () => {
		const {storage, saves} = createStorage();
		const remote = createSync();
		const store = createStore(storage, remote.sync);
		await store.load();
		await tick(20);
		const pushesBefore = remote.pushes.length;

		const boom = new Error('listener bug');
		store.on('a:changed', () => {
			throw boom;
		});

		expect(() => store.writer()!.set('a', 1)).toThrow(boom);
		await expect(store.persisted()).resolves.toBeUndefined();
		expect(saves.at(-1)?.data.a).toBe(1);

		await tick(30);
		expect(remote.pushes.length).toBeGreaterThan(pushesBefore);
		expect(remote.pushes.at(-1)?.data.a).toBe(1);
		store.stop();
	});

	it('every listener still runs, and the first error is the one thrown', async () => {
		const {storage} = createStorage();
		const store = createStore(storage);
		await store.load();

		const first = new Error('first');
		const second = new Error('second');
		const seen: string[] = [];
		store.on('a:changed', () => {
			seen.push('one');
			throw first;
		});
		store.on('a:changed', () => {
			seen.push('two');
			throw second;
		});
		store.on('a:changed', () => {
			seen.push('three');
		});

		expect(() => store.writer()!.set('a', 1, {immediate: true})).toThrow(first);
		expect(seen).toEqual(['one', 'two', 'three']);
		// Only one error can be thrown; the others are reported, not dropped.
		expect(reported).toEqual([second]);
		await expect(store.persisted()).resolves.toBeUndefined();
		store.stop();
	});

	it('a persisted() called from the listener covers the write being announced', async () => {
		const {storage, saves} = createStorage();
		const store = createStore(storage);
		await store.load();

		let fromListener: Promise<void> | undefined;
		store.on('a:changed', () => {
			fromListener = store.persisted();
		});
		store.writer()!.set('a', 4);
		await fromListener;
		expect(saves.at(-1)?.data.a).toBe(4);
		store.stop();
	});
});

describe('a status listener that throws', () => {
	it('on `saving`: the save completes, isSaving returns to false, and later saves happen', async () => {
		const {storage, saves} = createStorage();
		const store = createStore(storage);
		await store.load();

		const boom = new Error('saving listener bug');
		store.on('$store:storage', (event) => {
			if (event.type === 'saving') throw boom;
		});

		// Not the writer's error: the save runs on its own, so it is reported.
		store.writer()!.set('a', 1, {immediate: true});
		await expect(store.persisted()).resolves.toBeUndefined();
		let isSaving: boolean | undefined;
		store.storageStatus$.subscribe((s) => (isSaving = s.isSaving))();
		expect(isSaving).toBe(false);
		expect(reported).toContain(boom);

		store.writer()!.set('a', 2, {immediate: true});
		await expect(store.persisted()).resolves.toBeUndefined();
		expect(saves.at(-1)?.data.a).toBe(2);
		await expect(store.flush(200)).resolves.toBeUndefined();
		store.stop();
	});

	it('on sync `pending`: the write does not throw, and it is still synced', async () => {
		const {storage} = createStorage();
		const remote = createSync();
		const store = createStore(storage, remote.sync);
		await store.load();
		await tick(20);
		const pushesBefore = remote.pushes.length;

		const boom = new Error('pending listener bug');
		store.on('$store:sync', (event) => {
			if (event.type === 'pending') throw boom;
		});

		store.writer()!.set('a', 1);
		await tick(30);
		expect(remote.pushes.length).toBeGreaterThan(pushesBefore);
		expect(remote.pushes.at(-1)?.data.a).toBe(1);
		expect(reported).toContain(boom);
		store.stop();
	});

	it('on sync `started`: the sync is not taken for a failure, and it completes', async () => {
		const {storage} = createStorage();
		const remote = createSync();
		const store = createStore(storage, remote.sync);
		const boom = new Error('started listener bug');
		store.on('$store:sync', (event) => {
			if (event.type === 'started') throw boom;
		});

		await store.load(); // load triggers a sync
		await tick(20);
		let status: {isSyncing: boolean; lastSyncedAt: number | null; syncError: Error | null};
		store.syncStatus$.subscribe((s) => (status = {...s}))();
		expect(status!.isSyncing).toBe(false);
		expect(status!.syncError).toBeNull();
		expect(status!.lastSyncedAt).not.toBeNull();
		expect(remote.pulls).toBe(1);
		expect(reported).toContain(boom);
		store.stop();
	});
});

describe('a data listener that throws on a merge', () => {
	it('sync: the merged data is saved, and the sync is not retried as failed', async () => {
		const {storage, saves} = createStorage();
		const remote = createSync(() => newerA(5));
		const store = createStore(storage, remote.sync);
		const boom = new Error('merge listener bug');
		store.on('a:changed', () => {
			throw boom;
		});

		await store.load();
		await tick(20);
		expect(store.writer()!.read().a).toBe(5);
		expect(saves.some((saved) => saved.data.a === 5)).toBe(true);
		await expect(store.persisted()).resolves.toBeUndefined();
		let syncError: Error | null | undefined;
		store.syncStatus$.subscribe((s) => (syncError = s.syncError))();
		expect(syncError).toBeNull();
		expect(remote.pulls).toBe(1);
		expect(reported).toContain(boom);
		store.stop();
	});

	it('storage watch: every listener is notified, and the error is reported', async () => {
		const {storage, external} = createStorage();
		const store = createStore(storage);
		await store.load();

		const boom = new Error('watch listener bug');
		const seen: number[] = [];
		store.on('a:changed', () => {
			throw boom;
		});
		store.on('a:changed', (value) => {
			seen.push(value as number);
		});

		expect(() => external(newerA(9))).not.toThrow();
		expect(seen).toEqual([9]);
		expect(store.writer()!.read().a).toBe(9);
		expect(reported).toContain(boom);
		store.stop();
	});
});

describe('a state listener that throws during load()', () => {
	it('on `loading`: the load still completes; load() rejects with the error, ready() resolves', async () => {
		const {storage} = createStorage();
		const store = createStore(storage);
		const boom = new Error('loading listener bug');
		store.on('$store:state', (event) => {
			if (event.type === 'loading') throw boom;
		});

		const ready = store.ready();
		await expect(store.load()).rejects.toBe(boom);
		expect(store.get().status).toBe('ready');
		await expect(
			Promise.race([ready.then(() => 'ready'), tick(50).then(() => 'hung')]),
		).resolves.toBe('ready');
		store.stop();
	});

	it('on `ready`: as before, load() rejects and the store stays ready; now later listeners still run', async () => {
		const {storage} = createStorage();
		const store = createStore(storage);
		const boom = new Error('ready listener bug');
		const seen: string[] = [];
		store.on('$store:state', (event) => {
			if (event.type === 'ready') throw boom;
		});
		store.state$.subscribe((s) => seen.push(s.status));

		await expect(store.load()).rejects.toBe(boom);
		expect(store.get().status).toBe('ready');
		// Every listener ran: state$ saw ready although an earlier listener threw.
		expect(seen.at(-1)).toBe('ready');
		store.stop();
	});
});

describe('where a listener error goes', () => {
	it('every status listener runs although an earlier one throws', async () => {
		const {storage} = createStorage();
		const store = createStore(storage);
		await store.load();

		const boom = new Error('first status listener');
		const seen: string[] = [];
		store.on('$store:storage', (event) => {
			if (event.type === 'saving') throw boom;
		});
		store.on('$store:storage', (event) => seen.push(event.type));

		store.writer()!.set('a', 1, {immediate: true});
		await store.persisted();
		expect(seen).toContain('saving');
		expect(seen).toContain('saved');
		expect(reported).toEqual([boom]);
		store.stop();
	});

	it('a status listener error during a nested write is reported, not thrown to the outer write', async () => {
		const {storage, saves} = createStorage();
		const store = createStore(storage);
		await store.load();

		const boom = new Error('saving listener bug');
		store.on('$store:storage', (event) => {
			if (event.type === 'saving') throw boom;
		});
		// A data listener that itself writes, saving at once.
		store.on('a:changed', () => {
			store.writer()!.set('b', 2, {immediate: true});
		});

		expect(() => store.writer()!.set('a', 1)).not.toThrow();
		await store.persisted();
		expect(saves.at(-1)?.data).toEqual({a: 1, b: 2});
		expect(reported).toContain(boom);
		store.stop();
	});

	it('without reportError (Node), it goes to console.error', async () => {
		vi.stubGlobal('reportError', undefined);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const {storage} = createStorage();
			const store = createStore(storage);
			await store.load();
			const boom = new Error('reported via console');
			store.on('$store:storage', () => {
				throw boom;
			});
			store.writer()!.set('a', 1, {immediate: true});
			await store.persisted();
			expect(logged.mock.calls.some((call) => call.includes(boom))).toBe(true);
			store.stop();
		} finally {
			logged.mockRestore();
		}
	});

	it('when load() itself fails after a listener threw, the listener error is reported', async () => {
		const {storage} = createStorage();
		const watchFailure = new Error('watch failed');
		const failingWatch = {
			...storage,
			watch() {
				throw watchFailure;
			},
		};
		const store = createStore(failingWatch);
		const boom = new Error('loading listener bug');
		store.on('$store:state', (event) => {
			if (event.type === 'loading') throw boom;
		});

		await expect(store.load()).rejects.toBe(watchFailure);
		expect(reported).toEqual([boom]);
	});

	it('multi-account: a state$ subscriber that throws during the load is reported', async () => {
		const {storage} = createStorage();
		let current: `0x${string}` | undefined;
		const subscribers = new Set<(a: `0x${string}` | undefined) => void>();
		const accountStore: AccountStore = {
			subscribe(cb) {
				subscribers.add(cb);
				cb(current);
				return () => subscribers.delete(cb);
			},
		};
		const multi = createMultiAccountStore({
			schema,
			accountStore,
			factory: () => createStore(storage),
		});
		const boom = new Error('state$ subscriber bug');
		const unsubscribe = multi.state$.subscribe((state) => {
			if (state.status === 'ready') throw boom;
		});
		current = A;
		for (const cb of subscribers) cb(A);

		await multi.ready();
		await tick();
		expect(reported).toEqual([boom]);
		unsubscribe();
	});
});
