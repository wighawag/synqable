/**
 * Characterization tests: behaviour that MUST survive the field-type redesign.
 *
 * These pin the guarantees the library already makes, so that introducing a
 * third field type cannot silently change them. They are written against the
 * public seams only (merge functions, cleanup, store API).
 */

import {describe, it, expect} from 'vitest';
import {
	cleanup,
	createSyncableStore,
	defineSchema,
	map,
	mergeMap,
	mergeStore,
	value,
	type AsyncStorage,
	type InternalStorage,
} from '../src/index.js';

const schema = defineSchema({
	settings: value<{theme: string; volume: number}>(),
	operations: map<{tx: string; status: string}>(),
});

type TestSchema = typeof schema;

function emptyStorage(
	overrides: Partial<InternalStorage<TestSchema>>,
): InternalStorage<TestSchema> {
	return {
		$version: 1,
		data: {settings: {theme: 'dark', volume: 0.5}, operations: {}},
		$timestamps: {},
		$itemTimestamps: {operations: {}},
		$tombstones: {operations: {}},
		...overrides,
	} as InternalStorage<TestSchema>;
}

function createMockStorage(): AsyncStorage<InternalStorage<TestSchema>> {
	const data = new Map<string, InternalStorage<TestSchema>>();
	return {
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

// ============================================================================
// Atomic value semantics (Case 3) - must not change
// ============================================================================

describe('preserved: whole-value fields resolve as a single unit', () => {
	it('a newer whole-value write replaces every property, including ones it did not change', () => {
		const current = emptyStorage({
			data: {settings: {theme: 'dark', volume: 0.5}, operations: {}},
			$timestamps: {settings: 1000},
		});
		const incoming = emptyStorage({
			data: {settings: {theme: 'light', volume: 0.5}, operations: {}},
			$timestamps: {settings: 2000},
		});

		const result = mergeStore(current, incoming, schema);

		// The whole struct is taken from the winner, not merged property-wise.
		expect(result.merged.data.settings).toStrictEqual({theme: 'light', volume: 0.5});
		expect(result.merged.$timestamps.settings).toBe(2000);
		expect(result.changes).toContainEqual({
			event: 'settings:changed',
			data: {theme: 'light', volume: 0.5},
		});
	});

	it('an older whole-value write loses entirely and is flagged for re-push', () => {
		const current = emptyStorage({
			data: {settings: {theme: 'dark', volume: 0.9}, operations: {}},
			$timestamps: {settings: 3000},
		});
		const incoming = emptyStorage({
			data: {settings: {theme: 'light', volume: 0.1}, operations: {}},
			$timestamps: {settings: 1000},
		});

		const result = mergeStore(current, incoming, schema);

		expect(result.merged.data.settings).toStrictEqual({theme: 'dark', volume: 0.9});
		expect(result.hasLocalChanges).toBe(true);
	});

	it('equal timestamps resolve deterministically regardless of argument order', () => {
		const a = emptyStorage({
			data: {settings: {theme: 'aaa', volume: 0.5}, operations: {}},
			$timestamps: {settings: 5000},
		});
		const b = emptyStorage({
			data: {settings: {theme: 'zzz', volume: 0.5}, operations: {}},
			$timestamps: {settings: 5000},
		});

		const ab = mergeStore(a, b, schema);
		const ba = mergeStore(b, a, schema);

		expect(ab.merged.data.settings).toStrictEqual(ba.merged.data.settings);
	});
});

// ============================================================================
// The device-is-source-of-truth assumption (waxdb / secp256k1-db)
// ============================================================================

describe('preserved: empty server record keeps local data', () => {
	it('keeps local values, preserves tombstones and flags them for re-push', () => {
		const local = emptyStorage({
			data: {
				settings: {theme: 'light', volume: 0.8},
				operations: {'op-1': {tx: '0xaaa', status: 'done', deleteAt: 9_000_000}},
			},
			$timestamps: {settings: 4000},
			$itemTimestamps: {operations: {'op-1': 4100}},
			$tombstones: {operations: {'op-2': 9_000_000}},
		});
		const serverIsEmpty = emptyStorage({
			data: {settings: {theme: 'dark', volume: 0.5}, operations: {}},
			$timestamps: {},
		});

		const result = mergeStore(local, serverIsEmpty, schema);

		expect(result.merged.data.settings).toStrictEqual({theme: 'light', volume: 0.8});
		expect(result.merged.data.operations['op-1'].tx).toBe('0xaaa');
		expect(result.merged.$tombstones.operations).toStrictEqual({'op-2': 9_000_000});
		expect(result.hasLocalChanges).toBe(true);
	});

	it('does not flag pristine default data as a local change', () => {
		const a = emptyStorage({});
		const b = emptyStorage({});

		const result = mergeStore(a, b, schema);

		expect(result.hasLocalChanges).toBe(false);
		expect(result.changes).toStrictEqual([]);
	});
});

// ============================================================================
// Map semantics - must not change
// ============================================================================

describe('preserved: map fields merge per key', () => {
	it('two devices editing different keys converge to the union', () => {
		const deviceA = emptyStorage({
			data: {
				settings: {theme: 'dark', volume: 0.5},
				operations: {'op-a': {tx: '0xa', status: 'done', deleteAt: 9_000_000}},
			},
			$itemTimestamps: {operations: {'op-a': 1000}},
		});
		const deviceB = emptyStorage({
			data: {
				settings: {theme: 'dark', volume: 0.5},
				operations: {'op-b': {tx: '0xb', status: 'done', deleteAt: 9_000_000}},
			},
			$itemTimestamps: {operations: {'op-b': 2000}},
		});

		const ab = mergeStore(deviceA, deviceB, schema);
		const ba = mergeStore(deviceB, deviceA, schema);

		expect(Object.keys(ab.merged.data.operations).sort()).toStrictEqual(['op-a', 'op-b']);
		expect(Object.keys(ba.merged.data.operations).sort()).toStrictEqual(['op-a', 'op-b']);
	});

	it('a tombstone suppresses an item that still exists on the other device', () => {
		const withItem = {
			items: {'op-1': {tx: '0xa'}},
			timestamps: {'op-1': 1000},
			tombstones: {},
		};
		const withTombstone = {
			items: {},
			timestamps: {},
			tombstones: {'op-1': 9_000_000},
		};

		const result = mergeMap(withItem, withTombstone, 'operations');

		expect(result.items['op-1']).toBeUndefined();
		expect(result.tombstones['op-1']).toBe(9_000_000);
		expect(result.changes).toContainEqual({
			event: 'operations:removed',
			data: {key: 'op-1', item: {tx: '0xa'}},
		});
	});
});

// ============================================================================
// Cleanup - must not change for existing field types
// ============================================================================

describe('preserved: cleanup', () => {
	const now = 5_000;

	it('drops expired items and their timestamps but keeps live ones', () => {
		const storage = emptyStorage({
			data: {
				settings: {theme: 'dark', volume: 0.5},
				operations: {
					live: {tx: '0xlive', status: 'pending', deleteAt: now + 1000},
					expired: {tx: '0xdead', status: 'done', deleteAt: now - 1000},
				},
			},
			$itemTimestamps: {operations: {live: 100, expired: 200}},
		});

		const result = cleanup(storage, schema, now);

		expect(Object.keys(result.storage.data.operations)).toStrictEqual(['live']);
		expect(result.storage.$itemTimestamps.operations).toStrictEqual({live: 100});
		expect(result.changes).toContainEqual({
			event: 'operations:removed',
			data: {key: 'expired', item: {tx: '0xdead', status: 'done', deleteAt: now - 1000}},
		});
	});

	it('never touches a whole-value field or its timestamp', () => {
		const storage = emptyStorage({
			data: {settings: {theme: 'light', volume: 0.3}, operations: {}},
			$timestamps: {settings: 1},
		});

		const result = cleanup(storage, schema, now);

		expect(result.storage.data.settings).toStrictEqual({theme: 'light', volume: 0.3});
		expect(result.storage.$timestamps.settings).toBe(1);
	});

	it('expires tombstones once their deleteAt has passed', () => {
		const storage = emptyStorage({
			$tombstones: {operations: {stale: now - 1, fresh: now + 1}},
		});

		const result = cleanup(storage, schema, now);

		expect(result.storage.$tombstones.operations).toStrictEqual({fresh: now + 1});
		expect(result.tombstonesDeleted).toBe(true);
	});
});

// ============================================================================
// Store API surface
// ============================================================================

describe('preserved: store API', () => {
	it('set() on a whole-value field replaces it and emits a field-level changed event', async () => {
		let clock = 1000;
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => createMockStorage(), key: 'k'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});
		await store.load();

		const seen: unknown[] = [];
		store.on('settings:changed', (v) => seen.push(v));

		clock = 2000;
		store.set('settings', {theme: 'light', volume: 0.9});

		const state = store.get();
		expect(state.status).toBe('ready');
		if (state.status === 'ready') {
			expect(state.data.settings).toStrictEqual({theme: 'light', volume: 0.9});
		}
		expect(seen).toStrictEqual([{theme: 'light', volume: 0.9}]);

		store.stop();
	});

	it('watchField on a whole-value field pushes the new value to subscribers', async () => {
		let clock = 1000;
		const store = createSyncableStore({
			schema,
			account: '0x1234567890123456789012345678901234567890',
			storage: {adapterFactory: () => createMockStorage(), key: 'k'},
			defaultData: () => ({settings: {theme: 'dark', volume: 0.5}, operations: {}}),
			clock: () => clock,
		});
		await store.load();

		const seen: unknown[] = [];
		const unsub = store.watchField('settings').subscribe((v) => seen.push(v));

		clock = 2000;
		store.set('settings', {theme: 'light', volume: 0.9});

		expect(seen).toStrictEqual([
			{theme: 'dark', volume: 0.5},
			{theme: 'light', volume: 0.9},
		]);

		unsub();
		store.stop();
	});
});
