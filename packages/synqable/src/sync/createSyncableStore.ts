/**
 * Single-Account Syncable Store
 *
 * Creates a type-safe syncable store bound to ONE specific account.
 */

import type {
	Schema,
	InternalStorage,
	DataOf,
	AsyncState,
	SyncStatus,
	StorageStatus,
	PermanentKeys,
	MapKeys,
	ExtractPermanent,
	ExtractMapItem,
	DeepPartial,
	DeepReadonly,
	StoreChange,
	StoreEvents,
	SyncAdapter,
	SyncConfig,
} from './types.js';

import type { AsyncStorage } from '../storage/types.js';
import { isWatchable } from '../storage/types.js';
import { cleanup } from './cleanup.js';
import { mergeAndCleanup } from './merge.js';
import { createEmitter } from 'radiate';

// ============================================================================
// Readable Store Interface (Svelte store contract)
// ============================================================================

export interface Readable<T> {
	subscribe(callback: (value: T) => void): () => void;
}

// ============================================================================
// Store Configuration
// ============================================================================

export interface SyncableStoreConfig<S extends Schema> {
	/** Schema definition */
	schema: S;

	/** Static account address - store is bound to this account */
	account: `0x${string}`;

	/** Local storage adapter */
	storage: AsyncStorage<InternalStorage<S>>;

	/** Storage key - direct string */
	storageKey: string;

	/** Default data factory */
	defaultData: () => DataOf<S>;

	/** Clock function for timestamps (default: Date.now) */
	clock?: () => number;

	/** Schema version for migrations */
	schemaVersion?: number;

	/** Optional: Server sync adapter */
	sync?: SyncAdapter<S>;

	/** Optional: Sync configuration */
	syncConfig?: SyncConfig;

	/** Migration functions keyed by target version */
	migrations?: Record<number, (oldData: unknown) => InternalStorage<S>>;
}

// ============================================================================
// Store Interface
// ============================================================================

export interface SyncableStore<S extends Schema> {
	/** Current async state (deeply readonly to prevent direct mutation) */
	readonly state: DeepReadonly<AsyncState<DataOf<S>>>;

	/** The account this store is bound to */
	readonly account: `0x${string}`;

	/** Set a permanent field value */
	set<K extends PermanentKeys<S>>(field: K, value: ExtractPermanent<S[K]>): void;

	/** Patch a permanent field with partial updates */
	patch<K extends PermanentKeys<S>>(field: K, value: DeepPartial<ExtractPermanent<S[K]>>): void;

	/** Add an item to a map field */
	add<K extends MapKeys<S>>(
		field: K,
		key: string,
		value: ExtractMapItem<S[K]>,
		options: { deleteAt: number },
	): void;

	/** Update an existing map item */
	update<K extends MapKeys<S>>(field: K, key: string, value: ExtractMapItem<S[K]>): void;

	/** Remove an item from a map field */
	remove<K extends MapKeys<S>>(field: K, key: string): void;

	/** Subscribe to state changes (Svelte store contract) */
	subscribe(callback: (state: AsyncState<DataOf<S>>) => void): () => void;

	/** Subscribe to type-safe events */
	on<E extends keyof StoreEvents<S>>(
		event: E,
		callback: (data: StoreEvents<S>[E]) => void,
	): () => void;

	/** Unsubscribe from events */
	off<E extends keyof StoreEvents<S>>(event: E, callback: (data: StoreEvents<S>[E]) => void): void;

	/** Load data from storage - must be called to initialize */
	load(): Promise<void>;

	/** Stop watching and clean up */
	stop(): void;

	/** Watch a specific map item reactively */
	watchItem<K extends MapKeys<S>>(
		field: K,
		key: string,
	): Readable<(ExtractMapItem<S[K]> & { deleteAt: number }) | undefined>;

	/** Watch a top-level field reactively */
	watchField<K extends keyof S>(field: K): Readable<DataOf<S>[K] | undefined>;

	/** Reactive sync status */
	readonly syncStatus$: Readable<SyncStatus>;

	/** Reactive storage status */
	readonly storageStatus$: Readable<StorageStatus>;

	/** Force sync to server now */
	syncNow(): Promise<void>;

