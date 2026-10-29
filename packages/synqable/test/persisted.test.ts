import {describe, it, expect} from 'vitest';
import {
	createMultiAccountStore,
	createSyncableStore,
	defineSchema,
	value,
	StoreUnavailableError,
	type AccountStore,
	type AsyncStorage,
	type SyncAdapter,
	type InternalStorage,
	type StorageStatus,
	type SyncableStore,
} from '../src/index.js';

/**
 * `persisted()` answers "are the writes I made on storage?". The tests named
 * after the four required cases (a race with another write's failed save,
 * nothing pending, a failed save then a retry, a write before stop()) are each
 * built so that the 0.2.1 workaround (`flush()`, then read `storageStatus$`'s
 * `storageError`), a polling wait, or a report-the-last-error check gives the
 * wrong answer. The other tests pin the rest of the contract.
 */

const schema = defineSchema({
	a: value<number>(),
	b: value<number>(),
});
type TestSchema = typeof schema;
type Stored = InternalStorage<TestSchema>;

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;

/**
 * Storage whose every save is held until the test settles it, so a test can
 * order saves and failures exactly. Loads answer at once with nothing stored.
 */
function createControlledStorage() {
	const saves: {key: string; value: Stored; resolve: () => void; reject: (e: Error) => void}[] = [];
	const storage: AsyncStorage<Stored> = {
		async load() {
			return undefined;
		},
		save(key, value) {
			const copy = structuredClone(value);
			return new Promise<void>((resolve, reject) => {
				saves.push({key, value: copy, resolve, reject});
			});
		},
		async remove() {},
		async exists() {
			return false;
		},
	};
	return {storage, saves};
}

function createStore(storage: AsyncStorage<Stored>, account: `0x${string}` = A) {
	return createSyncableStore({
		schema,
		account,
		storage: {adapterFactory: () => storage, key: account, options: {debounceMs: 5}},
		defaultData: () => ({a: 0, b: 0}),
	});
}

async function loaded(storage: AsyncStorage<Stored>) {
	const store = createStore(storage);
	await store.load();
	return {store, writer: store.writer()!};
}

/** A macrotask: every pending microtask runs, but well inside a 10 ms poll interval. */
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Settle a promise into a value the test can inspect without an unhandled rejection. */
function outcome(promise: Promise<void>) {
	const result: {state: 'pending' | 'resolved' | 'rejected'; error?: unknown} = {state: 'pending'};
	promise.then(
		() => {
			result.state = 'resolved';
		},
		(error: unknown) => {
			result.state = 'rejected';
			result.error = error;
		},
	);
	return result;
}

function storageStatusOf(store: SyncableStore<TestSchema>): StorageStatus {
	let status!: StorageStatus;
	store.storageStatus$.subscribe((s) => (status = {...s}))();
	return status;
}

describe('persisted(): saves triggered by other writes do not confuse it', () => {
	it('resolves when its save succeeded, although another write saves and fails right after', async () => {
		const {storage, saves} = createControlledStorage();
		const {store, writer} = await loaded(storage);

		writer.set('a', 1, {immediate: true});
		const ours = outcome(store.persisted());
		const viaHandle = outcome(writer.persisted());
		expect(saves).toHaveLength(1);

		saves[0].resolve(); // our save lands
		await tick();
		expect(ours.state).toBe('resolved');

		// Another caller writes and its save fails, inside one 10 ms poll gap.
		writer.set('b', 2, {immediate: true});
		expect(saves).toHaveLength(2);
		saves[1].reject(new Error('disk full'));
		await tick(20);

		expect(ours.state).toBe('resolved');
		expect(viaHandle.state).toBe('resolved');
		expect(saves[0].value.data.a).toBe(1);
		// storageStatus$ is unchanged: it reports the failed save of the other write.
		expect(storageStatusOf(store).storageError?.message).toBe('disk full');
	});

	it('resolves when its save succeeded, although a write made during that save is saved next and fails', async () => {
		const {storage, saves} = createControlledStorage();
		const {store, writer} = await loaded(storage);

		writer.set('a', 1, {immediate: true});
		const ours = outcome(store.persisted());
		// Another caller writes while our save is in flight: it is queued, and the
		// two saves run back to back with no `saved` event between them.
		writer.set('b', 2, {immediate: true});
		expect(saves).toHaveLength(1);

		saves[0].resolve();
		await tick();
		expect(saves).toHaveLength(2);
		saves[1].reject(new Error('disk full'));
		await tick(20);

		expect(ours.state).toBe('resolved');
		// The other write's caller, which asks after its own write, is told the truth.
		const theirs = outcome(store.persisted());
		await tick();
		expect(saves).toHaveLength(3); // a retry, since `b` is not on storage
		saves[2].reject(new Error('still full'));
		await tick();
		expect(theirs.state).toBe('rejected');
	});

	it('the 0.2.1 workaround (flush, then storageError) gets that race wrong', async () => {
		// Documents the defect persisted() replaces; flush() itself is unchanged.
		const {storage, saves} = createControlledStorage();
		const {store, writer} = await loaded(storage);

		writer.set('a', 1, {immediate: true});
		const flushed = outcome(
			store.flush().then(() => {
				const error = storageStatusOf(store).storageError;
				if (error) throw error;
			}),
		);
		saves[0].resolve();
		await tick();
		writer.set('b', 2, {immediate: true});
		saves[1].reject(new Error('disk full'));
		await tick(20);

		expect(flushed.state).toBe('rejected');
	});
});

