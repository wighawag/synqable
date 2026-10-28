/**
 * Type tests for typed ready writes. Checked by `pnpm test:typecheck` (tsc over
 * test/**), never run: every `@ts-expect-error` below fails the typecheck if the
 * line under it starts compiling, which is what proves a write without the
 * handle is rejected by the compiler.
 */
import type {
	AsyncState,
	DataOf,
	MultiAccountStore,
	StoreLifecycleState,
	StoreUnavailableError,
	StoreUnavailableReason,
	StoreWriter,
	SyncableStore,
} from '../src/index.js';
import {defineSchema, map, record, value} from '../src/index.js';

const schema = defineSchema({
	name: value<string>(),
	prefs: record<{theme: string; size: number}>(),
	items: map<{n: number}>(),
});
type S = typeof schema;

declare const store: SyncableStore<S>;
declare const multi: MultiAccountStore<S>;

// ---------------------------------------------------------------------------
// R1: no mutator is reachable from the store itself.
// ---------------------------------------------------------------------------

export function noMutatorsOnTheStore() {
	// @ts-expect-error set is on the write handle, not the store
	store.set('name', 'x');
	// @ts-expect-error update is on the write handle, not the store
	store.update('prefs', {theme: 'x'});
	// @ts-expect-error patch is on the write handle, not the store
	store.patch('name', (n: string) => n);
	// @ts-expect-error addItem is on the write handle, not the store
	store.addItem('items', 'k', {n: 1}, {deleteAt: 0});
	// @ts-expect-error setItem is on the write handle, not the store
	store.setItem('items', 'k', {n: 1});
	// @ts-expect-error updateItem is on the write handle, not the store
	store.updateItem('items', 'k', {n: 1});
	// @ts-expect-error patchItem is on the write handle, not the store
	store.patchItem('items', 'k', (i: {n: number}) => i);
	// @ts-expect-error removeItem is on the write handle, not the store
	store.removeItem('items', 'k');
}

export function noMutatorsOnTheSnapshot() {
	const state = store.get();
	if (state.status === 'ready') {
		// @ts-expect-error the ready snapshot carries data, not mutators
		state.set('name', 'x');
		// @ts-expect-error the snapshot is deeply readonly
		state.data.name = 'x';
		// @ts-expect-error nested data too
		state.data.prefs.theme = 'x';
	}
}

export function noMutatorsOnTheMultiAccountStore() {
	// @ts-expect-error not on the multi-account store
	multi.set('name', 'x');
	// @ts-expect-error not on its current store either
	multi.get()?.addItem('items', 'k', {n: 1}, {deleteAt: 0});
}

// ---------------------------------------------------------------------------
// R2: writer() must be narrowed before use.
// ---------------------------------------------------------------------------

export function writerMustBeNarrowed() {
	// @ts-expect-error writer() may be undefined: the store may not be loaded
	store.writer().set('name', 'x');
	// @ts-expect-error same on the multi-account store
	multi.writer().set('name', 'x');

	const writer = store.writer();
	if (writer) {
		writer.set('name', 'x');
		writer.update('prefs', {theme: 'x'});
		writer.addItem('items', 'k', {n: 1}, {deleteAt: 0});
		const n: number | undefined = writer.read().items['k']?.n;
		void n;
		// @ts-expect-error read() is deeply readonly
		writer.read().prefs.theme = 'x';
		// @ts-expect-error update stays unavailable on value fields
		writer.update('name', 'x');
	}
	multi.writer()?.removeItem('items', 'k');
}

// ---------------------------------------------------------------------------
// R3 / R6: ready() resolves to the handle.
// ---------------------------------------------------------------------------

export async function readyResolvesToTheHandle() {
	const writer: StoreWriter<S> = await store.ready();
	writer.patch('name', (n) => n + '!');
	const fromMulti: StoreWriter<S> = await multi.ready();
	fromMulti.setItem('items', 'k', {n: 2});
	const account: `0x${string}` = writer.account;
	void account;
}

export function rejectionsCarryAReason(error: StoreUnavailableError) {
	const reason: StoreUnavailableReason = error.reason;
	switch (reason) {
		case 'load-failed':
		case 'stopped':
		case 'account-switched':
		case 'no-account':
			return;
		default: {
			const exhaustive: never = reason;
			return exhaustive;
		}
	}
}

// ---------------------------------------------------------------------------
// R4: a distinct error state, with the error on it.
// ---------------------------------------------------------------------------

export function errorState(state: AsyncState<DataOf<S>>, lifecycle: StoreLifecycleState) {
	if (state.status === 'error') {
		const error: Error = state.loadError;
		void error;
		// @ts-expect-error no data on the error arm
		void state.data;
	}
	if (state.status === 'idle') {
		const none: null = state.loadError;
		void none;
	}
	if (lifecycle.status === 'error') {
		const error: Error = lifecycle.loadError;
		void error;
	}
	if (lifecycle.status === 'idle') {
		const none: null = lifecycle.loadError;
		void none;
	}
}

// ---------------------------------------------------------------------------
// R7: reads do not change.
// ---------------------------------------------------------------------------

export function readsUnchanged() {
	const state = store.get();
	if (state.status === 'ready') {
		const name: string = state.data.name;
		void name;
	}
	store.watchField('prefs').subscribe((p) => {
		const theme: string | undefined = p?.theme;
		void theme;
	});
	store.watchItem('items', 'k').subscribe((i) => {
		const n: number | undefined = i?.n;
		void n;
	});
	multi.state$.subscribe((s) => {
		const status: 'idle' | 'loading' | 'ready' | 'error' = s.status;
		void status;
	});
}