	/** Retry loading after a migration failure */
	retryLoad(): void;

	/** Wait for all pending storage saves to complete */
	flush(timeoutMs?: number): Promise<void>;
}

// ============================================================================
// Implementation
// ============================================================================

export function createSyncableStore<S extends Schema>(
	config: SyncableStoreConfig<S>,
): SyncableStore<S> {
	const {
		schema,
		account,
		storage,
		storageKey,
		defaultData,
		clock = Date.now,
		schemaVersion = 1,
		sync: syncAdapter,
		syncConfig,
		migrations,
	} = config;

	// Sync configuration with defaults
	const debounceMs = syncConfig?.debounceMs ?? 1000;
	const maxRetries = syncConfig?.maxRetries ?? 3;
	const retryBackoffMs = syncConfig?.retryBackoffMs ?? 1000;

	// State
	let asyncState: AsyncState<DataOf<S>> = { status: 'idle', account: undefined };
	let internalStorage: InternalStorage<S> | null = null;

	// Storage queue state
	let storageSavePending: {
		account: `0x${string}`;
		data: InternalStorage<S>;
	} | null = null;
	let currentSavePromise: Promise<void> | null = null;

	// Internal mutable sync status
	interface MutableSyncStatus {
		isSyncing: boolean;
		isOnline: boolean;
		hasPendingSync: boolean;
		lastSyncedAt: number | null;
		syncError: Error | null;
		readonly displayState: 'syncing' | 'offline' | 'error' | 'idle';
	}

	// Internal mutable storage status
	interface MutableStorageStatus {
		isSaving: boolean;
		lastSavedAt: number | null;
		storageError: Error | null;
		readonly displayState: 'saving' | 'error' | 'idle';
	}

	const mutableSyncStatus: MutableSyncStatus = {
		isSyncing: false,
		isOnline: true,
		hasPendingSync: false,
		lastSyncedAt: null,
		syncError: null,
		get displayState() {
			if (this.isSyncing) return 'syncing';
			if (!this.isOnline) return 'offline';
			if (this.syncError) return 'error';
			return 'idle';
		},
	};

	const mutableStorageStatus: MutableStorageStatus = {
		isSaving: false,
		lastSavedAt: null,
		storageError: null,
		get displayState() {
			if (this.isSaving) return 'saving';
			if (this.storageError) return 'error';
			return 'idle';
		},
	};

	const syncStatus: SyncStatus = mutableSyncStatus;
	const storageStatus: StorageStatus = mutableStorageStatus;

	// Event emitter
	const emitter = createEmitter<StoreEvents<S>>();

	// Event type definitions
	type SyncEventData =
		| { type: 'pending' }
		| { type: 'started' }
		| { type: 'completed'; timestamp: number }
		| { type: 'failed'; error: Error }
		| { type: 'offline' }
		| { type: 'online' };

	type StorageEventData =
		| { type: 'saving' }
		| { type: 'saved'; timestamp: number }
		| { type: 'failed'; error: Error };

	type StateEventData = { type: 'idle' } | { type: 'loading' } | { type: 'ready' };

	function emitSyncEvent(event: SyncEventData): void {
		(emitter.emit as (eventName: '$store:sync', data: SyncEventData) => void)(
			'$store:sync',
			event,
		);
	}

	function emitStorageEvent(event: StorageEventData): void {
		(emitter.emit as (eventName: '$store:storage', data: StorageEventData) => void)(
			'$store:storage',
			event,
		);
	}

	function emitStateEvent(event: StateEventData): void {
		(emitter.emit as (eventName: '$store:state', data: StateEventData) => void)(
			'$store:state',
			event,
		);
	}

	// Cleanup references
	let unwatchStorage: (() => void) | undefined;
	let handleVisibilityChange: (() => void) | undefined;
	let handleOnline: (() => void) | undefined;
	let handleOffline: (() => void) | undefined;
	let handleBeforeUnload: ((e: BeforeUnloadEvent) => void) | undefined;
	let syncIntervalTimer: ReturnType<typeof setInterval> | undefined;
	let syncDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	let syncDirty = false;

	// Store caches
	const itemStoreCache = new Map<string, Readable<unknown>>();
	const fieldStoreCache = new Map<string, Readable<unknown>>();

	// Status stores
	const syncStatus$: Readable<SyncStatus> = {
		subscribe(callback: (status: SyncStatus) => void): () => void {
			callback(syncStatus);
			return emitter.on('$store:sync', () => callback(syncStatus));
		},
	};

	const storageStatus$: Readable<StorageStatus> = {
		subscribe(callback: (status: StorageStatus) => void): () => void {
			callback(storageStatus);
			return emitter.on('$store:storage', () => callback(storageStatus));
		},
	};

	// Mark dirty and schedule sync
	function markDirty(): void {
		if (!syncAdapter) return;
		syncDirty = true;
		mutableSyncStatus.hasPendingSync = true;
		emitSyncEvent({ type: 'pending' });
		scheduleSync();
	}

	function scheduleSync(): void {
		if (!syncAdapter || asyncState.status !== 'ready') return;

		if (syncDebounceTimer) {
			clearTimeout(syncDebounceTimer);
		}

		syncDebounceTimer = setTimeout(() => {
			performSync();
		}, debounceMs);
	}

	async function performSync(retryCount = 0): Promise<void> {
		if (!syncAdapter || !internalStorage || asyncState.status !== 'ready') return;

		const currentAccount = account;

		try {
			mutableSyncStatus.isSyncing = true;
			if (retryCount === 0) {
				emitSyncEvent({ type: 'started' });
			}

			const pullResponse = await syncAdapter.pull(currentAccount);
	
			// Handle pull error
			if (!pullResponse.success) {
				throw new Error(pullResponse.error);
			}
	
			let dataToSync = internalStorage;
			let shouldPush = false;
	
			const serverData = pullResponse.data ?? createDefaultInternalStorage();
	
			const {
				storage: cleanedMerged,
				changes,
				serverNeedsUpdate,
			} = mergeAndCleanup(internalStorage, serverData, schema, clock());
			dataToSync = cleanedMerged;
			shouldPush = serverNeedsUpdate;
	
			if (changes.length > 0) {
				internalStorage = cleanedMerged;
				asyncState = { ...asyncState, data: cleanedMerged.data };
	
				for (const change of changes) {
					emitter.emit(
						change.event as keyof StoreEvents<S>,
						change.data as StoreEvents<S>[keyof StoreEvents<S>],
					);
				}
	
				await saveToStorage(currentAccount, cleanedMerged);
			}
	
			if (shouldPush) {
				const clockBigInt = BigInt(clock());
				const newCounter =
					clockBigInt > pullResponse.counter ? clockBigInt : pullResponse.counter + 1n;
				const pushResponse = await syncAdapter.push(currentAccount, dataToSync, newCounter);
	
				if (!pushResponse.success) {
					throw new Error(pushResponse.error);
				}
	
				syncDirty = false;
				mutableSyncStatus.lastSyncedAt = clock();
				mutableSyncStatus.hasPendingSync = false;
				mutableSyncStatus.syncError = null;
				mutableSyncStatus.isSyncing = false;
				emitSyncEvent({ type: 'completed', timestamp: clock() });
			} else {
				mutableSyncStatus.syncError = null;
				mutableSyncStatus.isSyncing = false;
			}
		} catch (error) {
			if (retryCount < maxRetries) {
				const backoffDelay = retryBackoffMs * Math.pow(2, retryCount);
				setTimeout(() => {
					performSync(retryCount + 1);
				}, backoffDelay);
			} else {
				mutableSyncStatus.syncError = error as Error;
				mutableSyncStatus.isSyncing = false;
				emitSyncEvent({ type: 'failed', error: error as Error });
			}
		}
	}

	function createDefaultInternalStorage(): InternalStorage<S> {
		return {
			$version: schemaVersion,
			data: defaultData(),
			$timestamps: {} as InternalStorage<S>['$timestamps'],
			$itemTimestamps: {} as InternalStorage<S>['$itemTimestamps'],
			$tombstones: {} as InternalStorage<S>['$tombstones'],
		};
	}

	async function doStorageSave(acc: `0x${string}`, data: InternalStorage<S>): Promise<void> {
		try {
			await storage.save(storageKey, data);
			mutableStorageStatus.lastSavedAt = clock();
			mutableStorageStatus.storageError = null;
		} catch (error) {
			mutableStorageStatus.storageError = error as Error;
			emitStorageEvent({ type: 'failed', error: error as Error });
			throw error;
		}
	}

	async function processStorageSave(acc: `0x${string}`, data: InternalStorage<S>): Promise<void> {
		try {
			await doStorageSave(acc, data);
		} catch {
			// Error handled in doStorageSave
		}

		if (storageSavePending) {
			const pending = storageSavePending;
			storageSavePending = null;
			emitStorageEvent({ type: 'saving' });
			await processStorageSave(pending.account, pending.data);
		} else {
			mutableStorageStatus.isSaving = false;
			emitStorageEvent({ type: 'saved', timestamp: mutableStorageStatus.lastSavedAt ?? clock() });
		}
	}

	function saveToStorage(acc: `0x${string}`, data: InternalStorage<S>): Promise<void> {
		if (mutableStorageStatus.isSaving) {
			storageSavePending = { account: acc, data };
			return currentSavePromise!;
		}

		mutableStorageStatus.isSaving = true;
		storageSavePending = null;
		emitStorageEvent({ type: 'saving' });

		currentSavePromise = processStorageSave(acc, data);
		return currentSavePromise;
	}

	function setupStorageWatch(): void {
		if (isWatchable(storage)) {
			unwatchStorage = storage.watch(storageKey, async (_, newValue) => {
				if (!newValue || !internalStorage) return;

				const { storage: cleanedMerged, changes } = mergeAndCleanup(
					internalStorage,
					newValue,
					schema,
					clock(),
				);

				if (changes.length > 0) {
					internalStorage = cleanedMerged;

					if (asyncState.status === 'ready') {
						asyncState = { ...asyncState, data: cleanedMerged.data };
					}

					for (const change of changes) {
						emitter.emit(
							change.event as keyof StoreEvents<S>,
							change.data as StoreEvents<S>[keyof StoreEvents<S>],
						);
					}
				}
			});
		}
	}

	function setupGlobalListeners(): void {
		if (syncConfig?.syncOnVisible !== false && typeof document !== 'undefined') {
			handleVisibilityChange = () => {
				if (document.visibilityState === 'visible' && asyncState.status === 'ready') {
					performSync();
				}
			};
			document.addEventListener('visibilitychange', handleVisibilityChange);
		}

		if (syncConfig?.syncOnReconnect !== false && typeof window !== 'undefined') {
			handleOnline = () => {
				mutableSyncStatus.isOnline = true;
				emitSyncEvent({ type: 'online' });
				if (asyncState.status === 'ready') {
					performSync();
				}
			};
			handleOffline = () => {
				mutableSyncStatus.isOnline = false;
				emitSyncEvent({ type: 'offline' });
			};
			window.addEventListener('online', handleOnline);
			window.addEventListener('offline', handleOffline);
		}

		const intervalMs = syncConfig?.intervalMs;
		if (syncAdapter && intervalMs && intervalMs > 0) {
			syncIntervalTimer = setInterval(() => {
				if (asyncState.status === 'ready') {
					performSync();
				}
			}, intervalMs);
		}

		if (typeof window !== 'undefined') {
			handleBeforeUnload = (e: BeforeUnloadEvent) => {
				if (
					mutableStorageStatus.isSaving ||
					(mutableSyncStatus.hasPendingSync && !mutableSyncStatus.syncError)
				) {
					e.preventDefault();
					e.returnValue = 'You have unsaved changes.';
				}
			};
			window.addEventListener('beforeunload', handleBeforeUnload);
		}
	}

	async function load(): Promise<void> {
		if (asyncState.status !== 'idle') {
			throw new Error('Store already loaded or loading');
		}

		asyncState = { status: 'loading', account };
		emitStateEvent({ type: 'loading' });

		const localData = await storage.load(storageKey);

		if (localData) {
			const storedVersion = localData.$version ?? 0;

			if (storedVersion < schemaVersion) {
				try {
					let migrated: unknown = localData;
					for (let v = storedVersion + 1; v <= schemaVersion; v++) {
						const migration = migrations?.[v];
						if (!migration) {
							throw new Error(`Missing migration for version ${v}`);
						}
						migrated = migration(migrated);
						(migrated as { $version: number }).$version = v;
					}
					internalStorage = migrated as InternalStorage<S>;
				} catch (error) {
					mutableStorageStatus.storageError = error as Error;
					emitStorageEvent({ type: 'failed', error: error as Error });
					return;
				}
			} else {
				internalStorage = localData;
			}
		} else {
			internalStorage = createDefaultInternalStorage();
		}

		const { storage: cleanedStorage } = cleanup(internalStorage, schema, clock());
		internalStorage = cleanedStorage;

		await saveToStorage(account, internalStorage);

		asyncState = {
			status: 'ready',
			account,
			data: internalStorage.data,
		};
		emitStateEvent({ type: 'ready' });

		if (syncAdapter) {
			performSync();
		}

		setupStorageWatch();
		setupGlobalListeners();
	}

	const store: SyncableStore<S> = {
		get state() {
			return asyncState as DeepReadonly<AsyncState<DataOf<S>>>;
		},

		get account() {
			return account;
		},

		set<K extends PermanentKeys<S>>(field: K, value: ExtractPermanent<S[K]>): void {
			if (asyncState.status !== 'ready' || !internalStorage) {
				throw new Error('Store is not ready');
			}

			const now = clock();
			(internalStorage.data as Record<string, unknown>)[field as string] = value;
			(internalStorage.$timestamps as Record<string, number>)[field as string] = now;

			asyncState = { ...asyncState, data: { ...internalStorage.data } };

			emitter.emit(
				`${String(field)}:changed` as keyof StoreEvents<S>,
				value as StoreEvents<S>[keyof StoreEvents<S>],
			);

			saveToStorage(account, internalStorage);
			markDirty();
		},

		patch<K extends PermanentKeys<S>>(field: K, value: DeepPartial<ExtractPermanent<S[K]>>): void {
			if (asyncState.status !== 'ready' || !internalStorage) {
				throw new Error('Store is not ready');
			}

			const now = clock();
			const current = (internalStorage.data as Record<string, unknown>)[field as string];
			const merged = deepMerge(current, value);

			(internalStorage.data as Record<string, unknown>)[field as string] = merged;
			(internalStorage.$timestamps as Record<string, number>)[field as string] = now;

			asyncState = { ...asyncState, data: { ...internalStorage.data } };

			emitter.emit(
				`${String(field)}:changed` as keyof StoreEvents<S>,
				merged as StoreEvents<S>[keyof StoreEvents<S>],
			);

			saveToStorage(account, internalStorage);
			markDirty();
		},

		add<K extends MapKeys<S>>(
			field: K,
			key: string,
			value: ExtractMapItem<S[K]>,
			options: { deleteAt: number },
		): void {
			if (asyncState.status !== 'ready' || !internalStorage) {
				throw new Error('Store is not ready');
			}

			const now = clock();
			const items = ((internalStorage.data as Record<string, unknown>)[field as string] ??
				{}) as Record<string, unknown>;
			const timestamps =
				(internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[
					field as string
				] ?? {};

			const itemWithDeleteAt = {
				...(value as object),
				deleteAt: options.deleteAt,
			};
			items[key] = itemWithDeleteAt;
			timestamps[key] = now;

			(internalStorage.data as Record<string, unknown>)[field as string] = items;
			(internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[
				field as string
			] = timestamps;

			asyncState = { ...asyncState, data: { ...internalStorage.data } };

			emitter.emit(
				`${String(field)}:added` as keyof StoreEvents<S>,
				{ key, item: itemWithDeleteAt } as StoreEvents<S>[keyof StoreEvents<S>],
			);

			saveToStorage(account, internalStorage);
			markDirty();
		},

		update<K extends MapKeys<S>>(field: K, key: string, value: ExtractMapItem<S[K]>): void {
			if (asyncState.status !== 'ready' || !internalStorage) {
				throw new Error('Store is not ready');
			}

			const items = ((internalStorage.data as Record<string, unknown>)[field as string] ??
				{}) as Record<string, { deleteAt: number }>;
			const existing = items[key];

			if (!existing) {
				throw new Error(`Item ${key} does not exist in ${String(field)}`);
			}

			const now = clock();
			const timestamps =
				(internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[
					field as string
				] ?? {};

			const updatedItem = { ...(value as object), deleteAt: existing.deleteAt };
			items[key] = updatedItem;
			timestamps[key] = now;

			(internalStorage.data as Record<string, unknown>)[field as string] = items;
			(internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[
				field as string
			] = timestamps;

			asyncState = { ...asyncState, data: { ...internalStorage.data } };

			emitter.emit(
				`${String(field)}:updated` as keyof StoreEvents<S>,
				{ key, item: updatedItem } as StoreEvents<S>[keyof StoreEvents<S>],
			);

			saveToStorage(account, internalStorage);
			markDirty();
		},

		remove<K extends MapKeys<S>>(field: K, key: string): void {
			if (asyncState.status !== 'ready' || !internalStorage) {
				throw new Error('Store is not ready');
			}

			const items = ((internalStorage.data as Record<string, unknown>)[field as string] ??
				{}) as Record<string, { deleteAt: number }>;
			const existing = items[key];

			if (!existing) {
				throw new Error(`Item ${key} does not exist in ${String(field)}`);
			}

			const tombstones =
				(internalStorage.$tombstones as Record<string, Record<string, number>>)[field as string] ??
				{};
			tombstones[key] = existing.deleteAt;
			(internalStorage.$tombstones as Record<string, Record<string, number>>)[field as string] =
				tombstones;

			delete items[key];

			const timestamps =
				(internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[
					field as string
				] ?? {};
			delete timestamps[key];

			asyncState = { ...asyncState, data: { ...internalStorage.data } };

			emitter.emit(
				`${String(field)}:removed` as keyof StoreEvents<S>,
				{ key, item: existing } as StoreEvents<S>[keyof StoreEvents<S>],
			);

			saveToStorage(account, internalStorage);
			markDirty();
		},

		subscribe(callback: (state: AsyncState<DataOf<S>>) => void): () => void {
			callback(asyncState);
			return emitter.on('$store:state', () => callback(asyncState));
		},

		on: emitter.on.bind(emitter),
		off: emitter.off.bind(emitter),

		syncStatus$,
		storageStatus$,

		load,

		stop(): void {
			unwatchStorage?.();
			unwatchStorage = undefined;

			if (syncDebounceTimer) {
				clearTimeout(syncDebounceTimer);
				syncDebounceTimer = undefined;
			}

			if (handleVisibilityChange) {
				document.removeEventListener('visibilitychange', handleVisibilityChange);
				handleVisibilityChange = undefined;
			}

			if (handleOnline) {
				window.removeEventListener('online', handleOnline);
				handleOnline = undefined;
			}
			if (handleOffline) {
				window.removeEventListener('offline', handleOffline);
				handleOffline = undefined;
			}

			if (syncIntervalTimer) {
				clearInterval(syncIntervalTimer);
				syncIntervalTimer = undefined;
			}

			if (handleBeforeUnload) {
				window.removeEventListener('beforeunload', handleBeforeUnload);
				handleBeforeUnload = undefined;
			}
		},

		watchItem<K extends MapKeys<S>>(
			field: K,
			key: string,
		): Readable<(ExtractMapItem<S[K]> & { deleteAt: number }) | undefined> {
			type ItemType = (ExtractMapItem<S[K]> & { deleteAt: number }) | undefined;

			const cacheKey = `${String(field)}:${key}`;
			const cached = itemStoreCache.get(cacheKey);
			if (cached) return cached as Readable<ItemType>;

			const getCurrentValue = (): ItemType => {
				if (asyncState.status !== 'ready') return undefined;
				const items = (asyncState.data[field] as Record<string, unknown>) ?? {};
				return items[key] as ItemType;
			};

			const itemStore: Readable<ItemType> = {
				subscribe(callback: (value: ItemType) => void): () => void {
					callback(getCurrentValue());

					const unsubState = emitter.on('$store:state', () => callback(getCurrentValue()));

					const unsubAdded = emitter.on(
						`${String(field)}:added` as keyof StoreEvents<S>,
						(e) => {
							const event = e as { key: string; item: unknown };
							if (event.key === key) callback(event.item as ItemType);
						},
					);
					const unsubUpdated = emitter.on(
						`${String(field)}:updated` as keyof StoreEvents<S>,
						(e) => {
							const event = e as { key: string; item: unknown };
							if (event.key === key) callback(event.item as ItemType);
						},
					);
					const unsubRemoved = emitter.on(
						`${String(field)}:removed` as keyof StoreEvents<S>,
						(e) => {
							const event = e as { key: string };
							if (event.key === key) callback(undefined);
						},
					);

					return () => {
						unsubState();
						unsubAdded();
						unsubUpdated();
						unsubRemoved();
					};
				},
			};

			itemStoreCache.set(cacheKey, itemStore);
			return itemStore;
		},

		watchField<K extends keyof S>(field: K): Readable<DataOf<S>[K] | undefined> {
			type FieldType = DataOf<S>[K] | undefined;

			const cacheKey = String(field);
			const cached = fieldStoreCache.get(cacheKey);
			if (cached) return cached as Readable<FieldType>;

			const getCurrentValue = (): FieldType => {
				if (asyncState.status !== 'ready') return undefined;
				return asyncState.data[field];
			};

			const fieldDef = schema[field];
			const isMap = fieldDef.__type === 'map';

			const fieldStore: Readable<FieldType> = {
				subscribe(callback: (value: FieldType) => void): () => void {
					callback(getCurrentValue());

					const unsubState = emitter.on('$store:state', () => callback(getCurrentValue()));

					const unsubs: (() => void)[] = [unsubState];

					if (isMap) {
						unsubs.push(
							emitter.on(`${String(field)}:added` as keyof StoreEvents<S>, () => {
								callback(getCurrentValue());
							}),
						);
						unsubs.push(
							emitter.on(`${String(field)}:removed` as keyof StoreEvents<S>, () => {
								callback(getCurrentValue());
							}),
						);
					} else {
						unsubs.push(
							emitter.on(`${String(field)}:changed` as keyof StoreEvents<S>, () => {
								callback(getCurrentValue());
							}),
						);
					}

					return () => {
						for (const unsub of unsubs) {
							unsub();
						}
					};
				},
			};

			fieldStoreCache.set(cacheKey, fieldStore);
			return fieldStore;
		},

		async syncNow(): Promise<void> {
			if (!syncAdapter || asyncState.status !== 'ready') return;

			if (syncDebounceTimer) {
				clearTimeout(syncDebounceTimer);
				syncDebounceTimer = undefined;
			}

			await performSync();
		},

		retryLoad(): void {
			if (asyncState.status !== 'loading') {
				throw new Error('Can only retry when in loading state');
			}

			mutableStorageStatus.storageError = null;
			emitStorageEvent({ type: 'saved', timestamp: clock() });

			asyncState = { status: 'idle', account: undefined };
			load();
		},

		async flush(timeoutMs = 30000): Promise<void> {
			const startTime = clock();
			while (mutableStorageStatus.isSaving) {
				if (clock() - startTime > timeoutMs) {
					throw new Error(`flush() timed out after ${timeoutMs}ms`);
				}
				await new Promise((r) => setTimeout(r, 10));
			}
		},
	};

	return store;
}

// ============================================================================
// Helpers
// ============================================================================

function deepMerge<T>(target: T, source: DeepPartial<T>): T {
	if (typeof source !== 'object' || source === null) {
		return source as T;
	}

	if (Array.isArray(source)) {
		return source as T;
	}

	if (typeof target !== 'object' || target === null || Array.isArray(target)) {
		return source as T;
	}

	const result = { ...target };

	for (const key of Object.keys(source) as (keyof T)[]) {
		const sourceValue = source[key];
		if (sourceValue !== undefined) {
			(result as Record<string, unknown>)[key as string] = deepMerge(
				target[key],
				sourceValue as DeepPartial<T[keyof T]>,
			);
		}
	}

	return result;
}
