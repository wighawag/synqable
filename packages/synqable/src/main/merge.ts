/**
 * Syncable Store - Merge Algorithm
 *
 * Deterministic merge using "higher timestamp wins" with tiebreaker.
 */

import stableStringify from 'json-stable-stringify';
import type {
	Schema,
	InternalStorage,
	StoreChange,
	DataOf,
	PermanentKeys,
	MapKeys,
} from './types.js';
import {cleanup, type CleanupResult} from './cleanup.js';

// ============================================================================
// Merge Outcome Types
// ============================================================================

export type MergeOutcome = 'incoming' | 'current' | 'tie';
export type TiebreakerOutcome = 'first' | 'second' | 'tie';

export interface TiebreakerResult<T> {
	value: T;
	outcome: TiebreakerOutcome;
}

// ============================================================================
// Tiebreaker
// ============================================================================

/**
 * Deterministic tiebreaker for values with identical timestamps.
 * Uses json-stable-stringify for deterministic property order.
 */
export function tiebreaker<T>(a: T, b: T): TiebreakerResult<T> {
	const aStr = stableStringify(a) ?? '';
	const bStr = stableStringify(b) ?? '';

	if (aStr === bStr) {
		return {value: a, outcome: 'tie'};
	}

	if (aStr < bStr) {
		return {value: a, outcome: 'first'};
	}
	return {value: b, outcome: 'second'};
}

// ============================================================================
// Permanent Field Merge
// ============================================================================

export interface PermanentMergeInput<T> {
	value: T;
	timestamp: number;
}

export interface PermanentMergeResult<T> {
	value: T;
	timestamp: number;
	outcome: MergeOutcome;
}

export function mergePermanent<T>(
	current: PermanentMergeInput<T>,
	incoming: PermanentMergeInput<T>,
): PermanentMergeResult<T> {
	if (incoming.timestamp > current.timestamp) {
		return {
			value: incoming.value,
			timestamp: incoming.timestamp,
			outcome: 'incoming',
		};
	}

	if (current.timestamp > incoming.timestamp) {
		return {
			value: current.value,
			timestamp: current.timestamp,
			outcome: 'current',
		};
	}

	// Same timestamp - use tiebreaker
	const result = tiebreaker(current.value, incoming.value);

	let outcome: MergeOutcome;
	if (result.outcome === 'tie') {
		outcome = 'tie';
	} else if (result.outcome === 'second') {
		outcome = 'incoming';
	} else {
		outcome = 'current';
	}

	return {
		value: result.value,
		timestamp: current.timestamp,
		outcome,
	};
}

// ============================================================================
// Map Field Merge
// ============================================================================

export interface MapState<T> {
	items: Record<string, T>;
	timestamps: Record<string, number>;
	tombstones: Record<string, number>;
}

export interface MapChange<T> {
	event: `${string}:added` | `${string}:updated` | `${string}:removed`;
	data: {key: string; item: T};
}

export interface MapMergeResult<T> {
	items: Record<string, T>;
	timestamps: Record<string, number>;
	tombstones: Record<string, number>;
	changes: MapChange<T>[];
	localWonCount: number;
	tieCount: number;
}

