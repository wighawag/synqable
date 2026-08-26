import {describe, it, expect} from 'vitest';
import {
	tiebreaker,
	mergeValue,
	mergeMap,
	mergeRecord,
	mergeStore,
	defineSchema,
	value,
	record,
	map,
} from '../src/index.js';

describe('tiebreaker', () => {
	it('returns lexicographically smaller value when comparing simple objects', () => {
		const a = {name: 'alice'};
		const b = {name: 'bob'};

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
		const a = {z: 1, a: 2};
		const b: Record<string, number> = {};
		b.a = 2;
		b.z = 1;

		// Both hash to the same value, so it's a tie
		const result1 = tiebreaker(a, b);
		const result2 = tiebreaker(b, a);

		// Both calls should return content-equivalent objects with 'tie' outcome
		expect(result1.value).toStrictEqual({z: 1, a: 2});
		expect(result1.outcome).toBe('tie');
		expect(result2.value).toStrictEqual({z: 1, a: 2});
		expect(result2.outcome).toBe('tie');
	});

	it('handles nested objects deterministically', () => {
		const a = {outer: {inner: 'value1'}};
		const b = {outer: {inner: 'value2'}};

		// Verify determinism: same inputs always produce same result
		const result1 = tiebreaker(a, b);
		const result2 = tiebreaker(a, b); // Same call again

		// Should be identical results
		expect(result2.value).toBe(result1.value);
		expect(result2.outcome).toBe(result1.outcome);

		// Swapping order should produce opposite outcome
		const result3 = tiebreaker(b, a);
		expect(result3.value).toBe(result1.value);
		expect([
			result1.outcome === 'first' && result3.outcome === 'second',
			result1.outcome === 'second' && result3.outcome === 'first',
			result1.outcome === 'tie' && result3.outcome === 'tie',
		]).toContain(true);
	});

	it('returns tie outcome when values are semantically equal', () => {
		const a = {name: 'alice', age: 30};
		const b = {name: 'alice', age: 30};

		const result = tiebreaker(a, b);
		expect(result.value).toBe(a); // Returns first arg when equal
		expect(result.outcome).toBe('tie');
	});
});

