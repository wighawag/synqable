import type {WatchableStorage, StorageChangeCallback, WatchableStorageAdapterFactory} from './types.js';
import type {Serializer} from '../serializer/types.js';
import type {EncryptionProviderFactory} from '../encryption/types.js';
import {createJsonSerializer} from '../serializer/types.js';
import {wrapWithEncryption} from '../encryption/wrap.js';

interface WatcherEntry<T> {
	callback: StorageChangeCallback<T>;
	deserialize: (data: string) => T | Promise<T | undefined>;
}

interface SharedWatcherState<T> {
	watchers: Map<string, Set<WatcherEntry<T>>>;
	globalListener: ((e: StorageEvent) => void) | null;
}

function ensureGlobalListener<T>(state: SharedWatcherState<T>): void {
	if (state.globalListener) return;

	state.globalListener = (e: StorageEvent) => {
		if (!e.key) return;

		const entries = state.watchers.get(e.key);
		if (!entries || entries.size === 0) return;

		for (const {callback, deserialize} of entries) {
			if (e.newValue === null) {
				callback(e.key, undefined); // deletion
				continue;
			}

			try {
				const resultOrPromise = deserialize(e.newValue);
				if (resultOrPromise instanceof Promise) {
					// Async deserializer (encryption case)
					resultOrPromise
						.then((data) => {
							if (data !== undefined) {
								callback(e.key!, data);
							}
						})
						.catch(() => {
							callback(e.key!, undefined);
						});
				} else {
					// Sync deserializer (no encryption case)
					if (resultOrPromise !== undefined) {
						callback(e.key, resultOrPromise);
					}
				}
			} catch {
				callback(e.key, undefined);
			}
		}
	};

	window.addEventListener('storage', state.globalListener);
}

function cleanupGlobalListener<T>(state: SharedWatcherState<T>): void {
	if (state.watchers.size === 0 && state.globalListener) {
		window.removeEventListener('storage', state.globalListener);
		state.globalListener = null;
	}
}

function createAdapter<T>(serializer: Serializer<T>, watcherState: SharedWatcherState<T>): WatchableStorage<T> {
	return {
		async load(key: string): Promise<T | undefined> {
			try {
				const stored = localStorage.getItem(key);
				if (!stored) return undefined;
				// Check if deserialize is sync to avoid unnecessary microtask
				const resultOrPromise = serializer.deserialize(stored);
				return resultOrPromise instanceof Promise ? await resultOrPromise : resultOrPromise;
			} catch {
				return undefined;
			}
		},

		async save(key: string, data: T): Promise<void> {
			// Check if serialize is sync to avoid unnecessary microtask
			const resultOrPromise = serializer.serialize(data);
			const serialized = resultOrPromise instanceof Promise ? await resultOrPromise : resultOrPromise;
			localStorage.setItem(key, serialized);
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
			ensureGlobalListener(watcherState);

			if (!watcherState.watchers.has(key)) {
				watcherState.watchers.set(key, new Set());
			}

			const entry: WatcherEntry<T> = {
				callback,
				deserialize: serializer.deserialize,
			};
			watcherState.watchers.get(key)!.add(entry);

			return () => {
				const entries = watcherState.watchers.get(key);
				if (entries) {
					entries.delete(entry);
					if (entries.size === 0) {
						watcherState.watchers.delete(key);
					}
				}
				cleanupGlobalListener(watcherState);
			};
		},
	};
}

/**
 * Creates a standalone localStorage adapter.
 *
 * @param serializer - Serializer for data transformation (defaults to JSON)
 * @returns WatchableStorage adapter
 */
export function createLocalStorageAdapter<T>(serializer: Serializer<T> = createJsonSerializer<T>()): WatchableStorage<T> {
	const watcherState: SharedWatcherState<T> = {watchers: new Map(), globalListener: null};
	return createAdapter(serializer, watcherState);
}

/**
 * Creates a localStorage adapter factory with shared global listener.
 * All adapters created by this factory share the same storage event listener.
 *
 * @param encryptionFactory - Optional encryption factory. If provided, creates encryption from privateKey.
 * @returns WatchableStorageAdapterFactory that can be passed to StorageConfig
 *
 * @example Without encryption
 * ```typescript
 * const factory = createLocalStorageAdapterFactory();
 * const adapter = factory(); // No encryption
 * ```
 *
 * @example With encryption
 * ```typescript
 * import { createAesGcmProvider } from 'synqable/encryption';
 *
 * const factory = createLocalStorageAdapterFactory(createAesGcmProvider);
 * const adapter = factory('0xprivateKey...'); // Data will be encrypted
 * ```
 */
export function createLocalStorageAdapterFactory<T>(
	encryptionFactory?: EncryptionProviderFactory,
): WatchableStorageAdapterFactory<T> {
	// Shared watcher state across all instances
	const watcherState: SharedWatcherState<T> = {watchers: new Map(), globalListener: null};

	return (privateKey?: `0x${string}`): WatchableStorage<T> => {
		// Create base serializer
		let serializer: Serializer<T> = createJsonSerializer<T>();

		// Wrap with encryption if privateKey provided and factory exists
		if (privateKey && encryptionFactory) {
			const encryption = encryptionFactory(privateKey);
			serializer = wrapWithEncryption(serializer, encryption);
		}

		return createAdapter(serializer, watcherState);
	};
}
