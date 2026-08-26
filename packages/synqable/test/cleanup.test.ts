import {describe, it, expect} from 'vitest';
import {cleanup, defineSchema, value, map} from '../src/index.js';

describe('cleanup', () => {
	const testSchema = defineSchema({
		settings: value<{theme: string}>(),
		operations: map<{tx: string; status: string}>(),
	});

	it('removes expired items past their deleteAt', () => {
		const now = 5000;
		const storage = {
			$version: 1,
			data: {
				settings: {theme: 'dark'},
				operations: {
					'op-1': {tx: '0x1', status: 'done', deleteAt: 3000}, // Expired
					'op-2': {tx: '0x2', status: 'pending', deleteAt: 7000}, // Still valid
				},
			},
			$timestamps: {settings: 1000},
			$itemTimestamps: {operations: {'op-1': 1000, 'op-2': 2000}},
			$tombstones: {operations: {}},
		};

		const result = cleanup(storage, testSchema, now);

		expect(result.storage.data.operations['op-1']).toBeUndefined();
		expect(result.storage.data.operations['op-2']).toBeDefined();
		expect(result.storage.$itemTimestamps.operations?.['op-1']).toBeUndefined();
		expect(result.storage.$itemTimestamps.operations?.['op-2']).toBe(2000);

		// Should emit :removed change for expired item
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].event).toBe('operations:removed');
		expect(result.changes[0].data).toEqual({
			key: 'op-1',
			item: {tx: '0x1', status: 'done', deleteAt: 3000},
		});
	});

	it('removes expired tombstones past their deleteAt', () => {
		const now = 5000;
		const storage = {
			$version: 1,
			data: {
				settings: {theme: 'dark'},
				operations: {},
			},
			$timestamps: {settings: 1000},
			$itemTimestamps: {operations: {}},
			$tombstones: {
				operations: {
					'old-item': 3000, // Expired tombstone
					'recent-item': 7000, // Still valid tombstone
				},
			},
		};

		const result = cleanup(storage, testSchema, now);

		expect(result.storage.$tombstones.operations?.['old-item']).toBeUndefined();
		expect(result.storage.$tombstones.operations?.['recent-item']).toBe(7000);

		// Should set tombstonesDeleted flag
		expect(result.tombstonesDeleted).toBe(true);
		// No items were cleaned up, so no changes
		expect(result.changes).toHaveLength(0);
	});

	it('keeps valid items and tombstones', () => {
		const now = 2000;
		const storage = {
			$version: 1,
			data: {
				settings: {theme: 'light'},
				operations: {
					'op-1': {tx: '0x1', status: 'pending', deleteAt: 5000},
				},
			},
			$timestamps: {settings: 1000},
			$itemTimestamps: {operations: {'op-1': 1500}},
			$tombstones: {operations: {'deleted-1': 6000}},
		};

		const result = cleanup(storage, testSchema, now);

		expect(result.storage.data.operations['op-1']).toBeDefined();
		expect(result.storage.$tombstones.operations?.['deleted-1']).toBe(6000);

		// No items or tombstones expired
		expect(result.changes).toHaveLength(0);
		expect(result.tombstonesDeleted).toBe(false);
	});

	it('does not modify value fields', () => {
		const now = 99999;
		const storage = {
			$version: 1,
			data: {
				settings: {theme: 'dark'},
				operations: {},
			},
			$timestamps: {settings: 1000},
			$itemTimestamps: {operations: {}},
			$tombstones: {operations: {}},
		};

		const result = cleanup(storage, testSchema, now);

		// Value fields are never cleaned up regardless of timestamp
		expect(result.storage.data.settings).toStrictEqual({theme: 'dark'});
		expect(result.storage.$timestamps.settings).toBe(1000);
	});

	it('uses Date.now() when no time is provided', () => {
		const storage = {
			$version: 1,
			data: {
				settings: {theme: 'dark'},
				operations: {
					'old-op': {tx: '0x1', status: 'done', deleteAt: 1}, // Definitely expired
				},
			},
			$timestamps: {settings: 1000},
			$itemTimestamps: {operations: {'old-op': 1}},
			$tombstones: {operations: {}},
		};

		const result = cleanup(storage, testSchema);

		// Item with deleteAt: 1 should be expired (it's in the past)
		expect(result.storage.data.operations['old-op']).toBeUndefined();

		// Should emit :removed change
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].event).toBe('operations:removed');
	});
});