describe('persisted(): nothing pending', () => {
	it('resolves at once, starting no save, when every write is already saved', async () => {
		const {storage, saves} = createControlledStorage();
		const {store} = await loaded(storage);

		// Nothing written at all.
		await expect(store.persisted()).resolves.toBeUndefined();
		expect(saves).toHaveLength(0);

		store.writer()!.set('a', 1, {immediate: true});
		saves[0].resolve();
		await tick();

		await expect(store.persisted()).resolves.toBeUndefined();
		expect(saves).toHaveLength(1);
	});

	it('never reports the stale error of an earlier save: it retries and reports that retry', async () => {
		const {storage, saves} = createControlledStorage();
		const {store, writer} = await loaded(storage);

		writer.set('a', 1, {immediate: true});
		const first = outcome(store.persisted());
		saves[0].reject(new Error('first failure'));
		await tick();
		expect(first.state).toBe('rejected');
		// Nothing is pending now, and storageStatus$ still holds the old error.
		expect(storageStatusOf(store).storageError?.message).toBe('first failure');

		// Not the old error: a new save is attempted, and ITS failure is reported.
		const second = outcome(store.persisted());
		await tick();
		expect(saves).toHaveLength(2);
		expect(second.state).toBe('pending');
		saves[1].reject(new Error('second failure'));
		await tick();
		expect(second.state).toBe('rejected');
		expect((second.error as Error).message).toBe('second failure');
	});
});

describe('persisted(): a failed save, then a successful retry', () => {
	it('rejects when its save fails, then a later call retries the save and resolves', async () => {
		const {storage, saves} = createControlledStorage();
		const {store, writer} = await loaded(storage);

		writer.set('a', 1, {immediate: true});
		const first = outcome(store.persisted());
		saves[0].reject(new Error('quota exceeded'));
		await tick();
		expect(first.state).toBe('rejected');
		expect((first.error as Error).message).toBe('quota exceeded');

		// Storage recovers. Nothing is pending, so a flush() would not save again.
		const second = outcome(writer.persisted());
		await tick();
		expect(saves).toHaveLength(2);
		expect(saves[1].value.data.a).toBe(1);
		saves[1].resolve();
		await tick();
		expect(second.state).toBe('resolved');
		expect(storageStatusOf(store).storageError).toBeNull();
	});

	it('a later successful save for another write also covers the failed one', async () => {
		const {storage, saves} = createControlledStorage();
		const {store, writer} = await loaded(storage);

		writer.set('a', 1, {immediate: true});
		saves[0].reject(new Error('quota exceeded'));
		await tick();

		writer.set('b', 2, {immediate: true});
		saves[1].resolve();
		await tick();

		await expect(store.persisted()).resolves.toBeUndefined();
		expect(saves).toHaveLength(2);
	});

	it('when a save fails with another save already queued, it waits for that save', async () => {
		const {storage, saves} = createControlledStorage();
		const {store, writer} = await loaded(storage);

		writer.set('a', 1, {immediate: true});
		const ours = outcome(store.persisted());
		writer.set('b', 2); // queued while the first save is in flight

		saves[0].reject(new Error('transient'));
		await tick();
		// The queued save includes `a` too (a save writes the whole state).
		expect(ours.state).toBe('pending');
		expect(saves).toHaveLength(2);

		saves[1].resolve();
		await tick();
		expect(ours.state).toBe('resolved');
	});

	it('does not wait on a debounce: a write held by it is saved at once', async () => {
		const {storage, saves} = createControlledStorage();
		const store = createSyncableStore({
			schema,
			account: A,
			storage: {adapterFactory: () => storage, key: A, options: {debounceMs: 60_000}},
			defaultData: () => ({a: 0, b: 0}),
		});
		await store.load();

		store.writer()!.set('a', 1);
		expect(saves).toHaveLength(0);
		const ours = outcome(store.persisted());
		expect(saves).toHaveLength(1);
		saves[0].resolve();
		await tick();
		expect(ours.state).toBe('resolved');
		store.stop();
	});
});

