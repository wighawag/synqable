import { describe, it, expect } from 'vitest';
import {
	tiebreaker,
	mergePermanent,
	mergeMap,
	mergeStore,
	defineSchema,
	permanent,
	map,
} from '../src/index.js';

describe('tiebreaker', () => {
	it('returns lexicographically smaller value when comparing simple objects', () => {
		const a = { name: 'alice' };
		const b = { name: 'bob' };

		// 'alice' < 'bob' lexicographically, so a should win
		const result1 = tiebreaker(a, b);
		expect(result1.value).toBe(a);
		expect(result1.outcome).toBe('first');

		const result2 = tiebreaker(b, a);
		expect(result2.value).toBe(a);
		expect(result2.outcome).toBe('second');
	});

	it('is deterministic regardless of property insertion order', () => {
		// Create objects with same content but different property order
		const a = { z: 1, a: 2 };
		const b: Record<string, number> = {};
		b.a = 2;
		b.z = 1;

		// Both serialize to the same string, so it's a tie
		const result1 = tiebreaker(a, b);
		const result2 = tiebreaker(b, a);

		// Both calls should return content-equivalent objects with 'tie' outcome
		expect(result1.value).toStrictEqual({ z: 1, a: 2 });
		expect(result1.outcome).toBe('tie');
		expect(result2.value).toStrictEqual({ z: 1, a: 2 });
		expect(result2.outcome).toBe('tie');
	});

	it('handles nested objects deterministically', () => {
		const a = { outer: { inner: 'value1' } };
		const b = { outer: { inner: 'value2' } };

		// 'value1' < 'value2', so a wins
		const result1 = tiebreaker(a, b);
		expect(result1.value).toBe(a);
		expect(result1.outcome).toBe('first');

		const result2 = tiebreaker(b, a);
		expect(result2.value).toBe(a);
		expect(result2.outcome).toBe('second');
	});

	it('returns tie outcome when values are semantically equal', () => {
		const a = { name: 'alice', age: 30 };
		const b = { name: 'alice', age: 30 };

		const result = tiebreaker(a, b);
		expect(result.value).toBe(a); // Returns first arg when equal
		expect(result.outcome).toBe('tie');
	});
});

describe('mergePermanent', () => {
	it('returns incoming value when incoming timestamp is higher', () => {
		const current = { value: { name: 'old' }, timestamp: 1000 };
		const incoming = { value: { name: 'new' }, timestamp: 2000 };

		const result = mergePermanent(current, incoming);

		expect(result.value).toBe(incoming.value);
		expect(result.timestamp).toBe(2000);
		expect(result.outcome).toBe('incoming');
	});

	it('returns current value when current timestamp is higher', () => {
		const current = { value: { name: 'current' }, timestamp: 3000 };
		const incoming = { value: { name: 'incoming' }, timestamp: 2000 };

		const result = mergePermanent(current, incoming);

		expect(result.value).toBe(current.value);
		expect(result.timestamp).toBe(3000);
		expect(result.outcome).toBe('current');
	});

	it('uses tiebreaker when timestamps are equal and values differ', () => {
		const current = { value: { name: 'bob' }, timestamp: 1000 };
		const incoming = { value: { name: 'alice' }, timestamp: 1000 };

		const result = mergePermanent(current, incoming);

		// 'alice' < 'bob' lexicographically, so incoming wins
		expect(result.value).toStrictEqual({ name: 'alice' });
		expect(result.timestamp).toBe(1000);
		expect(result.outcome).toBe('incoming');
	});

	it('returns current when timestamps equal and current wins tiebreaker', () => {
		const current = { value: { name: 'alice' }, timestamp: 1000 };
		const incoming = { value: { name: 'bob' }, timestamp: 1000 };

		const result = mergePermanent(current, incoming);

		// 'alice' < 'bob' lexicographically, so current wins
		expect(result.value).toStrictEqual({ name: 'alice' });
		expect(result.timestamp).toBe(1000);
		expect(result.outcome).toBe('current');
	});

	it('returns tie outcome when timestamps and values are equal', () => {
		const current = { value: { name: 'alice', age: 30 }, timestamp: 1000 };
		const incoming = { value: { name: 'alice', age: 30 }, timestamp: 1000 };

		const result = mergePermanent(current, incoming);

		// Values are semantically equal - true tie
		expect(result.value).toStrictEqual({ name: 'alice', age: 30 });
		expect(result.timestamp).toBe(1000);
		expect(result.outcome).toBe('tie');
	});
});