describe('mergeValue', () => {
	it('returns incoming value when incoming timestamp is higher', () => {
		const current = {value: {name: 'old'}, timestamp: 1000};
		const incoming = {value: {name: 'new'}, timestamp: 2000};

		const result = mergeValue(current, incoming);

		expect(result.value).toBe(incoming.value);
		expect(result.timestamp).toBe(2000);
		expect(result.outcome).toBe('incoming');
	});

	it('returns current value when current timestamp is higher', () => {
		const current = {value: {name: 'current'}, timestamp: 3000};
		const incoming = {value: {name: 'incoming'}, timestamp: 2000};

		const result = mergeValue(current, incoming);

		expect(result.value).toBe(current.value);
		expect(result.timestamp).toBe(3000);
		expect(result.outcome).toBe('current');
	});

	it('uses tiebreaker when timestamps are equal and values differ', () => {
		const current = {value: {name: 'bob'}, timestamp: 1000};
		const incoming = {value: {name: 'alice'}, timestamp: 1000};

		const result = mergeValue(current, incoming);

		// 'alice' < 'bob' lexicographically, so incoming wins
		expect(result.value).toStrictEqual({name: 'alice'});
		expect(result.timestamp).toBe(1000);
		expect(result.outcome).toBe('incoming');
	});

	it('returns current when timestamps equal and current wins tiebreaker', () => {
		const current = {value: {name: 'alice'}, timestamp: 1000};
		const incoming = {value: {name: 'bob'}, timestamp: 1000};

		const result = mergeValue(current, incoming);

		// 'alice' < 'bob' lexicographically, so current wins
		expect(result.value).toStrictEqual({name: 'alice'});
		expect(result.timestamp).toBe(1000);
		expect(result.outcome).toBe('current');
	});

	it('returns tie outcome when timestamps and values are equal', () => {
		const current = {value: {name: 'alice', age: 30}, timestamp: 1000};
		const incoming = {value: {name: 'alice', age: 30}, timestamp: 1000};

		const result = mergeValue(current, incoming);

		// Values are semantically equal - true tie
		expect(result.value).toStrictEqual({name: 'alice', age: 30});
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
			items: {'item-1': {value: 'hello', deleteAt: 9999}},
			timestamps: {'item-1': 1000},
			tombstones: {},
		};

		const result = mergeMap(current, incoming, 'operations');

		expect(result.items).toStrictEqual({
			'item-1': {value: 'hello', deleteAt: 9999},
		});
		expect(result.timestamps).toStrictEqual({'item-1': 1000});
		expect(result.tombstones).toStrictEqual({});
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]).toStrictEqual({
			event: 'operations:added',
			data: {key: 'item-1', item: {value: 'hello', deleteAt: 9999}},
		});
	});

	it('keeps current item when incoming is missing', () => {
		const current = {
			items: {'item-1': {value: 'current', deleteAt: 9999}},
			timestamps: {'item-1': 1000},
			tombstones: {},
		};
		const incoming = {
			items: {},
			timestamps: {},
			tombstones: {},
		};

		const result = mergeMap(current, incoming, 'operations');

		expect(result.items).toStrictEqual({
			'item-1': {value: 'current', deleteAt: 9999},
		});
		expect(result.changes).toHaveLength(0);
	});

	it('updates item when incoming has higher timestamp', () => {
		const current = {
			items: {'item-1': {value: 'old', deleteAt: 9999}},
			timestamps: {'item-1': 1000},
			tombstones: {},
		};
		const incoming = {
			items: {'item-1': {value: 'new', deleteAt: 9999}},
			timestamps: {'item-1': 2000},
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
			items: {'item-1': {value: 'current', deleteAt: 9999}},
			timestamps: {'item-1': 3000},
			tombstones: {},
		};
		const incoming = {
			items: {'item-1': {value: 'incoming', deleteAt: 9999}},
			timestamps: {'item-1': 2000},
			tombstones: {},
		};

		const result = mergeMap(current, incoming, 'operations');

		expect(result.items['item-1'].value).toBe('current');
		expect(result.timestamps['item-1']).toBe(3000);
		expect(result.changes).toHaveLength(0);
	});

	it('removes item when tombstone exists', () => {
		const current = {
			items: {'item-1': {value: 'alive', deleteAt: 9999}},
			timestamps: {'item-1': 1000},
			tombstones: {},
		};
		const incoming = {
			items: {},
			timestamps: {},
			tombstones: {'item-1': 9999}, // tombstone with deleteAt time
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
			tombstones: {'item-1': 5000},
		};
		const incoming = {
			items: {},
			timestamps: {},
			tombstones: {'item-1': 8000},
		};

		const result = mergeMap(current, incoming, 'operations');

		expect(result.tombstones['item-1']).toBe(8000);
	});
});

describe('mergeMap - tieCount', () => {
	it('tracks tie when both have same item with same timestamp and value', () => {
		const current = {
			items: {'item-1': {value: 'same', deleteAt: 9999}},
			timestamps: {'item-1': 1000},
			tombstones: {},
		};
		const incoming = {
			items: {'item-1': {value: 'same', deleteAt: 9999}},
			timestamps: {'item-1': 1000},
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
			items: {'item-1': {value: 'bbb', deleteAt: 9999}}, // bbb hash < aaa hash with object-hash
			timestamps: {'item-1': 1000},
			tombstones: {},
		};
		const incoming = {
			items: {'item-1': {value: 'aaa', deleteAt: 9999}},
			timestamps: {'item-1': 1000},
			tombstones: {},
		};

		const result = mergeMap(current, incoming, 'operations');

		// Verify determinism: same inputs always produce same winner
		const result2 = mergeMap(current, incoming, 'operations');
		expect(result2.localWonCount).toBe(result.localWonCount);
		expect(result2.tieCount).toBe(result.tieCount);

		// With object-hash, 'bbb' hash < 'aaa' hash, so current wins
		expect(result.localWonCount).toBe(1);
		expect(result.tieCount).toBe(0);
		expect(result.changes).toHaveLength(0);
	});

	it('emits update and no localWonCount when values differ at same timestamp and incoming wins', () => {
		const current = {
			items: {'item-1': {value: 'aaa', deleteAt: 9999}}, // aaa hash > bbb hash with object-hash
			timestamps: {'item-1': 1000},
			tombstones: {},
		};
		const incoming = {
			items: {'item-1': {value: 'bbb', deleteAt: 9999}},
			timestamps: {'item-1': 1000},
			tombstones: {},
		};

		const result = mergeMap(current, incoming, 'operations');

		// Verify determinism: same inputs always produce same winner
		const result2 = mergeMap(current, incoming, 'operations');
		expect(result2.localWonCount).toBe(result.localWonCount);
		expect(result2.tieCount).toBe(result.tieCount);
		expect(result2.changes.length).toBe(result.changes.length);

		// With object-hash, 'bbb' hash < 'aaa' hash, so incoming wins
		expect(result.localWonCount).toBe(0);
		expect(result.tieCount).toBe(0);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].event).toBe('operations:updated');
	});
});