describe('persisted(): across stop()', () => {
	it('a write made before stop() resolves once the save stop() runs lands; the handle still answers', async () => {
		const {storage, saves} = createControlledStorage();
		const {store, writer} = await loaded(storage);

		// An earlier failure leaves a stale storageError behind.
		writer.set('a', 1, {immediate: true});
		saves[0].reject(new Error('earlier failure'));
		await tick();

		writer.set('b', 2); // debounced
		store.stop();
		expect(saves).toHaveLength(1 + 1); // stop() saved the pending write

		// The handle is revoked for writes, not for this.
		expect(() => writer.set('a', 3)).toThrow(StoreUnavailableError);
		const viaHandle = outcome(writer.persisted());
		const viaStore = outcome(store.persisted());
		await tick();
		expect(viaHandle.state).toBe('pending');

		saves[1].resolve();
		await tick();
		expect(viaHandle.state).toBe('resolved');
		expect(viaStore.state).toBe('resolved');
		expect(saves[1].value.data).toEqual({a: 1, b: 2});
	});

	it('when the save stop() runs fails, it rejects with that error and never saves again', async () => {
		const {storage, saves} = createControlledStorage();
		const {store, writer} = await loaded(storage);

		writer.set('a', 1); // debounced
		store.stop();
		expect(saves).toHaveLength(1);

		const first = outcome(writer.persisted());
		saves[0].reject(new Error('disk full'));
		await tick();
		expect(first.state).toBe('rejected');
		expect((first.error as Error).message).toBe('disk full');

		// A stopped store does not retry: its save would race the next store for the account.
		const again = outcome(store.persisted());
		await tick(20);
		expect(again.state).toBe('rejected');
		expect((again.error as Error).message).toBe('disk full');
		expect(saves).toHaveLength(1);
	});

	it('a write saved before stop() resolves, although the save stop() leaves queued then fails', async () => {
		const {storage, saves} = createControlledStorage();
		const {store, writer} = await loaded(storage);

		writer.set('a', 1, {immediate: true});
		const ours = outcome(writer.persisted());
		writer.set('b', 2); // another write, queued behind our in-flight save
		store.stop(); // the queued write is still saved, after ours
		const theirs = outcome(writer.persisted());

		saves[0].resolve();
		await tick();
		expect(saves).toHaveLength(2);
		saves[1].reject(new Error('disk full'));
		await tick(20);

		expect(ours.state).toBe('resolved');
		expect(theirs.state).toBe('rejected');
		expect((theirs.error as Error).message).toBe('disk full');
		expect(saves).toHaveLength(2);
	});

	it('a handle from a multi-account store answers for its own account after a switch', async () => {
		const {storage, saves} = createControlledStorage();
		let current: `0x${string}` | undefined;
		const subscribers = new Set<(a: `0x${string}` | undefined) => void>();
		const accountStore: AccountStore = {
			subscribe(cb) {
				subscribers.add(cb);
				cb(current);
				return () => subscribers.delete(cb);
			},
		};
		const setAccount = (account: `0x${string}` | undefined) => {
			current = account;
			for (const cb of subscribers) cb(account);
		};
		const multi = createMultiAccountStore({
			schema,
			accountStore,
			factory: (account) => createStore(storage, account),
		});
		const unsubscribe = multi.subscribe(() => {});
		setAccount(A);
		const writer = await multi.ready();

		writer.set('a', 7); // debounced
		setAccount(B); // switch: A's store is stopped and saves the pending write
		const ours = outcome(writer.persisted());
		await tick();
		expect(saves.map((s) => s.key)).toEqual([A]);
		expect(ours.state).toBe('pending');

		saves[0].resolve();
		await tick();
		expect(ours.state).toBe('resolved');
		expect(saves[0].value.data.a).toBe(7);
		unsubscribe();
	});
});

