/**
 * Combined Status Utility
 *
 * Combines sync and storage status for UI convenience.
 */

import type {StorageStatus} from './types.js';
import type {SyncStatus} from '../sync/types.js';

/**
 * Combine sync and storage status for UI convenience.
 */
export function combineStatus(
	sync: SyncStatus,
	storage: StorageStatus,
): {
	hasError: boolean;
	hasUnsavedChanges: boolean;
	isBusy: boolean;
} {
	return {
		hasError: sync.syncError !== null || storage.storageError !== null,
		hasUnsavedChanges: storage.isSaving,
		isBusy: sync.isSyncing || storage.isSaving,
	};
}