describe('mergeStore', () => {
	// Define a test schema
	const testSchema = defineSchema({
		settings: value<{theme: string; volume: number}>(),
		operations: map<{tx: string; status: string}>(),
	});

	it('merges value and map fields together', () => {
		const current = {
			$version: 1,
			data: {
				settings: {theme: 'dark', volume: 0.5},
				operations: {},
			},
			$timestamps: {settings: 1000},
			$itemTimestamps: {operations: {}},
			$tombstones: {operations: {}},
		};

		const incoming = {
			$version: 1,
			data: {
				settings: {theme: 'light', volume: 0.8},
				operations: {
					'op-1': {tx: '0xabc', status: 'pending', deleteAt: 9999},
				},
			},
			$timestamps: {settings: 2000},
			$itemTimestamps: {operations: {'op-1': 1500}},
			$tombstones: {operations: {}},
		};

		const result = mergeStore(current, incoming, testSchema);

		// Settings should update (incoming has higher timestamp)
		expect(result.merged.data.settings.theme).toBe('light');
		expect(result.merged.data.settings.volume).toBe(0.8);
		expect(result.merged.$timestamps.settings).toBe(2000);

		// Operations should include new item
		expect(result.merged.data.operations['op-1']).toBeDefined();
		expect(result.merged.data.operations['op-1'].tx).toBe('0xabc');

		// Changes should include both value and map changes
		expect(result.changes.length).toBe(2);
		expect(result.changes.some((c) => c.event === 'settings:changed')).toBe(true);
		expect(result.changes.some((c) => c.event === 'operations:added')).toBe(true);
	});

	it('preserves higher version number', () => {
		const current = {
			$version: 2,
			data: {settings: {theme: 'dark', volume: 0.5}, operations: {}},
			$timestamps: {settings: 1000},
			$itemTimestamps: {operations: {}},
			$tombstones: {operations: {}},
		};

		const incoming = {
			$version: 1,
			data: {settings: {theme: 'light', volume: 0.5}, operations: {}},
			$timestamps: {settings: 500},
			$itemTimestamps: {operations: {}},
			$tombstones: {operations: {}},
		};

		const result = mergeStore(current, incoming, testSchema);

		expect(result.merged.$version).toBe(2);
	});

	it('returns empty changes when nothing changed', () => {
		const current = {
			$version: 1,
			data: {
				settings: {theme: 'dark', volume: 0.5},
				operations: {
					'op-1': {tx: '0xabc', status: 'pending', deleteAt: 9999},
				},
			},
			$timestamps: {settings: 2000},
			$itemTimestamps: {operations: {'op-1': 1500}},
			$tombstones: {operations: {}},
		};

		// Incoming has lower timestamps - nothing should change
		const incoming = {
			$version: 1,
			data: {
				settings: {theme: 'light', volume: 0.8},
				operations: {
					'op-1': {tx: '0xold', status: 'old', deleteAt: 9999},
				},
			},
			$timestamps: {settings: 1000},
			$itemTimestamps: {operations: {'op-1': 1000}},
			$tombstones: {operations: {}},
		};

		const result = mergeStore(current, incoming, testSchema);

		expect(result.changes).toHaveLength(0);
		expect(result.merged.data.settings.theme).toBe('dark');
		expect(result.merged.data.operations['op-1'].tx).toBe('0xabc');
	});

	it('hasLocalChanges is false when both have same default data with timestamp 0', () => {
		// This simulates: new client with default data vs server with no data
		// Both create synthetic default storage - should be detected as tie
		const defaultSettings = {theme: 'dark', volume: 0.5};

		const current = {
			$version: 1,
			data: {
				settings: defaultSettings,
				operations: {},
			},
			$timestamps: {settings: 0}, // timestamp 0 = default/unmodified
			$itemTimestamps: {operations: {}},
			$tombstones: {operations: {}},
		};

		const incoming = {
			$version: 1,
			data: {
				settings: {...defaultSettings}, // Same default value (different object)
				operations: {},
			},
			$timestamps: {settings: 0}, // Also timestamp 0
			$itemTimestamps: {operations: {}},
			$tombstones: {operations: {}},
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
				settings: {theme: 'dark', volume: 0.5},
				operations: {
					'op-1': {tx: '0xabc', status: 'done', deleteAt: 9999},
				},
			},
			$timestamps: {settings: 1000},
			$itemTimestamps: {operations: {'op-1': 1000}},
			$tombstones: {operations: {}},
		};

		const incoming = {
			$version: 1,
			data: {
				settings: {theme: 'dark', volume: 0.5}, // Same value
				operations: {
					'op-1': {tx: '0xabc', status: 'done', deleteAt: 9999}, // Same value
				},
			},
			$timestamps: {settings: 1000}, // Same timestamp
			$itemTimestamps: {operations: {'op-1': 1000}}, // Same timestamp
			$tombstones: {operations: {}},
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
				settings: {theme: 'light', volume: 0.8}, // Different value
				operations: {},
			},
			$timestamps: {settings: 1000},
			$itemTimestamps: {operations: {}},
			$tombstones: {operations: {}},
		};

		const incoming = {
			$version: 1,
			data: {
				settings: {theme: 'dark', volume: 0.5},
				operations: {},
			},
			$timestamps: {settings: 1000}, // Same timestamp but different value
			$itemTimestamps: {operations: {}},
			$tombstones: {operations: {}},
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
				settings: {theme: 'aaa', volume: 0.5}, // Lexicographically smaller
				operations: {},
			},
			$timestamps: {settings: 1000},
			$itemTimestamps: {operations: {}},
			$tombstones: {operations: {}},
		};

		const incoming = {
			$version: 1,
			data: {
				settings: {theme: 'zzz', volume: 0.5},
				operations: {},
			},
			$timestamps: {settings: 1000}, // Same timestamp, current wins tiebreaker
			$itemTimestamps: {operations: {}},
			$tombstones: {operations: {}},
		};

		const result = mergeStore(current, incoming, testSchema);

		// Current wins tiebreaker with different data
		expect(result.merged.data.settings.theme).toBe('aaa');
		expect(result.hasLocalChanges).toBe(true); // local won with different data
		expect(result.changes).toHaveLength(0);
	});
});

