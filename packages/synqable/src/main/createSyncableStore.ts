import type {
	Schema,
	InternalStorage,
	DataOf,
	AsyncState,
	StorageStatus,
	StoreLifecycleState,
	ValueKeys,
	RecordKeys,
	WholeFieldKeys,
	MapKeys,
	ExtractValue,
	ExtractRecord,
	ExtractMapItem,
	DeepPartial,
	DeepReadonly,
	MutationOptions,
	SyncableStoreConfig,
	SyncableStore,
	StoreWriter,
	Readable,
	MapField,
	RemovalMutationOptions,
} from './types.js';
import {StoreUnavailableError} from './types.js';

import type {SyncStatus, StoreEventsWithSync} from '../sync/types.js';

import {isWatchable} from '../storage/types.js';
import {cleanup} from './cleanup.js';
import {mergeAndCleanup} from './merge.js';
import {createEmitter} from 'radiate';
import {reportUncaught} from './reportError.js';
import {deepMerge} from './helpers.js';
import {logs} from 'named-logs';

const logger = logs('synqable:store');

/**
 * Single-Account Syncable Store
 *
 * Creates a type-safe syncable store bound to ONE specific account.
 */
export function createSyncableStore<S extends Schema>(
	config: SyncableStoreConfig<S>,
): SyncableStore<S> {
	const {
		schema,
		account,
		privateKey,
		storage: storageConfig,
		defaultData,
		clock = Date.now,
		schemaVersion = 1,
		sync: syncConfig,
		migrations,
	} = config;

	// Extract storage components - pass privateKey for encryption
	const storageAdapter = storageConfig.adapterFactory(privateKey);
	const storageKey = storageConfig.key;
	const storageDebounceMs = storageConfig.options?.debounceMs ?? 100;

	// Extract sync components - pass privateKey for encryption/signing
	const syncAdapter = syncConfig?.adapterFactory(privateKey);
	const syncOptions = syncConfig?.options;

	// Sync configuration with defaults
	const debounceMs = syncOptions?.debounceMs ?? 1000;
	const maxRetries = syncOptions?.maxRetries ?? 3;
	const retryBackoffMs = syncOptions?.retryBackoffMs ?? 1000;

	// State. A single-account store knows its account from the start, so even its
	// `idle` carries it: `idle` with no account is reserved for a multi-account
	// store with no account connected.
	let asyncState: AsyncState<DataOf<S>> = {
		status: 'idle',
		account,
		isLoading: false,
		loadError: null,
	};
	let internalStorage: InternalStorage<S> | null = null;

	// Terminal: set by stop(). Revokes the write handle and cancels a load in flight.
	let stopped = false;

	// Pending ready() calls, settled on ready, on a load error, or on stop().
	const readyWaiters: {
		resolve: (writer: StoreWriter<S>) => void;
		reject: (error: StoreUnavailableError) => void;
	}[] = [];

	function stoppedError(): StoreUnavailableError {
		return new StoreUnavailableError('stopped', `Store for ${account} was stopped`, {account});
	}

	function loadFailedError(cause: Error): StoreUnavailableError {
		return new StoreUnavailableError(
			'load-failed',
			`Store for ${account} failed to load: ${cause.message}`,
			{account, cause},
		);
	}

	function settleReadyWaiters(
		outcome: {writer: StoreWriter<S>} | {error: StoreUnavailableError},
	): void {
		const waiters = readyWaiters.splice(0, readyWaiters.length);
		for (const waiter of waiters) {
			if ('writer' in outcome) {
				waiter.resolve(outcome.writer);
			} else {
				waiter.reject(outcome.error);
			}
		}
	}

	/**
	 * A handle given out before stop() must not write into a store nobody reads:
	 * the save and the push would still fire, and a fresh store for the same
	 * account would overwrite the write with its next save, silently.
	 */
	function assertNotRevoked(): void {
		if (stopped) {
			throw new StoreUnavailableError(
				'stopped',
				`Store for ${account} was stopped; its write handle is revoked`,
				{account},
			);
		}
	}

	// Storage state - simplified with just boolean flags
	let storageDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	let storageSavePending = false;
	let isStorageSaving = false;

	// Durability bookkeeping for persisted(). Every write bumps writeSeq; a save
	// records the writeSeq it started at, and a save always writes the whole
	// current state, so a save that started at or after a write includes it.
	// savedSeq is the highest such start of a SUCCESSFUL save: every write up to
	// it is on storage, whatever later saves did. A write made while a save is in
	// flight is not counted as included in it (the adapter may already have
	// serialized the state); it sets storageSavePending, so another save follows.
	let writeSeq = 0;
	let savedSeq = 0;
	// The error of the most recent failed save, for a stopped store that will not retry.
	let lastSaveError: Error | null = null;
	const persistedWaiters: {
		target: number;
		resolve: () => void;
		reject: (error: Error) => void;
	}[] = [];

	/** Settle the waiters whose writes the save that started at `savedThrough` included. */
	function settlePersistedWaiters(
		savedThrough: number,
		outcome: {saved: true} | {saved: false; error: Error},
	): void {
		for (let i = persistedWaiters.length - 1; i >= 0; i--) {
			const waiter = persistedWaiters[i];
			if (waiter.target <= savedThrough) {
				persistedWaiters.splice(i, 1);
				if (outcome.saved) {
					waiter.resolve();
				} else {
					waiter.reject(outcome.error);
				}
			}
		}
	}

	/** An adapter may reject with anything; persisted() always rejects with an Error. */
	function toSaveError(error: unknown): Error {
		return error instanceof Error
			? error
			: new Error(`Storage save failed for ${account}: ${String(error)}`, {cause: error});
	}

	/**
	 * Resolves once every write made before the call is on storage; rejects with
	 * the storage error when the save that included them failed and no further
	 * save is queued. See `SyncableStore.persisted` for the contract.
	 */
	function persisted(): Promise<void> {
		const target = writeSeq;
		if (savedSeq >= target) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			if (isStorageSaving || storageSavePending) {
				// A save that will include these writes is in flight or queued.
				persistedWaiters.push({target, resolve, reject});
				if (!isStorageSaving && !stopped) {
					// Queued behind the debounce: save now, as flush() does.
					if (storageDebounceTimer) {
						clearTimeout(storageDebounceTimer);
						storageDebounceTimer = undefined;
					}
					void performStorageSave();
				}
				return;
			}
			// Nothing in flight or queued, so the last save that included these
			// writes failed. A stopped store does not save again: its save would
			// race the fresh store for the same account.
			if (stopped) {
				reject(lastSaveError ?? stoppedError());
				return;
			}
			persistedWaiters.push({target, resolve, reject});
			storageSavePending = true;
			void performStorageSave();
		});
	}

	// Sync state - boolean flag for queue protection
	let syncPending = false;

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

	// Listener errors. A listener that throws must never leave the store's own
	// state half done (a write in memory but never saved, a save flag stuck on),
	// so the store always commits its state BEFORE it notifies, and every
	// listener runs even when an earlier one throws. Where the error goes
	// depends on who triggered the event:
	// - an event with a synchronous caller (a mutator's data event, load()'s
	//   state events) throws the first listener error to that caller, after
	//   every listener ran (emitToCaller);
	// - an event with no caller to throw to (storage and sync status events,
	//   data events from a sync or storage-watch merge) reports it
	//   (emitIsolated, reportListenerError).
	// Only the first error can be thrown, so any further ones are reported.
	type ListenerError = {event: string; error: unknown};
	let listenerErrorSink: ListenerError[] | null = null;

	function reportListenerError({event, error}: ListenerError): void {
		logger.error('listener:error', {storageKey, event, error});
		reportUncaught(`a listener for '${event}' threw`, error);
	}

	/** Throw the first listener error to the caller; report the rest. */
	function throwListenerErrors(errors: ListenerError[]): void {
		if (errors.length === 0) return;
		for (const extra of errors.slice(1)) {
			reportListenerError(extra);
		}
		throw errors[0].error;
	}

	const emitter = createEmitter<StoreEventsWithSync<S>>({
		errorHandler: (event, error) => {
			if (listenerErrorSink) {
				listenerErrorSink.push({event: String(event), error});
			} else {
				reportListenerError({event: String(event), error});
			}
		},
	});

	/** Emit for a synchronous caller: every listener runs, then the first error is thrown. */
	function emitToCaller(emit: () => void): void {
		const outer = listenerErrorSink;
		const errors: ListenerError[] = [];
		listenerErrorSink = errors;
		try {
			emit();
		} finally {
			listenerErrorSink = outer;
		}
		throwListenerErrors(errors);
	}

	/** Emit with no caller to throw to: every listener runs, and errors are reported. */
	function emitIsolated(emit: () => void): void {
		const outer = listenerErrorSink;
		listenerErrorSink = null;
		try {
			emit();
		} finally {
			listenerErrorSink = outer;
		}
	}

	// Event type definitions
	type SyncEventData =
		| {type: 'pending'}
		| {type: 'started'}
		| {type: 'completed'; timestamp: number}
		| {type: 'failed'; error: Error}
		| {type: 'offline'}
		| {type: 'online'};

	type StorageEventData =
		| {type: 'saving'}
		| {type: 'saved'; timestamp: number}
		| {type: 'failed'; error: Error};

	type StateEventData =
		| {type: 'idle'}
		| {type: 'loading'}
		| {type: 'ready'}
		| {type: 'error'; error: Error};

	// Status events are emitted from inside the save and sync machinery, which
	// has no caller to throw to, so they are always isolated.
	function emitSyncEvent(event: SyncEventData): void {
		emitIsolated(() =>
			(emitter.emit as (eventName: '$store:sync', data: SyncEventData) => void)(
				'$store:sync',
				event,
			),
		);
	}

	function emitStorageEvent(event: StorageEventData): void {
		emitIsolated(() =>
			(emitter.emit as (eventName: '$store:storage', data: StorageEventData) => void)(
				'$store:storage',
				event,
			),
		);
	}

	/** Data events from a merge (sync or storage watch): no caller, so isolated. */
	function emitMergeChanges(changes: {event: string; data: unknown}[]): void {
		emitIsolated(() => {
			for (const change of changes) {
				emitter.emit(
					change.event as keyof StoreEventsWithSync<S>,
					change.data as StoreEventsWithSync<S>[keyof StoreEventsWithSync<S>],
				);
			}
		});
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

	// Derive lifecycle state from asyncState (without data)
	function getLifecycleState(): StoreLifecycleState {
		if (asyncState.status === 'ready') {
			return {
				status: 'ready',
				account: asyncState.account,
				isLoading: false,
				loadError: null,
			};
		}
		if (asyncState.status === 'error') {
			return {
				status: 'error',
				account: asyncState.account,
				isLoading: false,
				loadError: asyncState.loadError,
			};
		}
		if (asyncState.isLoading) {
			return {
				status: 'loading',
				account,
				isLoading: true,
				loadError: null,
			};
		}
		return {
			status: 'idle',
			account,
			isLoading: false,
			loadError: null,
		};
	}

	const state$: Readable<StoreLifecycleState> = {
		subscribe(callback: (state: StoreLifecycleState) => void): () => void {
			callback(getLifecycleState());
			return emitter.on('$store:state', () => callback(getLifecycleState()));
		},
	};

	// Mark dirty and schedule sync
	function markDirty(): void {
		if (!syncAdapter) return;
		syncDirty = true;
		mutableSyncStatus.hasPendingSync = true;
		emitSyncEvent({type: 'pending'});
		scheduleSync();
	}

	function scheduleSync(): void {
		if (!syncAdapter || stopped || asyncState.status !== 'ready') return;

		if (syncDebounceTimer) {
			clearTimeout(syncDebounceTimer);
		}

		syncDebounceTimer = setTimeout(() => {
			performSync();
		}, debounceMs);
	}

	async function performSync(retryCount = 0): Promise<void> {
		// A stopped store does not sync: stop() is terminal, and a merge saved by a
		// stopped store would race the fresh store for the same account.
		if (!syncAdapter || !internalStorage || stopped || asyncState.status !== 'ready') return;

		// Prevent concurrent syncs - just set flag
		if (mutableSyncStatus.isSyncing) {
			syncPending = true;
			return;
		}

		const currentAccount = account;

		try {
			mutableSyncStatus.isSyncing = true;
			if (retryCount === 0) {
				emitSyncEvent({type: 'started'});
			}

			const pullResponse = await syncAdapter.pull(currentAccount);

			if (stopped) {
				mutableSyncStatus.isSyncing = false;
				return;
			}

			// Handle pull error
			if (!pullResponse.success) {
				throw new Error(pullResponse.error);
			}

			const serverData = pullResponse.data ?? createDefaultInternalStorage();

			const {
				storage: cleanedMerged,
				changes,
				serverNeedsUpdate,
			} = mergeAndCleanup(internalStorage, serverData, schema, clock());

			if (changes.length > 0) {
				internalStorage = cleanedMerged;
				asyncState = {...asyncState, data: cleanedMerged.data};

				// Save before notifying, so a listener cannot keep the merge off storage.
				scheduleStorageSave(true);
				emitMergeChanges(changes);
			}

			if (serverNeedsUpdate) {
				const clockBigInt = BigInt(clock());
				const newCounter =
					clockBigInt > pullResponse.counter ? clockBigInt : pullResponse.counter + 1n;
				// Use internalStorage for push - always has latest state
				const pushResponse = await syncAdapter.push(currentAccount, internalStorage, newCounter);

				if (!pushResponse.success) {
					throw new Error(pushResponse.error);
				}
			}

			syncDirty = false;
			mutableSyncStatus.lastSyncedAt = clock();
			mutableSyncStatus.hasPendingSync = false;
			mutableSyncStatus.syncError = null;
			mutableSyncStatus.isSyncing = false;
			emitSyncEvent({type: 'completed', timestamp: clock()});
		} catch (error) {
			if (retryCount < maxRetries) {
				const backoffDelay = retryBackoffMs * Math.pow(2, retryCount);
				// Set isSyncing to false before retry so the retry can proceed
				mutableSyncStatus.isSyncing = false;
				setTimeout(() => {
					performSync(retryCount + 1);
				}, backoffDelay);
				return; // Don't process pending yet, retry will handle it
			} else {
				mutableSyncStatus.syncError = error as Error;
				mutableSyncStatus.isSyncing = false;
				emitSyncEvent({type: 'failed', error: error as Error});
			}
		}

		// Process any sync requested during this one
		if (syncPending) {
			syncPending = false;
			performSync();
		}
	}

	/**
	 * Write a value or record field, stamping timestamps at the granularity the
	 * field type merges at: one field-level timestamp for a value field,
	 * per-property timestamps for a record field.
	 *
	 * A record field deliberately does NOT maintain a field-level timestamp.
	 * `mergeRecord` treats a field-level timestamp as the floor for properties
	 * that have none, so writing one here would make untouched properties look
	 * freshly edited and beat another device's genuine edit.
	 */
	function writeWholeField(
		field: string,
		newValue: unknown,
		stamped: string[] | 'all',
		now: number,
	): void {
		if (!internalStorage) return;

		(internalStorage.data as Record<string, unknown>)[field] = newValue;

		if (schema[field].__type !== 'record') {
			(internalStorage.$timestamps as Record<string, number>)[field] = now;
			return;
		}

		const allTimestamps = internalStorage.$itemTimestamps as Record<string, Record<string, number>>;
		const timestamps = allTimestamps[field] ?? {};
		const keys = stamped === 'all' ? Object.keys((newValue ?? {}) as object) : stamped;
		for (const key of keys) {
			timestamps[key] = now;
		}
		allTimestamps[field] = timestamps;
	}

	/** Top-level property names whose value differs between two structs. */
	function changedProperties(before: object, after: object): string[] {
		const previous = (before ?? {}) as Record<string, unknown>;
		const next = (after ?? {}) as Record<string, unknown>;
		const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
		const changed: string[] = [];
		for (const key of keys) {
			if (!Object.is(previous[key], next[key])) {
				changed.push(key);
			}
		}
		return changed;
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

	function scheduleStorageSave(immediate = false): void {
		logger.debug('scheduleStorageSave', {immediate, storageKey, account});
		writeSeq++;
		storageSavePending = true;

		if (immediate) {
			logger.debug('scheduleStorageSave:immediate', {storageKey});
			// Clear any pending debounce and execute now
			if (storageDebounceTimer) {
				clearTimeout(storageDebounceTimer);
				storageDebounceTimer = undefined;
			}
			performStorageSave();
			return;
		}

		// Debounce: reset timer on each call
		if (storageDebounceTimer) {
			logger.debug('scheduleStorageSave:debounce:reset', {
				storageKey,
				debounceMs: storageDebounceMs,
			});
			clearTimeout(storageDebounceTimer);
		}

		logger.debug('scheduleStorageSave:debounce:scheduled', {
			storageKey,
			debounceMs: storageDebounceMs,
		});
		storageDebounceTimer = setTimeout(() => {
			storageDebounceTimer = undefined;
			logger.debug('scheduleStorageSave:debounce:fired', {storageKey});
			performStorageSave();
		}, storageDebounceMs);
	}

	async function performStorageSave(): Promise<void> {
		logger.debug('performStorageSave', {storageKey, account, storageSavePending, isStorageSaving});
		if (!storageSavePending) {
			logger.debug('performStorageSave:skip:noPending', {storageKey});
			return;
		}

		// If already saving, just ensure flag is set - will be processed after
		if (isStorageSaving) {
			logger.debug('performStorageSave:skip:alreadySaving', {storageKey});
			return;
		}

		isStorageSaving = true;
		storageSavePending = false;
		const savedThrough = writeSeq;
		mutableStorageStatus.isSaving = true;
		emitStorageEvent({type: 'saving'});
		let saveError: Error | undefined;
		logger.debug('performStorageSave:start', {storageKey, hasInternalStorage: !!internalStorage});

		try {
			// Use internalStorage reference directly - always has latest state
			if (internalStorage) {
				logger.debug('performStorageSave:calling:save', {storageKey});
				await storageAdapter.save(storageKey, internalStorage);
				mutableStorageStatus.lastSavedAt = clock();
				mutableStorageStatus.storageError = null;
				if (savedThrough > savedSeq) {
					savedSeq = savedThrough;
				}
				settlePersistedWaiters(savedThrough, {saved: true});
				logger.debug('performStorageSave:success', {
					storageKey,
					lastSavedAt: mutableStorageStatus.lastSavedAt,
				});
			} else {
				logger.warn('performStorageSave:noInternalStorage', {storageKey});
			}
		} catch (error) {
			logger.error('performStorageSave:error', {storageKey, error});
			mutableStorageStatus.storageError = error as Error;
			saveError = toSaveError(error);
			lastSaveError = saveError;
			emitStorageEvent({type: 'failed', error: error as Error});
		} finally {
			isStorageSaving = false;

			// Process any changes that came in during save
			if (storageSavePending) {
				logger.debug('performStorageSave:requeue', {storageKey});
				await performStorageSave();
			} else {
				// A failure settles its waiters only here, after the `failed` listeners
				// ran: a write made by one of them queues a save that includes the
				// same writes (handled above, so they wait for it), and a persisted()
				// called from one of them is registered by now and is settled too.
				if (saveError) {
					settlePersistedWaiters(savedThrough, {saved: false, error: saveError});
				}
				mutableStorageStatus.isSaving = false;
				logger.debug('performStorageSave:complete', {storageKey});
				emitStorageEvent({
					type: 'saved',
					timestamp: mutableStorageStatus.lastSavedAt ?? clock(),
				});
			}
		}
	}

	function setupStorageWatch(): void {
		if (isWatchable(storageAdapter)) {
			unwatchStorage = storageAdapter.watch(storageKey, async (_, newValue) => {
				if (!newValue || !internalStorage) return;

				const {storage: cleanedMerged, changes} = mergeAndCleanup(
					internalStorage,
					newValue,
					schema,
					clock(),
				);

				if (changes.length > 0) {
					internalStorage = cleanedMerged;

					if (asyncState.status === 'ready') {
						asyncState = {...asyncState, data: cleanedMerged.data};
					}

					emitMergeChanges(changes);
				}
			});
		}
	}

	function setupGlobalListeners(): void {
		if (syncOptions?.syncOnVisible !== false && typeof document !== 'undefined') {
			handleVisibilityChange = () => {
				if (document.visibilityState === 'visible' && asyncState.status === 'ready') {
					performSync();
				}
			};
			document.addEventListener('visibilitychange', handleVisibilityChange);
		}

		if (syncOptions?.syncOnReconnect !== false && typeof window !== 'undefined') {
			handleOnline = () => {
				mutableSyncStatus.isOnline = true;
				emitSyncEvent({type: 'online'});
				if (asyncState.status === 'ready') {
					performSync();
				}
			};
			handleOffline = () => {
				mutableSyncStatus.isOnline = false;
				emitSyncEvent({type: 'offline'});
			};
			window.addEventListener('online', handleOnline);
			window.addEventListener('offline', handleOffline);
		}

		const intervalMs = syncOptions?.intervalMs;
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
		logger.info('load', {storageKey, account});
		if (stopped) {
			throw stoppedError();
		}
		if (asyncState.status !== 'idle' || asyncState.isLoading) {
			logger.warn('load:skip:alreadyLoadedOrLoading', {
				storageKey,
				status: asyncState.status,
				isLoading: asyncState.isLoading,
			});
			throw new Error('Store already loaded or loading');
		}

		// State events have load()'s caller to throw to, but a listener that
		// throws must not stop the load half way (stuck loading, with ready()
		// never settling). So each listener error is kept, the load runs to its
		// end, and load() then rejects with the first one, the store in the state
		// the load reached (ready stays ready, as before).
		const listenerErrors: ListenerError[] = [];
		const emitState = (event: StateEventData): void => {
			const outer = listenerErrorSink;
			listenerErrorSink = listenerErrors;
			try {
				emitStateEvent(event);
			} finally {
				listenerErrorSink = outer;
			}
		};
		try {
			await runLoad(emitState);
		} catch (error) {
			// The load itself threw: that is the error load() rejects with, so the
			// listener errors collected so far are reported rather than lost.
			for (const listenerError of listenerErrors) {
				reportListenerError(listenerError);
			}
			throw error;
		}
		throwListenerErrors(listenerErrors);
	}

	async function runLoad(emitState: (event: StateEventData) => void): Promise<void> {
		asyncState = {status: 'idle', account, isLoading: true, loadError: null};
		emitState({type: 'loading'});
		logger.debug('load:start', {storageKey});

		try {
			logger.debug('load:calling:storageAdapter.load', {storageKey});
			const localData = await storageAdapter.load(storageKey);

			// Stopped while loading (an account switch, a teardown): do not become
			// ready, and do not install listeners that stop() has already torn down.
			if (stopped) {
				logger.debug('load:abort:stopped', {storageKey});
				asyncState = {status: 'idle', account, isLoading: false, loadError: null};
				emitState({type: 'idle'});
				return;
			}
			logger.debug('load:storageAdapter.load:result', {
				storageKey,
				hasLocalData: !!localData,
				version: localData?.$version,
			});

			if (localData) {
				const storedVersion = localData.$version ?? 0;
				logger.debug('load:localData:found', {storageKey, storedVersion, schemaVersion});

				if (storedVersion < schemaVersion) {
					logger.debug('load:migration:start', {
						storageKey,
						from: storedVersion,
						to: schemaVersion,
					});
					let migrated: unknown = localData;
					for (let v = storedVersion + 1; v <= schemaVersion; v++) {
						const migration = migrations?.[v];
						if (!migration) {
							logger.error('load:migration:missing', {storageKey, version: v});
							throw new Error(`Missing migration for version ${v}`);
						}
						logger.debug('load:migration:applying', {storageKey, version: v});
						migrated = migration(migrated);
						(migrated as {$version: number}).$version = v;
					}
					logger.debug('load:migration:complete', {storageKey, version: schemaVersion});
					internalStorage = migrated as InternalStorage<S>;
				} else {
					internalStorage = localData;
				}
			} else {
				logger.debug('load:noLocalData:creatingDefault', {storageKey});
				internalStorage = createDefaultInternalStorage();
			}

			const {
				storage: cleanedStorage,
				// changes,
				// tombstonesDeleted,
			} = cleanup(internalStorage, schema, clock());
			internalStorage = cleanedStorage;
			logger.debug('load:cleanup:complete', {storageKey});

			// Cleanup results will be persisted when the next mutation or sync occurs
		} catch (error) {
			logger.error('load:error', {storageKey, error});
			if (stopped) {
				asyncState = {status: 'idle', account, isLoading: false, loadError: null};
				emitState({type: 'idle'});
				return;
			}
			const loadError = error as Error;
			asyncState = {status: 'error', account, isLoading: false, loadError};
			settleReadyWaiters({error: loadFailedError(loadError)});
			emitState({type: 'error', error: loadError});
			return;
		}

		// Ready. Outside the try on purpose: only a failure to READ the data is a
		// load error. A state listener that throws on 'ready' propagates out of
		// load() but leaves the store ready, rather than turning it into 'error'
		// after 'ready' was already announced.
		//
		// Everything is installed BEFORE the event is emitted, so a listener that
		// reacts to 'ready' by calling stop() tears down what is really there,
		// instead of the load installing listeners on a stopped store afterwards.
		asyncState = {
			status: 'ready',
			account,
			isLoading: false,
			loadError: null,
			data: internalStorage.data,
		};
		setupStorageWatch();
		setupGlobalListeners();
		settleReadyWaiters({writer: writerHandle});
		if (syncAdapter) {
			logger.debug('load:triggerSync', {storageKey});
			performSync();
		}
		logger.info('load:ready', {storageKey, account});
		emitState({type: 'ready'});
	}

	// The write handle. Created once; only handed out while the store is ready.
	const writerHandle: StoreWriter<S> = {
		get account() {
			return account;
		},

		read() {
			assertNotRevoked();
			if (asyncState.status !== 'ready') {
				throw new Error('Store is not ready');
			}
			return asyncState.data as DeepReadonly<DataOf<S>>;
		},

		// Not revoked by stop(): it only waits on writes accepted before it.
		persisted,

		set<K extends WholeFieldKeys<S>>(
			field: K,
			value: DataOf<S>[K],
			options?: MutationOptions,
		): void {
			assertNotRevoked();
			if (asyncState.status !== 'ready' || !internalStorage) {
				throw new Error('Store is not ready');
			}

			// `set` asserts the whole field, so on a record every property is stamped.
			writeWholeField(field as string, value, 'all', clock());

			asyncState = {...asyncState, data: {...internalStorage.data}};

			// Commit before notifying: a listener that throws cannot keep the write
			// off storage or out of sync. Its error still reaches the caller.
			scheduleStorageSave(options?.immediate);
			markDirty();
			emitToCaller(() =>
				emitter.emit(
					`${String(field)}:changed` as keyof StoreEventsWithSync<S>,
					value as StoreEventsWithSync<S>[keyof StoreEventsWithSync<S>],
				),
			);
		},

		update<K extends RecordKeys<S>>(
			field: K,
			value: DeepPartial<ExtractRecord<S[K]>>,
			options?: MutationOptions,
		): void {
			assertNotRevoked();
			if (asyncState.status !== 'ready' || !internalStorage) {
				throw new Error('Store is not ready');
			}

			const current = (internalStorage.data as Record<string, unknown>)[field as string];
			const merged = deepMerge(current, value);

			// Only the properties actually supplied are stamped, so a concurrent edit
			// to any other property still wins its own merge.
			const touched = Object.keys((value ?? {}) as object);
			writeWholeField(field as string, merged, touched, clock());

			asyncState = {...asyncState, data: {...internalStorage.data}};

			// Commit before notifying: a listener that throws cannot keep the write
			// off storage or out of sync. Its error still reaches the caller.
			scheduleStorageSave(options?.immediate);
			markDirty();
			emitToCaller(() =>
				emitter.emit(
					`${String(field)}:changed` as keyof StoreEventsWithSync<S>,
					merged as StoreEventsWithSync<S>[keyof StoreEventsWithSync<S>],
				),
			);
		},

		addItem<K extends MapKeys<S>>(
			field: K,
			key: string,
			value: ExtractMapItem<S[K]>,
			options: {deleteAt: number; immediate?: boolean},
		): void {
			assertNotRevoked();
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
			(internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[field as string] =
				timestamps;

			asyncState = {...asyncState, data: {...internalStorage.data}};

			// Commit before notifying: a listener that throws cannot keep the write
			// off storage or out of sync. Its error still reaches the caller.
			scheduleStorageSave(options.immediate);
			markDirty();
			emitToCaller(() =>
				emitter.emit(
					`${String(field)}:added` as keyof StoreEventsWithSync<S>,
					{key, item: itemWithDeleteAt} as StoreEventsWithSync<S>[keyof StoreEventsWithSync<S>],
				),
			);
		},

		setItem<K extends MapKeys<S>>(
			field: K,
			key: string,
			value: ExtractMapItem<S[K]>,
			options?: MutationOptions,
		): void {
			assertNotRevoked();
			if (asyncState.status !== 'ready' || !internalStorage) {
				throw new Error('Store is not ready');
			}

			const items = ((internalStorage.data as Record<string, unknown>)[field as string] ??
				{}) as Record<string, {deleteAt: number}>;
			const existing = items[key];

			if (!existing) {
				throw new Error(`Item ${key} does not exist in ${String(field)}`);
			}

			const now = clock();
			const timestamps =
				(internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[
					field as string
				] ?? {};

			const updatedItem = {...(value as object), deleteAt: existing.deleteAt};
			items[key] = updatedItem;
			timestamps[key] = now;

			(internalStorage.data as Record<string, unknown>)[field as string] = items;
			(internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[field as string] =
				timestamps;

			asyncState = {...asyncState, data: {...internalStorage.data}};

			// Commit before notifying: a listener that throws cannot keep the write
			// off storage or out of sync. Its error still reaches the caller.
			scheduleStorageSave(options?.immediate);
			markDirty();
			emitToCaller(() =>
				emitter.emit(
					`${String(field)}:updated` as keyof StoreEventsWithSync<S>,
					{key, item: updatedItem} as StoreEventsWithSync<S>[keyof StoreEventsWithSync<S>],
				),
			);
		},

		updateItem<K extends MapKeys<S>>(
			field: K,
			key: string,
			value: DeepPartial<ExtractMapItem<S[K]>>,
			options?: MutationOptions,
		): void {
			assertNotRevoked();
			if (asyncState.status !== 'ready' || !internalStorage) {
				throw new Error('Store is not ready');
			}

			const items = ((internalStorage.data as Record<string, unknown>)[field as string] ??
				{}) as Record<string, {deleteAt: number}>;
			const existing = items[key];

			if (!existing) {
				throw new Error(`Item ${key} does not exist in ${String(field)}`);
			}

			const now = clock();
			const timestamps =
				(internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[
					field as string
				] ?? {};

			const merged = deepMerge(existing, value as Record<string, unknown>);
			// Ensure deleteAt is preserved from existing item
			const updatedItem = {...merged, deleteAt: existing.deleteAt};
			items[key] = updatedItem;
			timestamps[key] = now;

			(internalStorage.data as Record<string, unknown>)[field as string] = items;
			(internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[field as string] =
				timestamps;

			asyncState = {...asyncState, data: {...internalStorage.data}};

			// Commit before notifying: a listener that throws cannot keep the write
			// off storage or out of sync. Its error still reaches the caller.
			scheduleStorageSave(options?.immediate);
			markDirty();
			emitToCaller(() =>
				emitter.emit(
					`${String(field)}:updated` as keyof StoreEventsWithSync<S>,
					{key, item: updatedItem} as StoreEventsWithSync<S>[keyof StoreEventsWithSync<S>],
				),
			);
		},

		patch<K extends WholeFieldKeys<S>>(
			field: K,
			updateFn: (current: DataOf<S>[K]) => DataOf<S>[K],
			options?: MutationOptions,
		): void {
			assertNotRevoked();
			if (asyncState.status !== 'ready' || !internalStorage) {
				throw new Error('Store is not ready');
			}

			const current = (internalStorage.data as Record<string, unknown>)[
				field as string
			] as DataOf<S>[K];
			let newValue = updateFn(current);

			// If same reference, create a new one to ensure change detection
			if (newValue === current) {
				newValue = {...(newValue as object)} as DataOf<S>[K];
			}

			// On a record only the properties whose value actually changed are stamped.
			// Over-stamping is the safe direction (this device simply wins that
			// property); under-stamping would silently drop the edit.
			const changed = changedProperties(current as object, newValue as object);
			writeWholeField(field as string, newValue, changed, clock());

			asyncState = {...asyncState, data: {...internalStorage.data}};

			// Commit before notifying: a listener that throws cannot keep the write
			// off storage or out of sync. Its error still reaches the caller.
			scheduleStorageSave(options?.immediate);
			markDirty();
			emitToCaller(() =>
				emitter.emit(
					`${String(field)}:changed` as keyof StoreEventsWithSync<S>,
					newValue as StoreEventsWithSync<S>[keyof StoreEventsWithSync<S>],
				),
			);
		},

		patchItem<K extends MapKeys<S>>(
			field: K,
			key: string,
			updateFn: (current: ExtractMapItem<S[K]>) => ExtractMapItem<S[K]>,
			options?: MutationOptions,
		): void {
			assertNotRevoked();
			if (asyncState.status !== 'ready' || !internalStorage) {
				throw new Error('Store is not ready');
			}

			const items = ((internalStorage.data as Record<string, unknown>)[field as string] ??
				{}) as Record<string, {deleteAt: number}>;
			const existing = items[key];

			if (!existing) {
				throw new Error(`Item ${key} does not exist in ${String(field)}`);
			}

			const now = clock();
			const timestamps =
				(internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[
					field as string
				] ?? {};

			// Extract deleteAt before calling updateFn, then restore it
			const {deleteAt} = existing;
			// Pass item without deleteAt to updateFn (as ExtractMapItem doesn't include deleteAt)
			const currentWithoutDeleteAt = {...existing};
			delete (currentWithoutDeleteAt as Record<string, unknown>).deleteAt;
			let newValue = updateFn(currentWithoutDeleteAt as ExtractMapItem<S[K]>);

			// If same reference, create a new one to ensure change detection
			if (newValue === currentWithoutDeleteAt) {
				newValue = {...(newValue as object)} as ExtractMapItem<S[K]>;
			}

			// Restore deleteAt
			const updatedItem = {...(newValue as object), deleteAt} as {deleteAt: number};
			items[key] = updatedItem;
			timestamps[key] = now;

			(internalStorage.data as Record<string, unknown>)[field as string] = items;
			(internalStorage.$itemTimestamps as Record<string, Record<string, number>>)[field as string] =
				timestamps;

			asyncState = {...asyncState, data: {...internalStorage.data}};

			// Commit before notifying: a listener that throws cannot keep the write
			// off storage or out of sync. Its error still reaches the caller.
			scheduleStorageSave(options?.immediate);
			markDirty();
			emitToCaller(() =>
				emitter.emit(
					`${String(field)}:updated` as keyof StoreEventsWithSync<S>,
					{key, item: updatedItem} as StoreEventsWithSync<S>[keyof StoreEventsWithSync<S>],
				),
			);
		},

		removeItem<K extends MapKeys<S>>(
			field: K,
			key: string,
			options?: RemovalMutationOptions,
		): void {
			assertNotRevoked();
			if (asyncState.status !== 'ready' || !internalStorage) {
				throw new Error('Store is not ready');
			}

			const items = ((internalStorage.data as Record<string, unknown>)[field as string] ??
				{}) as Record<string, {deleteAt: number}>;
			const existing = items[key];

			if (!existing) {
				if (options?.ignoreMissing) {
					return;
				} else {
					throw new Error(`Item ${key} does not exist in ${String(field)}`);
				}
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

			asyncState = {...asyncState, data: {...internalStorage.data}};

			// Commit before notifying: a listener that throws cannot keep the write
			// off storage or out of sync. Its error still reaches the caller.
			scheduleStorageSave(options?.immediate);
			markDirty();
			emitToCaller(() =>
				emitter.emit(
					`${String(field)}:removed` as keyof StoreEventsWithSync<S>,
					{key, item: existing} as StoreEventsWithSync<S>[keyof StoreEventsWithSync<S>],
				),
			);
		},
	};

	const store: SyncableStore<S> = {
		get() {
			return asyncState as DeepReadonly<AsyncState<DataOf<S>>>;
		},

		get account() {
			return account;
		},

		writer(): StoreWriter<S> | undefined {
			return !stopped && asyncState.status === 'ready' ? writerHandle : undefined;
		},

		ready(): Promise<StoreWriter<S>> {
			if (stopped) {
				return Promise.reject(stoppedError());
			}
			if (asyncState.status === 'ready') {
				return Promise.resolve(writerHandle);
			}
			if (asyncState.status === 'error') {
				return Promise.reject(loadFailedError(asyncState.loadError));
			}
			return new Promise((resolve, reject) => {
				readyWaiters.push({resolve, reject});
			});
		},

		on: emitter.on.bind(emitter),
		off: emitter.off.bind(emitter),

		state$,
		syncStatus$,
		storageStatus$,

		load,

		stop(): void {
			stopped = true;
			settleReadyWaiters({error: stoppedError()});

			unwatchStorage?.();
			unwatchStorage = undefined;

			if (storageDebounceTimer) {
				clearTimeout(storageDebounceTimer);
				storageDebounceTimer = undefined;
			}
			// A write accepted before stop() is still saved: dropping the debounced
			// save would lose it silently (a switch within debounceMs of a write).
			// performStorageSave reports a failure through storageStatus$, never throws.
			if (storageSavePending) {
				void performStorageSave();
			}

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

			// Clear store caches to free memory
			itemStoreCache.clear();
			fieldStoreCache.clear();
		},

		watchItem<K extends MapKeys<S>>(
			field: K,
			key: string,
		): Readable<(ExtractMapItem<S[K]> & {deleteAt: number}) | undefined> {
			type ItemType = (ExtractMapItem<S[K]> & {deleteAt: number}) | undefined;

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
						`${String(field)}:added` as keyof StoreEventsWithSync<S>,
						(e) => {
							const event = e as {key: string; item: unknown};
							if (event.key === key) callback(event.item as ItemType);
						},
					);
					const unsubUpdated = emitter.on(
						`${String(field)}:updated` as keyof StoreEventsWithSync<S>,
						(e) => {
							const event = e as {key: string; item: unknown};
							if (event.key === key) callback(event.item as ItemType);
						},
					);
					const unsubRemoved = emitter.on(
						`${String(field)}:removed` as keyof StoreEventsWithSync<S>,
						(e) => {
							const event = e as {key: string};
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

		watchField<K extends keyof S>(
			field: K,
		): S[K] extends MapField<unknown>
			? Readable<DataOf<S>[K]>
			: Readable<DataOf<S>[K] | undefined> {
			type FieldType = DataOf<S>[K] | undefined;

			const cacheKey = String(field);
			const cached = fieldStoreCache.get(cacheKey);
			if (cached)
				return cached as S[K] extends MapField<unknown>
					? Readable<DataOf<S>[K]>
					: Readable<DataOf<S>[K] | undefined>;

			const fieldDef = schema[field];
			const isMap = fieldDef.__type === 'map';
			// Record fields emit a field-level ':changed' event like value fields, so
			// the non-map branch below is correct for them without further dispatch.

			const getCurrentValue = (): FieldType => {
				if (asyncState.status !== 'ready') {
					// Map fields return empty record when store not ready; value and record fields return undefined
					return (isMap ? {} : undefined) as FieldType;
				}
				return asyncState.data[field];
			};

			const fieldStore: Readable<FieldType> = {
				subscribe(callback: (value: FieldType) => void): () => void {
					callback(getCurrentValue());

					const unsubState = emitter.on('$store:state', () => callback(getCurrentValue()));

					const unsubs: (() => void)[] = [unsubState];

					if (isMap) {
						unsubs.push(
							emitter.on(`${String(field)}:added` as keyof StoreEventsWithSync<S>, () => {
								callback(getCurrentValue());
							}),
						);
						unsubs.push(
							emitter.on(`${String(field)}:updated` as keyof StoreEventsWithSync<S>, () => {
								callback(getCurrentValue());
							}),
						);
						unsubs.push(
							emitter.on(`${String(field)}:removed` as keyof StoreEventsWithSync<S>, () => {
								callback(getCurrentValue());
							}),
						);
					} else {
						unsubs.push(
							emitter.on(`${String(field)}:changed` as keyof StoreEventsWithSync<S>, () => {
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
			return fieldStore as S[K] extends MapField<unknown>
				? Readable<DataOf<S>[K]>
				: Readable<DataOf<S>[K] | undefined>;
		},

		watchItemIds<K extends MapKeys<S>>(field: K): Readable<string[]> {
			const cacheKey = `${String(field)}:ids`;
			const cached = fieldStoreCache.get(cacheKey);
			if (cached) return cached as Readable<string[]>;

			const getCurrentIds = (): string[] => {
				if (asyncState.status !== 'ready') return [];
				const items = (asyncState.data[field] as Record<string, unknown>) ?? {};
				return Object.keys(items);
			};

			const idsStore: Readable<string[]> = {
				subscribe(callback: (ids: string[]) => void): () => void {
					callback(getCurrentIds());

					const unsubState = emitter.on('$store:state', () => callback(getCurrentIds()));

					const unsubAdded = emitter.on(
						`${String(field)}:added` as keyof StoreEventsWithSync<S>,
						() => callback(getCurrentIds()),
					);

					const unsubRemoved = emitter.on(
						`${String(field)}:removed` as keyof StoreEventsWithSync<S>,
						() => callback(getCurrentIds()),
					);

					return () => {
						unsubState();
						unsubAdded();
						unsubRemoved();
					};
				},
			};

			fieldStoreCache.set(cacheKey, idsStore);
			return idsStore;
		},

		async syncNow(): Promise<void> {
			if (!syncAdapter || stopped || asyncState.status !== 'ready') return;

			if (syncDebounceTimer) {
				clearTimeout(syncDebounceTimer);
				syncDebounceTimer = undefined;
			}

			await performSync();
		},

		retryLoad(): void {
			if (stopped) {
				throw stoppedError();
			}
			if (asyncState.status !== 'error') {
				throw new Error('Can only retry when load has failed');
			}

			asyncState = {status: 'idle', account, isLoading: false, loadError: null};
			load();
		},

		persisted,

		async flush(timeoutMs = 30000): Promise<void> {
			const startTime = clock();

			// Clear any pending debounce and force immediate save
			if (storageDebounceTimer) {
				clearTimeout(storageDebounceTimer);
				storageDebounceTimer = undefined;
			}

			// Trigger save if there's pending data
			if (storageSavePending) {
				await performStorageSave();
			}

			// Wait for any in-progress save to complete
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