export function mergeMap<T>(
	current: MapState<T>,
	incoming: MapState<T>,
	fieldName: string,
): MapMergeResult<T> {
	const items: Record<string, T> = {};
	const timestamps: Record<string, number> = {};
	const tombstones: Record<string, number> = {};
	const changes: MapChange<T>[] = [];
	let localWonCount = 0;
	let tieCount = 0;

	// Merge tombstones - later deleteAt wins
	const allTombstoneKeys = new Set([
		...Object.keys(current.tombstones),
		...Object.keys(incoming.tombstones),
	]);

	for (const key of allTombstoneKeys) {
		const ct = current.tombstones[key] ?? 0;
		const it = incoming.tombstones[key] ?? 0;
		if (ct > 0 || it > 0) {
			tombstones[key] = Math.max(ct, it);
		}
	}

	// Merge items
	const allItemKeys = new Set([...Object.keys(current.items), ...Object.keys(incoming.items)]);

	for (const key of allItemKeys) {
		const hadItem = key in current.items;
		const isTombstoned = key in tombstones;

		if (isTombstoned) {
			if (hadItem) {
				changes.push({
					event: `${fieldName}:removed`,
					data: {key, item: current.items[key]},
				});
			}
			continue;
		}

		const cItem = current.items[key];
		const iItem = incoming.items[key];
		const cTs = current.timestamps[key] ?? 0;
		const iTs = incoming.timestamps[key] ?? 0;

		let winner: T;
		let winnerTs: number;

		if (!cItem && iItem) {
			winner = iItem;
			winnerTs = iTs;
			changes.push({
				event: `${fieldName}:added`,
				data: {key, item: iItem},
			});
		} else if (cItem && !iItem) {
			winner = cItem;
			winnerTs = cTs;
			localWonCount++;
		} else {
			if (iTs > cTs) {
				winner = iItem;
				winnerTs = iTs;
				changes.push({
					event: `${fieldName}:updated`,
					data: {key, item: iItem},
				});
			} else if (cTs > iTs) {
				winner = cItem;
				winnerTs = cTs;
				localWonCount++;
			} else {
				const picked = tiebreaker({item: cItem, ts: cTs}, {item: iItem, ts: iTs});
				winner = picked.value.item;
				winnerTs = picked.value.ts;

				switch (picked.outcome) {
					case 'tie':
						tieCount++;
						break;
					case 'first':
						localWonCount++;
						break;
					case 'second':
						changes.push({
							event: `${fieldName}:updated`,
							data: {key, item: iItem},
						});
						break;
				}
			}
		}

		items[key] = winner;
		timestamps[key] = winnerTs;
	}

	return {items, timestamps, tombstones, changes, localWonCount, tieCount};
}

// ============================================================================
// Full Store Merge
// ============================================================================

export interface StoreMergeResult<S extends Schema> {
	merged: InternalStorage<S>;
	changes: StoreChange[];
	hasLocalChanges: boolean;
}

export function mergeStore<S extends Schema>(
	current: InternalStorage<S>,
	incoming: InternalStorage<S>,
	schema: S,
): StoreMergeResult<S> {
	const result: InternalStorage<S> = {
		$version: Math.max(current.$version ?? 0, incoming.$version ?? 0),
		data: {} as DataOf<S>,
		$timestamps: {} as InternalStorage<S>['$timestamps'],
		$itemTimestamps: {} as InternalStorage<S>['$itemTimestamps'],
		$tombstones: {} as InternalStorage<S>['$tombstones'],
	};
	const changes: StoreChange[] = [];
	let hasLocalChanges = false;

	for (const field of Object.keys(schema) as (keyof S & string)[]) {
		const fieldDef = schema[field];

		if (fieldDef.__type === 'permanent') {
			const currentTs = (current.$timestamps as Record<string, number>)[field] ?? 0;
			const incomingTs = (incoming.$timestamps as Record<string, number>)[field] ?? 0;
			const currentValue = (current.data as Record<string, unknown>)[field];
			const incomingValue = (incoming.data as Record<string, unknown>)[field];

			const mergeResult = mergePermanent(
				{value: currentValue, timestamp: currentTs},
				{value: incomingValue, timestamp: incomingTs},
			);

			(result.data as Record<string, unknown>)[field] = mergeResult.value;
			(result.$timestamps as Record<string, number>)[field] = mergeResult.timestamp;

			switch (mergeResult.outcome) {
				case 'incoming':
					changes.push({event: `${field}:changed`, data: mergeResult.value});
					break;
				case 'current':
					if (currentTs > 0) {
						hasLocalChanges = true;
					}
					break;
				case 'tie':
					break;
			}
		} else if (fieldDef.__type === 'map') {
			const currentItems = ((current.data as Record<string, unknown>)[field] ?? {}) as Record<
				string,
				unknown
			>;
			const incomingItems = ((incoming.data as Record<string, unknown>)[field] ?? {}) as Record<
				string,
				unknown
			>;
			const currentTimestamps =
				(current.$itemTimestamps as Record<string, Record<string, number>>)[field] ?? {};
			const incomingTimestamps =
				(incoming.$itemTimestamps as Record<string, Record<string, number>>)[field] ?? {};
			const currentTombstones =
				(current.$tombstones as Record<string, Record<string, number>>)[field] ?? {};
			const incomingTombstones =
				(incoming.$tombstones as Record<string, Record<string, number>>)[field] ?? {};

			const mapResult = mergeMap(
				{
					items: currentItems,
					timestamps: currentTimestamps,
					tombstones: currentTombstones,
				},
				{
					items: incomingItems,
					timestamps: incomingTimestamps,
					tombstones: incomingTombstones,
				},
				field,
			);

			(result.data as Record<string, unknown>)[field] = mapResult.items;
			(result.$itemTimestamps as Record<string, Record<string, number>>)[field] =
				mapResult.timestamps;
			(result.$tombstones as Record<string, Record<string, number>>)[field] = mapResult.tombstones;

			changes.push(...(mapResult.changes as StoreChange[]));

			if (mapResult.localWonCount > 0) {
				hasLocalChanges = true;
			}
		}
	}

	return {merged: result, changes, hasLocalChanges};
}