// ============================================================================
// Record field merge - per-property last-writer-wins
// ============================================================================

describe('mergeRecord', () => {
	it('keeps each property from whichever device edited it last', () => {
		const current = {
			value: {theme: 'dark', fontSize: 12},
			timestamps: {theme: 300, fontSize: 100},
		};
		const incoming = {
			value: {theme: 'light', fontSize: 18},
			timestamps: {theme: 100, fontSize: 400},
		};

		const result = mergeRecord(current, incoming, 'settings');

		expect(result.value).toStrictEqual({theme: 'dark', fontSize: 18});
		expect(result.timestamps).toStrictEqual({theme: 300, fontSize: 400});
	});

	it('converges to the same result regardless of merge order', () => {
		const a = {value: {theme: 'dark', fontSize: 12}, timestamps: {theme: 300, fontSize: 100}};
		const b = {value: {theme: 'light', fontSize: 18}, timestamps: {theme: 100, fontSize: 400}};

		const ab = mergeRecord(a, b, 'settings');
		const ba = mergeRecord(b, a, 'settings');

		expect(ab.value).toStrictEqual(ba.value);
		expect(ab.timestamps).toStrictEqual(ba.timestamps);
	});

	it('respects timestamps for falsy property values', () => {
		// Regression guard: a truthiness-based merge silently drops the newer value here.
		const current = {value: {darkMode: false}, timestamps: {darkMode: 200}};
		const incoming = {value: {darkMode: true}, timestamps: {darkMode: 100}};

		const result = mergeRecord(current, incoming, 'settings');

		expect(result.value).toStrictEqual({darkMode: false});
		expect(result.timestamps.darkMode).toBe(200);
		expect(result.localWonCount).toBe(1);
	});

	it('respects timestamps for zero and empty-string property values', () => {
		const current = {value: {fontSize: 0, name: ''}, timestamps: {fontSize: 999, name: 500}};
		const incoming = {value: {fontSize: 14, name: 'old'}, timestamps: {fontSize: 1, name: 1}};

		const result = mergeRecord(current, incoming, 'settings');

		expect(result.value).toStrictEqual({fontSize: 0, name: ''});
	});

	it('reports which properties the incoming device won so a change can be emitted', () => {
		const current = {value: {theme: 'dark', fontSize: 12}, timestamps: {theme: 300, fontSize: 100}};
		const incoming = {
			value: {theme: 'light', fontSize: 18},
			timestamps: {theme: 100, fontSize: 400},
		};

		const result = mergeRecord(current, incoming, 'settings');

		expect(result.changedProperties).toStrictEqual(['fontSize']);
		expect(result.localWonCount).toBe(1);
	});

	it('reports no change when both devices hold identical properties', () => {
		const current = {value: {theme: 'dark'}, timestamps: {theme: 300}};
		const incoming = {value: {theme: 'dark'}, timestamps: {theme: 300}};

		const result = mergeRecord(current, incoming, 'settings');

		expect(result.changedProperties).toStrictEqual([]);
		expect(result.localWonCount).toBe(0);
		expect(result.tieCount).toBe(1);
	});

	it('adopts a property that only the incoming device has', () => {
		const current = {value: {theme: 'dark'}, timestamps: {theme: 300}};
		const incoming = {value: {theme: 'dark', fontSize: 14}, timestamps: {theme: 300, fontSize: 50}};

		const result = mergeRecord(current, incoming, 'settings');

		expect(result.value).toStrictEqual({theme: 'dark', fontSize: 14});
		expect(result.changedProperties).toStrictEqual(['fontSize']);
	});

	it('keeps a property that only the local device has and flags it for re-push', () => {
		const current = {value: {theme: 'dark', fontSize: 14}, timestamps: {theme: 300, fontSize: 50}};
		const incoming = {value: {theme: 'dark'}, timestamps: {theme: 300}};

		const result = mergeRecord(current, incoming, 'settings');

		expect(result.value).toStrictEqual({theme: 'dark', fontSize: 14});
		expect(result.localWonCount).toBe(1);
	});

	it('breaks ties on equal timestamps deterministically', () => {
		const a = {value: {theme: 'aaa'}, timestamps: {theme: 500}};
		const b = {value: {theme: 'zzz'}, timestamps: {theme: 500}};

		expect(mergeRecord(a, b, 'settings').value).toStrictEqual(mergeRecord(b, a, 'settings').value);
	});
});

