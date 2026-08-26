/**
 * Record field behaviour at the store seam.
 *
 * The persisted `InternalStorage` shape is part of the public contract (storage
 * and sync adapters both receive it), so asserting the per-property timestamps
 * it carries is a legitimate observation point, not reaching into internals.
 */

import {describe, it, expect, beforeEach} from 'vitest';
import {
	createSyncableStore,
	defineSchema,
	map,
	record,
	value,
	type SyncableStore,
	type AsyncStorage,
	type InternalStorage,
	type PullResponse,
	type PushResponse,
	type SyncAdapter,
} from '../src/index.js';

const schema = defineSchema({
	settings: record<{theme: string; fontSize: number; darkMode: boolean}>(),
	operations: map<{tx: string}>(),
});

type TestSchema = typeof schema;

const ACCOUNT = '0x1234567890123456789012345678901234567890' as const;

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
			data.set(key, structuredClone(value));
		},
		async remove(key) {
			data.delete(key);
		},
		async exists(key) {
			return data.has(key);
		},
	};
}

function defaultData() {
	return {
		settings: {theme: 'dark', fontSize: 12, darkMode: false},
		operations: {},
	};
}

describe('record fields - mutation stamping', () => {
	let storage: ReturnType<typeof createMockStorage>;
	let clock: number;

	beforeEach(() => {
		storage = createMockStorage();
		clock = 1000;
	});

	async function makeStore() {
		const store = createSyncableStore({
			schema,
			account: ACCOUNT,
			storage: {adapterFactory: () => storage, key: 'k'},
			defaultData,
			clock: () => clock,
		});
		await store.load();
		return store;
	}

	function savedTimestamps() {
		return storage.data.get('k')?.$itemTimestamps.settings;
	}

	it('update() stamps only the properties it was given', async () => {
		const store = await makeStore();

		clock = 2000;
		store.update('settings', {theme: 'light'}, {immediate: true});
		await store.flush();

		expect(savedTimestamps()).toStrictEqual({theme: 2000});

		store.stop();
	});

	it('update() applied twice stamps each property at its own time', async () => {
		const store = await makeStore();

		clock = 2000;
		store.update('settings', {theme: 'light'}, {immediate: true});
		clock = 3000;
		store.update('settings', {fontSize: 20}, {immediate: true});
		await store.flush();

		expect(savedTimestamps()).toStrictEqual({theme: 2000, fontSize: 3000});

		store.stop();
	});

	it('set() asserts the whole struct and therefore stamps every property', async () => {
		const store = await makeStore();

		clock = 3000;
		store.set('settings', {theme: 'x', fontSize: 20, darkMode: true}, {immediate: true});
		await store.flush();

		expect(savedTimestamps()).toStrictEqual({theme: 3000, fontSize: 3000, darkMode: 3000});

		store.stop();
	});

	it('patch() stamps only the properties whose value actually changed', async () => {
		const store = await makeStore();

		clock = 4000;
		store.patch('settings', (current) => ({...current, fontSize: 99}), {immediate: true});
		await store.flush();

		expect(savedTimestamps()).toStrictEqual({fontSize: 4000});

		store.stop();
	});

	it('update() with a falsy value stamps the property', async () => {
		const store = await makeStore();

		clock = 5000;
		store.update('settings', {darkMode: false, fontSize: 0}, {immediate: true});
		await store.flush();

		expect(savedTimestamps()).toStrictEqual({darkMode: 5000, fontSize: 5000});

		store.stop();
	});

	it('emits one field-level changed event carrying the whole value', async () => {
		const store = await makeStore();

		const seen: unknown[] = [];
		store.on('settings:changed', (v) => seen.push(v));

		clock = 2000;
		store.update('settings', {theme: 'light'});

		expect(seen).toStrictEqual([{theme: 'light', fontSize: 12, darkMode: false}]);

		store.stop();
	});

	it('watchField pushes the merged struct to subscribers', async () => {
		const store = await makeStore();

		const seen: unknown[] = [];
		const unsub = store.watchField('settings').subscribe((v) => seen.push(v));

		clock = 2000;
		store.update('settings', {fontSize: 20});

		expect(seen).toStrictEqual([
			{theme: 'dark', fontSize: 12, darkMode: false},
			{theme: 'dark', fontSize: 20, darkMode: false},
		]);

		unsub();
		store.stop();
	});
});

describe('record fields - concurrent devices', () => {
	it('two devices editing different properties both keep their edit', async () => {
		// A single shared server record, as waxdb/secp256k1-db would hold it.
		let serverData: InternalStorage<TestSchema> | null = null;
		let serverCounter = 0n;

		function adapter(): SyncAdapter<TestSchema> {
			return {
				async pull(): Promise<PullResponse<TestSchema>> {
					return {
						success: true,
						data: serverData ? structuredClone(serverData) : null,
						counter: serverCounter,
					};
				},
				async push(_account, data, counter): Promise<PushResponse> {
					serverData = structuredClone(data);
					serverCounter = counter;
					return {success: true};
				},
			};
		}

		async function makeDevice(key: string, now: () => number) {
			const store = createSyncableStore({
				schema,
				account: ACCOUNT,
				storage: {adapterFactory: () => createMockStorage(), key},
				defaultData,
				clock: now,
				sync: {adapterFactory: () => adapter(), options: {debounceMs: 0, intervalMs: 0}},
			});
			await store.load();
			return store;
		}

		let clockA = 2000;
		const deviceA = await makeDevice('a', () => clockA);
		deviceA.update('settings', {theme: 'light'}, {immediate: true});
		await deviceA.syncNow();

		let clockB = 3000;
		const deviceB = await makeDevice('b', () => clockB);
		await deviceB.syncNow();
		deviceB.update('settings', {fontSize: 32}, {immediate: true});
		await deviceB.syncNow();

		// Device A picks up device B's change without losing its own.
		clockA = 4000;
		await deviceA.syncNow();

		const stateA = deviceA.get();
		const stateB = deviceB.get();
		expect(stateA.status).toBe('ready');
		expect(stateB.status).toBe('ready');
		if (stateA.status === 'ready' && stateB.status === 'ready') {
			expect(stateA.data.settings).toStrictEqual({
				theme: 'light',
				fontSize: 32,
				darkMode: false,
			});
			expect(stateB.data.settings).toStrictEqual(stateA.data.settings);
		}

		deviceA.stop();
		deviceB.stop();
	});
});