// ============================================================================
// Merge and Cleanup Combined
// ============================================================================

export interface MergeAndCleanupResult<S extends Schema> {
	storage: InternalStorage<S>;
	changes: StoreChange[];
	tombstonesDeleted: boolean;
	itemsExpired: boolean;
	serverNeedsUpdate: boolean;
}

export function mergeAndCleanup<S extends Schema>(
	current: InternalStorage<S>,
	incoming: InternalStorage<S>,
	schema: S,
	now: number = Date.now(),
): MergeAndCleanupResult<S> {
	const {merged, changes: mergeChanges, hasLocalChanges} = mergeStore(current, incoming, schema);
	const {
		storage: cleaned,
		changes: cleanupChanges,
		tombstonesDeleted,
	} = cleanup(merged, schema, now);

	const allChanges = deduplicateChanges(mergeChanges, cleanupChanges);
	const serverNeedsUpdate = hasLocalChanges;

	return {
		storage: cleaned,
		changes: allChanges,
		tombstonesDeleted,
		itemsExpired: cleanupChanges.length > 0,
		serverNeedsUpdate,
	};
}

function deduplicateChanges(
	mergeChanges: StoreChange[],
	cleanupChanges: StoreChange[],
): StoreChange[] {
	const result: StoreChange[] = [];

	const expiredKeys = new Set<string>();
	for (const change of cleanupChanges) {
		if (change.event.endsWith(':removed')) {
			const data = change.data as {key: string};
			const fieldName = change.event.split(':')[0];
			expiredKeys.add(`${fieldName}:${data.key}`);
		}
	}

	const addedKeys = new Set<string>();
	for (const change of mergeChanges) {
		if (change.event.endsWith(':added')) {
			const data = change.data as {key: string};
			const fieldName = change.event.split(':')[0];
			addedKeys.add(`${fieldName}:${data.key}`);
		}
	}

	for (const change of mergeChanges) {
		const fieldName = change.event.split(':')[0];

		if (change.event.endsWith(':added') || change.event.endsWith(':updated')) {
			const data = change.data as {key: string};
			const keyPath = `${fieldName}:${data.key}`;

			if (expiredKeys.has(keyPath)) {
				continue;
			}
		}

		result.push(change);
	}

	for (const change of cleanupChanges) {
		if (change.event.endsWith(':removed')) {
			const data = change.data as {key: string};
			const fieldName = change.event.split(':')[0];
			const keyPath = `${fieldName}:${data.key}`;

			if (addedKeys.has(keyPath)) {
				continue;
			}
		}

		result.push(change);
	}

	return result;
}
