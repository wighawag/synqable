import type {WatchableStorage, StorageChangeCallback} from './types.js';

export interface LocalStorageAdapterOptions<T> {
	/** Optional serializer, defaults to JSON.stringify */
	serialize?: (data: T) => string;
	/** Optional deserializer, defaults to JSON.parse */
	deserialize?: (data: string) => T;
}

export function createLocalStorageAdapter<T>(
	options?: LocalStorageAdapterOptions<T>,
): WatchableStorage<T> {
	const serialize = options?.serialize ?? JSON.stringify;
	const deserialize = (options?.deserialize ?? JSON.parse) as (data: string) => T;

	// Map of key -> Set of callbacks
	const watchers = new Map<string, Set<StorageChangeCallback<T>>>();

	// Single global listener for the storage event
	let globalListener: ((e: StorageEvent) => void) | null = null;

	function ensureGlobalListener() {
		if (globalListener) return;

		globalListener = (e: StorageEvent) => {
			// Only handle changes from other tabs/windows
			// Note: localStorage events only fire for changes from OTHER documents
			if (!e.key) return;

			const callbacks = watchers.get(e.key);
			if (!callbacks || callbacks.size === 0) return;

			// Parse new value
			let newValue: T | undefined;
			if (e.newValue !== null) {
				try {
					newValue = deserialize(e.newValue);
				} catch {
					newValue = undefined;
				}
			}

			// Notify all watchers for this key
			for (const callback of callbacks) {
				callback(e.key, newValue);
			}
		};

		window.addEventListener('storage', globalListener);
	}

	function cleanupGlobalListener() {
		if (watchers.size === 0 && globalListener) {
			window.removeEventListener('storage', globalListener);
			globalListener = null;
		}
	}

	return {
		async load(key: string): Promise<T | undefined> {
			try {
				const stored = localStorage.getItem(key);
				return stored ? deserialize(stored) : undefined;
			} catch {
				return undefined;
			}
		},

		async save(key: string, data: T): Promise<void> {
			localStorage.setItem(key, serialize(data));
		},

		async remove(key: string): Promise<void> {
			localStorage.removeItem(key);
		},

		async exists(key: string): Promise<boolean> {
			try {
				return localStorage.getItem(key) !== null;
			} catch {
				return false;
			}
		},

		watch(key: string, callback: StorageChangeCallback<T>): () => void {
			ensureGlobalListener();

			if (!watchers.has(key)) {
				watchers.set(key, new Set());
			}
			watchers.get(key)!.add(callback);

			// Return unsubscribe function
			return () => {
				const callbacks = watchers.get(key);
				if (callbacks) {
					callbacks.delete(callback);
					if (callbacks.size === 0) {
						watchers.delete(key);
					}
				}
				cleanupGlobalListener();
			};
		},
	};
}