describe('persisted(): the rest of the contract', () => {
	it('resolves at once on a store that has not loaded (nothing was written)', async () => {
		const {storage, saves} = createControlledStorage();
		const store = createStore(storage);
		await expect(store.persisted()).resolves.toBeUndefined();
		expect(saves).toHaveLength(0);
	});

	it('called from a `failed` listener, it settles (rejects with that failure) rather than hanging', async () => {
		const {storage, saves} = createControlledStorage();
		const {store, writer} = await loaded(storage);
		const fromListener: ReturnType<typeof outcome>[] = [];
		const fromStatus: ReturnType<typeof outcome>[] = [];
		store.on('$store:storage', (event) => {
			if (event.type === 'failed') fromListener.push(outcome(store.persisted()));
		});
		store.storageStatus$.subscribe((status) => {
			if (status.storageError && fromStatus.length === 0) {
				fromStatus.push(outcome(store.persisted()));
			}
		});

		writer.set('a', 1, {immediate: true});
		saves[0].reject(new Error('disk full'));
		await tick(20);

		expect(fromListener).toHaveLength(1);
		expect(fromListener[0].state).toBe('rejected');
		expect(fromStatus[0].state).toBe('rejected');
		expect((fromStatus[0].error as Error).message).toBe('disk full');
	});

	it('a write made by a `failed` listener queues a save that the earlier waiters then wait for', async () => {
		const {storage, saves} = createControlledStorage();
		const {store, writer} = await loaded(storage);
		let rewritten = false;
		store.on('$store:storage', (event) => {
			if (event.type === 'failed' && !rewritten) {
				rewritten = true;
				writer.set('b', 2);
			}
		});

		writer.set('a', 1, {immediate: true});
		const ours = outcome(store.persisted());
		saves[0].reject(new Error('transient'));
		await tick();
		expect(ours.state).toBe('pending');
		expect(saves).toHaveLength(2);
		saves[1].resolve();
		await tick();
		expect(ours.state).toBe('resolved');
		store.stop();
	});

	it('rejects (with an Error) when the adapter rejects with a falsy value', async () => {
		const {storage, saves} = createControlledStorage();
		const {store, writer} = await loaded(storage);

		writer.set('a', 1, {immediate: true});
		const ours = outcome(store.persisted());
		(saves[0].reject as (e: unknown) => void)(undefined);
		await tick();
		expect(ours.state).toBe('rejected');
		expect(ours.error).toBeInstanceOf(Error);

		// And a stopped store reports that failure, not a generic one.
		writer.set('a', 2);
		store.stop();
		(saves[1].reject as (e: unknown) => void)(null);
		await tick();
		const again = outcome(store.persisted());
		await tick();
		expect(again.state).toBe('rejected');
		expect((again.error as Error).cause).toBeNull();
	});

	it("a sync merge's save counts as a write: persisted() waits for it", async () => {
		const {storage, saves} = createControlledStorage();
		const now = Date.now();
		const sync: SyncAdapter<TestSchema> = {
			async pull() {
				return {
					success: true,
					data: {
						$version: 1,
						data: {a: 5, b: 0},
						$timestamps: {a: now + 60_000},
						$itemTimestamps: {},
						$tombstones: {},
					} as unknown as Stored,
					counter: 1n,
				};
			},
			async push() {
				return {success: true};
			},
		};
		const store = createSyncableStore({
			schema,
			account: A,
			storage: {adapterFactory: () => storage, key: A, options: {debounceMs: 5}},
			defaultData: () => ({a: 0, b: 0}),
			sync: {adapterFactory: () => sync, options: {debounceMs: 60_000}},
		});
		await store.load();
		await store.syncNow();
		expect(store.writer()!.read()).toMatchObject({a: 5});
		const merged = saves.findIndex((save) => save.value.data.a === 5);
		expect(merged).toBeGreaterThanOrEqual(0);

		const ours = outcome(store.persisted());
		await tick();
		expect(ours.state).toBe('pending');
		for (const save of saves) save.resolve();
		await tick();
		expect(ours.state).toBe('resolved');
		store.stop();
	});
});