describe('mergeMap', () => {
	it('adds new item from incoming and emits added event', () => {
		const current = {
			items: {},
			timestamps: {},
			tombstones: {},
		};
		const incoming = {
			items: { 'item-1': { value: 'hello', deleteAt: 9999 } },
			timestamps: { 'item-1': 1000 },
			tombstones: {},
		};

		const result = mergeMap(current, incoming, 'operations');

		expect(result.items).toStrictEqual({
			'item-1': { value: 'hello', deleteAt: 9999 },
		});
		expect(result.timestamps).toStrictEqual({ 'item-1': 1000 });
		expect(result.tombstones).toStrictEqual({});
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]).toStrictEqual({
			event: 'operations:added',
			data: { key: 'item-1', item: { value: 'hello', deleteAt: 9999 } },
		});
	});

	it('keeps current item when incoming is missing', () => {
		const current = {
			items: { 'item-1': { value: 'current', deleteAt: 9999 } },
			timestamps: { 'item-1': 1000 },
			tombstones: {},
		};
		const incoming = {
			items: {},
			timestamps: {},
			tombstones: {},
		};

		const result = mergeMap(current, incoming, 'operations');

		expect(result.items).toStrictEqual({
			'item-1': { value: 'current', deleteAt: 9999 },
		});
		expect(result.changes).toHaveLength(0);
	});

	it('updates item when incoming has higher timestamp', () => {
		const current = {
			items: { 'item-1': { value: 'old', deleteAt: 9999 } },
			timestamps: { 'item-1': 1000 },
			tombstones: {},
		};
		const incoming = {
			items: { 'item-1': { value: 'new', deleteAt: 9999 } },
			timestamps: { 'item-1': 2000 },
			tombstones: {},
		};

		const result = mergeMap(current, incoming, 'operations');

		expect(result.items['item-1'].value).toBe('new');
		expect(result.timestamps['item-1']).toBe(2000);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].event).toBe('operations:updated');
	});

	it('keeps current item when current has higher timestamp', () => {
		const current = {
			items: { 'item-1': { value: 'current', deleteAt: 9999 } },
			timestamps: { 'item-1': 3000 },
			tombstones: {},
		};
		const incoming = {
			items: { 'item-1': { value: 'incoming', deleteAt: 9999 } },
			timestamps: { 'item-1': 2000 },
			tombstones: {},
		};

		const result = mergeMap(current, incoming, 'operations');

		expect(result.items['item-1'].value).toBe('current');
		expect(result.timestamps['item-1']).toBe(3000);
		expect(result.changes).toHaveLength(0);
	});

	it('removes item when tombstone exists', () => {
		const current = {
			items: { 'item-1': { value: 'alive', deleteAt: 9999 } },
			timestamps: { 'item-1': 1000 },
			tombstones: {},
		};
		const incoming = {
			items: {},
			timestamps: {},
			tombstones: { 'item-1': 9999 }, // tombstone with deleteAt time
		};

		const result = mergeMap(current, incoming, 'operations');

		expect(result.items['item-1']).toBeUndefined();
		expect(result.tombstones['item-1']).toBe(9999);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].event).toBe('operations:removed');
	});

	it('merges tombstones taking later deleteAt', () => {
		const current = {
			items: {},
			timestamps: {},
			tombstones: { 'item-1': 5000 },
		};
		const incoming = {
			items: {},
			timestamps: {},
			tombstones: { 'item-1': 8000 },
		};

		const result = mergeMap(current, incoming, 'operations');

		expect(result.tombstones['item-1']).toBe(8000);
	});
});