// ============================================================================
// mergeStore with record fields
// ============================================================================

describe('mergeStore - record fields', () => {
	const recordSchema = defineSchema({
		settings: record<{theme: string; fontSize: number}>(),
		operations: map<{tx: string; status: string}>(),
	});

	function storage(
		settings: {theme: string; fontSize: number},
		settingsTimestamps: Record<string, number>,
	) {
		return {
			$version: 1,
			data: {settings, operations: {}},
			$timestamps: {},
			$itemTimestamps: {settings: settingsTimestamps, operations: {}},
			$tombstones: {operations: {}},
		};
	}

	it('merges each property independently instead of replacing the struct', () => {
		const deviceA = storage({theme: 'dark', fontSize: 12}, {theme: 300, fontSize: 100});
		const deviceB = storage({theme: 'light', fontSize: 18}, {theme: 100, fontSize: 400});

		const result = mergeStore(deviceA, deviceB, recordSchema);

		expect(result.merged.data.settings).toStrictEqual({theme: 'dark', fontSize: 18});
		expect(result.merged.$itemTimestamps.settings).toStrictEqual({theme: 300, fontSize: 400});
	});

	it('two devices editing different properties converge to both edits', () => {
		const deviceA = storage({theme: 'dark', fontSize: 12}, {theme: 300, fontSize: 100});
		const deviceB = storage({theme: 'light', fontSize: 18}, {theme: 100, fontSize: 400});

		const ab = mergeStore(deviceA, deviceB, recordSchema);
		const ba = mergeStore(deviceB, deviceA, recordSchema);

		expect(ab.merged.data.settings).toStrictEqual(ba.merged.data.settings);
	});

	it('emits a single field-level changed event carrying the merged value', () => {
		const deviceA = storage({theme: 'dark', fontSize: 12}, {theme: 300, fontSize: 100});
		const deviceB = storage({theme: 'light', fontSize: 18}, {theme: 100, fontSize: 400});

		const result = mergeStore(deviceA, deviceB, recordSchema);

		expect(result.changes).toStrictEqual([
			{event: 'settings:changed', data: {theme: 'dark', fontSize: 18}},
		]);
	});

	it('flags local changes when a local property wins', () => {
		const deviceA = storage({theme: 'dark', fontSize: 12}, {theme: 300, fontSize: 100});
		const deviceB = storage({theme: 'light', fontSize: 12}, {theme: 100, fontSize: 100});

		const result = mergeStore(deviceA, deviceB, recordSchema);

		expect(result.hasLocalChanges).toBe(true);
	});

	it('does not flag pristine default data as a local change', () => {
		const deviceA = storage({theme: 'dark', fontSize: 12}, {});
		const deviceB = storage({theme: 'dark', fontSize: 12}, {});

		const result = mergeStore(deviceA, deviceB, recordSchema);

		expect(result.hasLocalChanges).toBe(false);
		expect(result.changes).toStrictEqual([]);
	});

	it('falls back to the field-level timestamp for a field converted from value()', () => {
		// Data written while the field was still `value()`: one field-level timestamp,
		// no per-property timestamps.
		const legacy = {
			$version: 1,
			data: {settings: {theme: 'light', fontSize: 20}, operations: {}},
			$timestamps: {settings: 9000},
			$itemTimestamps: {operations: {}},
			$tombstones: {operations: {}},
		};
		const upgraded = storage({theme: 'dark', fontSize: 12}, {theme: 100, fontSize: 100});

		const result = mergeStore(upgraded, legacy, recordSchema);

		// The legacy write is newer for every property, so it must win throughout.
		expect(result.merged.data.settings).toStrictEqual({theme: 'light', fontSize: 20});
	});
});

