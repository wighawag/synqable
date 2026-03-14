/**
 * Simple Syncable Store - Cleanup Algorithm
 *
 * Removes expired items and tombstones from the store.
 */

import type {Schema, InternalStorage, DataOf, StoreChange} from './types.js';

/**
 * Result of cleanup operation.
 */
export interface CleanupResult<S extends Schema> {
	/** Cleaned storage with expired items and tombstones removed */
	storage: InternalStorage<S>;

	/** Changes produced by cleanup - expired items become :removed events */
	changes: StoreChange[];

	/** True if any tombstones were deleted during cleanup */
	tombstonesDeleted: boolean;
}

/**
 * Clean up expired items and tombstones from storage.
 * Items and tombstones with deleteAt <= now are removed.
 */
export function cleanup<S extends Schema>(
	storage: InternalStorage<S>,
	schema: S,
	now: number = Date.now(),
): CleanupResult<S> {
	const changes: StoreChange[] = [];
	let tombstonesDeleted = false;

	const result: InternalStorage<S> = {
		$version: storage.$version,
		data: {...storage.data} as DataOf<S>,
		$timestamps: {...storage.$timestamps},
		$itemTimestamps: {} as InternalStorage<S>['$itemTimestamps'],
		$tombstones: {} as InternalStorage<S>['$tombstones'],
	};

	for (const field of Object.keys(schema) as (keyof S & string)[]) {
		const fieldDef = schema[field];

		if (fieldDef.__type === 'map') {
			// Copy and filter tombstones
			const tombstones =
				(storage.$tombstones as Record<string, Record<string, number>>)[field] ?? {};
			const cleanedTombstones: Record<string, number> = {};

			for (const [key, deleteAt] of Object.entries(tombstones)) {
				if (deleteAt > now) {
					cleanedTombstones[key] = deleteAt;
				} else {
					tombstonesDeleted = true;
				}
			}

			(result.$tombstones as Record<string, Record<string, number>>)[field] = cleanedTombstones;

			// Copy and filter items
			const items = ((storage.data as Record<string, unknown>)[field] ?? {}) as Record<
				string,
				{deleteAt: number}
			>;
			const timestamps =
				(storage.$itemTimestamps as Record<string, Record<string, number>>)[field] ?? {};
			const cleanedItems: Record<string, unknown> = {};
			const cleanedTimestamps: Record<string, number> = {};

			for (const [key, item] of Object.entries(items)) {
				if (item.deleteAt > now) {
					cleanedItems[key] = item;
					if (timestamps[key] !== undefined) {
						cleanedTimestamps[key] = timestamps[key];
					}
				} else {
					// Item expired - emit :removed change
					changes.push({
						event: `${field}:removed`,
						data: {key, item},
					});
				}
			}

			(result.data as Record<string, unknown>)[field] = cleanedItems;
			(result.$itemTimestamps as Record<string, Record<string, number>>)[field] = cleanedTimestamps;
		}
		// Permanent fields are never cleaned up
	}

	return {storage: result, changes, tombstonesDeleted};
}