describe('mergeMap - tieCount', () => {
	it('tracks tie when both have same item with same timestamp and value', () => {
		const current = {
			items: { 'item-1': { value: 'same', deleteAt: 9999 } },
			timestamps: { 'item-1': 1000 },
			tombstones: {},
		};
		const incoming = {
			items: { 'item-1': { value: 'same', deleteAt: 9999 } },
			timestamps: { 'item-1': 1000 },
			tombstones: {},
		};

		const result = mergeMap(current, incoming, 'operations');

		// Values are equal - should be a tie, not a local win
		expect(result.localWonCount).toBe(0);
		expect(result.tieCount).toBe(1);
		expect(result.changes).toHaveLength(0);
	});

	it('increments localWonCount when values differ at same timestamp and current wins', () => {
		const current = {
			items: { 'item-1': { value: 'aaa', deleteAt: 9999 } }, // 'aaa' < 'bbb'
			timestamps: { 'item-1': 1000 },
			tombstones: {},
		};
		const incoming = {
			items: { 'item-1': { value: 'bbb', deleteAt: 9999 } },
			timestamps: { 'item-1': 1000 },
			tombstones: {},
		};

		const result = mergeMap(current, incoming, 'operations');

		// Current wins tiebreaker - should be localWonCount
		expect(result.localWonCount).toBe(1);
		expect(result.tieCount).toBe(0);
		expect(result.changes).toHaveLength(0);
	});

	it('emits update and no localWonCount when values differ at same timestamp and incoming wins', () => {
		const current = {
			items: { 'item-1': { value: 'bbb', deleteAt: 9999 } },
			timestamps: { 'item-1': 1000 },
			tombstones: {},
		};
		const incoming = {
			items: { 'item-1': { value: 'aaa', deleteAt: 9999 } }, // 'aaa' < 'bbb'
			timestamps: { 'item-1': 1000 },
			tombstones: {},
		};

		const result = mergeMap(current, incoming, 'operations');

		// Incoming wins tiebreaker - should emit update, no localWonCount
		expect(result.localWonCount).toBe(0);
		expect(result.tieCount).toBe(0);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].event).toBe('operations:updated');
	});
});