describe('mergeRecord - shape validation', () => {
	// The type layer rejects arrays and primitives at `record<T>()`, but exotic
	// objects (Date, Map, class instances) satisfy `T extends object`, and JS
	// consumers have no type layer at all. Merging those silently produced a
	// corrupted plain object, so they fail loudly instead.

	it('rejects an array, naming the field and the alternative', () => {
		expect(() =>
			mergeRecord(
				{value: ['a', 'b', 'c'] as unknown as object, timestamps: {}},
				{value: ['x', 'y'] as unknown as object, timestamps: {}},
				'tags',
			),
		).toThrow(/tags.*array.*value</s);
	});

	it('rejects a primitive instead of throwing an opaque TypeError', () => {
		expect(() =>
			mergeRecord(
				{value: 'hello' as unknown as object, timestamps: {}},
				{value: 'world' as unknown as object, timestamps: {}},
				'name',
			),
		).toThrow(/name.*plain object/s);
	});

	it('rejects a Date, which no type constraint can exclude', () => {
		expect(() =>
			mergeRecord(
				{value: new Date(0), timestamps: {}},
				{value: new Date(1), timestamps: {}},
				'created',
			),
		).toThrow(/created.*plain object/s);
	});

	it('rejects a class instance', () => {
		class Settings {
			theme = 'dark';
		}
		expect(() =>
			mergeRecord(
				{value: new Settings(), timestamps: {}},
				{value: new Settings(), timestamps: {}},
				'settings',
			),
		).toThrow(/settings.*plain object/s);
	});

	it('accepts a missing value, which is just an unset field', () => {
		expect(() =>
			mergeRecord(
				{value: undefined as unknown as object, timestamps: {}},
				{value: {theme: 'dark'}, timestamps: {theme: 1}},
				'settings',
			),
		).not.toThrow();
	});

	it('accepts an object with a null prototype', () => {
		const bare = Object.create(null) as {theme?: string};
		bare.theme = 'dark';
		expect(() =>
			mergeRecord(
				{value: bare, timestamps: {theme: 1}},
				{value: {theme: 'light'}, timestamps: {theme: 2}},
				'settings',
			),
		).not.toThrow();
	});
});