describe('record fields - cleanup', () => {
	it('preserves per-property timestamps across cleanup', async () => {
		// Regression guard: cleanup rebuilds $itemTimestamps from scratch and used
		// to repopulate it for map fields only, wiping record timestamps on every
		// load and every merge.
		const storage = createMockStorage();
		let clock = 1000;

		const first = createSyncableStore({
			schema,
			account: ACCOUNT,
			storage: {adapterFactory: () => storage, key: 'k'},
			defaultData,
			clock: () => clock,
		});
		await first.load();
		clock = 2000;
		first.update('settings', {theme: 'light'}, {immediate: true});
		await first.flush();
		first.stop();

		// Reload from the same storage - load() runs cleanup.
		const second = createSyncableStore({
			schema,
			account: ACCOUNT,
			storage: {adapterFactory: () => storage, key: 'k'},
			defaultData,
			clock: () => clock,
		});
		await second.load();
		clock = 3000;
		second.update('settings', {fontSize: 20}, {immediate: true});
		await second.flush();

		expect(storage.data.get('k')?.$itemTimestamps.settings).toStrictEqual({
			theme: 2000,
			fontSize: 3000,
		});

		second.stop();
	});

	it('does not maintain a field-level timestamp for a record field', async () => {
		// A field-level timestamp acts as the floor for unstamped properties in
		// mergeRecord, so writing one would make untouched properties beat another
		// device's genuine edit.
		const storage = createMockStorage();
		let clock = 1000;
		const store = createSyncableStore({
			schema,
			account: ACCOUNT,
			storage: {adapterFactory: () => storage, key: 'k'},
			defaultData,
			clock: () => clock,
		});
		await store.load();

		clock = 2000;
		store.set('settings', {theme: 'x', fontSize: 1, darkMode: true}, {immediate: true});
		await store.flush();

		// Note: $timestamps is typed over value-field keys only, so `settings` has no
		// slot there at the type level either. The cast is what makes the runtime
		// check expressible at all.
		const fieldTimestamps = storage.data.get('k')?.$timestamps as Record<string, number>;
		expect(fieldTimestamps.settings).toBeUndefined();

		store.stop();
	});
});

describe('record fields - type contracts', () => {
	it('update() is not available on a value field', () => {
		const mixed = defineSchema({
			atomic: value<string>(),
			struct: record<{a: number}>(),
		});
		type Store = SyncableStore<typeof mixed>;
		const store = undefined as unknown as Store;

		// @ts-expect-error update() is deliberately unavailable on value fields:
		// a partial update cannot merge independently there.
		const _bad = () => store.update('atomic', 'nope');

		// Available on record fields.
		const _good = () => store.update('struct', {a: 1});

		expect(typeof _bad).toBe('function');
		expect(typeof _good).toBe('function');
	});
});

describe('record fields - schema shape contracts', () => {
	it('accepts type aliases and interfaces', () => {
		type AliasStruct = {theme: string; fontSize: number};
		interface InterfaceStruct {
			theme: string;
			fontSize: number;
		}

		const s = defineSchema({
			viaAlias: record<AliasStruct>(),
			viaInterface: record<InterfaceStruct>(),
			withOptional: record<{a?: string; b: number}>(),
			nested: record<{layout: {columns: number}}>(),
		});

		expect(s.viaAlias.__type).toBe('record');
		expect(s.viaInterface.__type).toBe('record');
	});

	it('rejects arrays and primitives at the schema', () => {
		defineSchema({
			// @ts-expect-error arrays merge as a whole - indices are jointly
			// constrained by order and length - so they belong in value<T>().
			tags: record<string[]>(),
		});

		defineSchema({
			// @ts-expect-error a primitive has no properties to merge independently.
			name: record<string>(),
		});

		defineSchema({
			// @ts-expect-error same for numbers.
			count: record<number>(),
		});

		expect(true).toBe(true);
	});

	it('accepts in value() everything record() rejects, so the advice holds', () => {
		// The rejection messages point at value<T>(). That has to be true.
		const s = defineSchema({
			tags: value<string[]>(),
			name: value<string>(),
			count: value<number>(),
			created: value<Date>(),
			// A struct whose properties carry a joint invariant belongs here too:
			// merging start and end independently can converge on start > end,
			// a range that existed on no device.
			range: value<{start: number; end: number}>(),
		});

		expect(s.tags.__type).toBe('value');
		expect(s.range.__type).toBe('value');
	});
});