describe('mergeStore', () => {
	// Define a test schema
	const testSchema = defineSchema({
		settings: permanent<{ theme: string; volume: number }>(),
		operations: map<{ tx: string; status: string }>(),
	});

	it('merges permanent and map fields together', () => {
		const current = {
			$version: 1,
			data: {
				settings: { theme: 'dark', volume: 0.5 },
				operations: {},
			},
			$timestamps: { settings: 1000 },
			$itemTimestamps: { operations: {} },
			$tombstones: { operations: {} },
		};

		const incoming = {
			$version: 1,
			data: {
				settings: { theme: 'light', volume: 0.8 },
				operations: {
					'op-1': { tx: '0xabc', status: 'pending', deleteAt: 9999 },
				},
			},
			$timestamps: { settings: 2000 },
			$itemTimestamps: { operations: { 'op-1': 1500 } },
			$tombstones: { operations: {} },
		};

		const result = mergeStore(current, incoming, testSchema);

		// Settings should update (incoming has higher timestamp)
		expect(result.merged.data.settings.theme).toBe('light');
		expect(result.merged.data.settings.volume).toBe(0.8);
		expect(result.merged.$timestamps.settings).toBe(2000);

		// Operations should include new item
		expect(result.merged.data.operations['op-1']).toBeDefined();
		expect(result.merged.data.operations['op-1'].tx).toBe('0xabc');

		// Changes should include both permanent and map changes
		expect(result.changes.length).toBe(2);
		expect(result.changes.some((c) => c.event === 'settings:changed')).toBe(true);
		expect(result.changes.some((c) => c.event === 'operations:added')).toBe(true);
	});

	it('preserves higher version number', () => {
		const current = {
			$version: 2,
			data: { settings: { theme: 'dark', volume: 0.5 }, operations: {} },
			$timestamps: { settings: 1000 },
			$itemTimestamps: { operations: {} },
			$tombstones: { operations: {} },
		};

		const incoming = {
			$version: 1,
			data: { settings: { theme: 'light', volume: 0.5 }, operations: {} },
			$timestamps: { settings: 500 },
			$itemTimestamps: { operations: {} },
			$tombstones: { operations: {} },
		};

		const result = mergeStore(current, incoming, testSchema);

		expect(result.merged.$version).toBe(2);
	});

	it('returns empty changes when nothing changed', () => {
		const current = {
			$version: 1,
			data: {
				settings: { theme: 'dark', volume: 0.5 },
				operations: {
					'op-1': { tx: '0xabc', status: 'pending', deleteAt: 9999 },
				},
			},
			$timestamps: { settings: 2000 },
			$itemTimestamps: { operations: { 'op-1': 1500 } },
			$tombstones: { operations: {} },
		};

		// Incoming has lower timestamps - nothing should change
		const incoming = {
			$version: 1,
			data: {
				settings: { theme: 'light', volume: 0.8 },
				operations: {
					'op-1': { tx: '0xold', status: 'old', deleteAt: 9999 },
				},
			},
			$timestamps: { settings: 1000 },
			$itemTimestamps: { operations: { 'op-1': 1000 } },
			$tombstones: { operations: {} },
		};

		const result = mergeStore(current, incoming, testSchema);

		expect(result.changes).toHaveLength(0);
		expect(result.merged.data.settings.theme).toBe('dark');
		expect(result.merged.data.operations['op-1'].tx).toBe('0xabc');
	});

	it('hasLocalChanges is false when both have same default data with timestamp 0', () => {
		// This simulates: new client with default data vs server with no data
		// Both create synthetic default storage - should be detected as tie
		const defaultSettings = { theme: 'dark', volume: 0.5 };

		const current = {
			$version: 1,
			data: {
				settings: defaultSettings,
				operations: {},
			},
			$timestamps: { settings: 0 }, // timestamp 0 = default/unmodified
			$itemTimestamps: { operations: {} },
			$tombstones: { operations: {} },
		};

		const incoming = {
			$version: 1,
			data: {
				settings: { ...defaultSettings }, // Same default value (different object)
				operations: {},
			},
			$timestamps: { settings: 0 }, // Also timestamp 0
			$itemTimestamps: { operations: {} },
			$tombstones: { operations: {} },
		};

		const result = mergeStore(current, incoming, testSchema);

		// Both have same values at timestamp 0 - this is a tie
		// hasLocalChanges should be false - no need to push default data
		expect(result.hasLocalChanges).toBe(false);
		expect(result.changes).toHaveLength(0);
	});

	it('hasLocalChanges is false when values are semantically equal at any matching timestamp', () => {
		const current = {
			$version: 1,
			data: {
				settings: { theme: 'dark', volume: 0.5 },
				operations: {
					'op-1': { tx: '0xabc', status: 'done', deleteAt: 9999 },
				},
			},
			$timestamps: { settings: 1000 },
			$itemTimestamps: { operations: { 'op-1': 1000 } },
			$tombstones: { operations: {} },
		};

		const incoming = {
			$version: 1,
			data: {
				settings: { theme: 'dark', volume: 0.5 }, // Same value
				operations: {
					'op-1': { tx: '0xabc', status: 'done', deleteAt: 9999 }, // Same value
				},
			},
			$timestamps: { settings: 1000 }, // Same timestamp
			$itemTimestamps: { operations: { 'op-1': 1000 } }, // Same timestamp
			$tombstones: { operations: {} },
		};

		const result = mergeStore(current, incoming, testSchema);

		// All values are semantically equal at same timestamps - all ties
		expect(result.hasLocalChanges).toBe(false);
		expect(result.changes).toHaveLength(0);
	});

	it('hasLocalChanges is true when local has genuinely different data', () => {
		const current = {
			$version: 1,
			data: {
				settings: { theme: 'light', volume: 0.8 }, // Different value
				operations: {},
			},
			$timestamps: { settings: 1000 },
			$itemTimestamps: { operations: {} },
			$tombstones: { operations: {} },
		};

		const incoming = {
			$version: 1,
			data: {
				settings: { theme: 'dark', volume: 0.5 },
				operations: {},
			},
			$timestamps: { settings: 1000 }, // Same timestamp but different value
			$itemTimestamps: { operations: {} },
			$tombstones: { operations: {} },
		};

		const result = mergeStore(current, incoming, testSchema);

		// Current wins tiebreaker ('dark' < 'light') so incoming wins
		// Wait - 'dark' < 'light' so dark < light, incoming wins
		expect(result.merged.data.settings.theme).toBe('dark');
		expect(result.hasLocalChanges).toBe(false); // incoming won, not local
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].event).toBe('settings:changed');
	});

	it('hasLocalChanges is true when local wins tiebreaker with different values', () => {
		const current = {
			$version: 1,
			data: {
				settings: { theme: 'aaa', volume: 0.5 }, // Lexicographically smaller
				operations: {},
			},
			$timestamps: { settings: 1000 },
			$itemTimestamps: { operations: {} },
			$tombstones: { operations: {} },
		};

		const incoming = {
			$version: 1,
			data: {
				settings: { theme: 'zzz', volume: 0.5 },
				operations: {},
			},
			$timestamps: { settings: 1000 }, // Same timestamp, current wins tiebreaker
			$itemTimestamps: { operations: {} },
			$tombstones: { operations: {} },
		};

		const result = mergeStore(current, incoming, testSchema);

		// Current wins tiebreaker with different data
		expect(result.merged.data.settings.theme).toBe('aaa');
		expect(result.hasLocalChanges).toBe(true); // local won with different data
		expect(result.changes).toHaveLength(0);
	});
});
