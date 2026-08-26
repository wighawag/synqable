# ADR: Field types are defined by merge granularity

**Status:** accepted
**Supersedes:** "Key Design Decisions → 3. Two Field Types Only" in `single-account-syncable-store.md`

## Context

The original design shipped two field types, `permanent` and `map`. That choice was recorded in `single-account-syncable-store.md` as a decision but never justified: the entry restates what the two types are and gives no reason for the limit, no rejected alternative, and no constraint it protects. Its neighbours in the same section (single-account binding, explicit load) do give reasons, so the omission was real rather than documented elsewhere. `git log -S` confirms the field-type markers landed in the initial commit and were never revisited.

Three situations exposed the gap.

1. **A homogeneous collection modelled as a single field.** `permanent<Record<string, Op>>()` where `map<Op>()` was meant. Two devices editing different entries lose one. This is a modelling mistake and `map` was always the answer.
2. **A struct whose properties are edited independently.** `permanent<{theme: string; fontSize: number}>()`, device A edits `theme`, device B edits `fontSize`, one edit is lost. `map<T>` is not a workaround because it is homogeneous `Record<string, T>` and modelling a heterogeneous struct through it discards the typing. This was a genuine gap.
3. **Genuinely atomic values.** Whole-value last-writer-wins is correct and nothing needed to change.

Case 2 was not a case schema authors had to go looking for. It was what the README taught: the canonical example of a `permanent` field was a multi-property settings struct, and the merge section claimed "no data loss during concurrent edits", which was false for exactly that example. The mutation API pointed the same way, since `update(field, partial)` deep-merged a partial locally and then stamped the whole field, offering per-property writes on top of per-field conflict resolution.

## Decision

Field types are defined by **merge granularity**: the unit at which a conflict is resolved, and therefore the unit at which a concurrent edit can be lost. There are three, and they sit on one axis.

| type | merge granularity | key set | deletion |
|------|-------------------|---------|----------|
| `value<T>()` | the whole value | single value | never deleted |
| `record<T>()` | per property | fixed, heterogeneous | never deleted |
| `map<T>()` | per key | open, homogeneous | `deleteAt` + TTL |

`permanent` was renamed to `value`. `permanent` named a lifetime property (never deleted) while `map` named a structure, so the two were not comparable, and neither name mentioned the property that decides whether an edit survives. Naming every type after its merge granularity is what makes the choice legible at the point a schema is written.

`update()` is available on record fields only. On a value field a partial update cannot merge independently, so the method was claiming a granularity the merge did not provide. `set()` and `patch()` remain available on both.

### Why `value` and `record` are separate types even though both accept the same `T`

`value<{theme, fontSize}>()` and `record<{theme, fontSize}>()` are structurally identical, so the compiler cannot tell them apart and the schema author is making a choice the type system will not check. That is accepted deliberately, because the axis is not the shape of `T`: it is whether the properties carry a **joint invariant**, which is domain knowledge and cannot be inferred.

The alternative considered was collapsing to one type and inferring granularity from `T`: object means per-property, primitive means whole-value. It was rejected because it makes atomicity inexpressible. Given `value<{start: number; end: number}>()` with `start <= end`, per-property merge lets device A move `start` and device B move `end` and converge on a range that existed on **no** device, potentially violating the invariant. Arrays make the same point structurally: indices are jointly constrained by order and length, so per-index LWW is meaningless.

The two modelling mistakes are not symmetric, which sets the default:

| Mistake | Result | Detectability |
|---|---|---|
| mergeable struct modelled as `value` | an edit is lost | visible, and the surviving state existed on some device |
| atomic struct modelled as `record` | torn write | silent, and the state existed nowhere |

Fabricating a state is worse than discarding one, so `value` is the conservative default and keeps the plainer name.

What is *not* accepted is overlap that is simply nonsense. `record<T>()` rejects arrays and primitives at the schema via a branded error type carrying the reason, and `mergeRecord` rejects exotic objects (`Date`, `Map`, class instances) at runtime, since those satisfy `T extends object` and cannot be excluded structurally. This leaves exactly the overlap that should be a human decision: two identical structs where only the author knows whether the properties move together.

### Why the reasons above, and not "it was feasible"

The runtime machinery looked like it already existed: `$itemTimestamps` is already `Record<field, Record<key, number>>`, and `mergeMap` with an empty tombstone map resembles per-property LWW. Feasibility was explicitly **not** the reason for the change, and it turned out not to be true either (see Consequences). The reason is that the vocabulary made the lossy choice the documented default for structs, and named types on inconsistent axes.

## Boundaries

Deliberate limits, recorded so the next reader does not have to infer them.

- **Record granularity is one level deep.** `record<{a: {b: number}}>` stamps `a` as a unit. Per-path timestamps at arbitrary depth is a full CRDT and a different project.
- **Record fields have a fixed key set and no tombstones.** Entries that come and go belong in a `map`. This is what keeps `record` from collapsing into `map`.
- **Record fields emit one field-level `:changed` event** carrying the whole merged value. Per-property event names (`settings.theme:changed`) were rejected: map fields already established that per-key granularity travels in the **payload**, not the event name (`tasks:updated` with `{key, item}`, never `tasks.task-1:updated`). Following that convention also means every existing subscriber and both `watchField` implementations keep working unchanged.
- **Record fields do not maintain a field-level timestamp.** `mergeRecord` treats a field-level timestamp as the floor for properties that have none, so writing one would make untouched properties look freshly edited and beat another device's genuine edit.

## Consequences

- **`mergeMap` could not be reused.** It branches on `if (!cItem && iItem)`, a truthiness test that is safe only because map items are always objects carrying `deleteAt`. Struct properties are primitives, and `false`, `0` and `''` bypassed timestamps entirely: the newer local value was discarded and, because `localWonCount` was not incremented, never re-pushed. `mergeRecord` tests property presence with `in` and has explicit regression tests for falsy values.
- **`cleanup` needed fixing.** It rebuilds `$itemTimestamps` from scratch and repopulated it for map fields only, which would have wiped record timestamps on every load and every merge. It now carries record timestamps through.
- **`mergeStore` no longer silently drops unknown field types**, since the dispatch gained a record branch; previously an unhandled type would have been omitted from `result.data` entirely.
- **Converting a field from `value` to `record` needs no migration.** `mergeRecord` uses the old field-level timestamp as the floor for properties that lack their own, so data written before the conversion merges correctly without a `$version` bump.
- **Encryption and the sync adapters were untouched.** Both treat `InternalStorage` as an opaque whole (`wrapWithEncryption` serialises and encrypts the entire blob; `SyncAdapter.pull/push` move it wholesale), so neither has any per-field assumption to break.
- **Three concepts instead of two**, permanently. This is the real ongoing cost. It is accepted because the three sit on a single axis and because it removes an API that misrepresented its own semantics.

## Known and not addressed

The `value`/`record` choice is unchecked by the compiler for plain structs, by design (see above). Choosing wrong is a silent correctness bug in both directions, mitigated only by documentation and by `value` being the safe default.


`mergeMap`'s truthiness branch is still present. It is unreachable through the public API, because `addItem` always spreads `deleteAt` into the stored item, so map items are always objects. It was left alone rather than changed without a failing test to justify it.
