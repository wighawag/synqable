# synqable

## 0.1.0

### Minor Changes

- ad9a400: Field types are now defined by merge granularity, and a third type is added.

  **Breaking:** `permanent<T>()` is renamed to `value<T>()`. The exported type names follow: `PermanentField` -> `ValueField`, `PermanentKeys` -> `ValueKeys`, `ExtractPermanent` -> `ExtractValue`, `mergePermanent` -> `mergeValue`.

  **Breaking:** `update()` is no longer available on value fields. A partial update cannot merge independently on a field that resolves as one unit, so the method was claiming a granularity the merge did not provide. Use `set()` or `patch()`, or make the field a `record`.

  **New:** `record<T>()`, a fixed set of named properties each merged independently by timestamp. Two devices editing different properties of the same struct now keep both edits, where a `value` field would discard one.

  | type          | merge granularity | key set              | deletion         |
  | ------------- | ----------------- | -------------------- | ---------------- |
  | `value<T>()`  | the whole value   | single value         | never deleted    |
  | `record<T>()` | per property      | fixed, heterogeneous | never deleted    |
  | `map<T>()`    | per key           | open, homogeneous    | `deleteAt` + TTL |

  Record fields emit the same field-level `:changed` event as value fields, so existing subscribers and `watchField` are unaffected. Converting a field from `value` to `record` needs no migration: the old field-level timestamp is used as the floor for properties that lack their own.

  Choose between `value` and `record` by asking whether the properties carry a joint invariant. `value<{start, end}>()` with `start <= end` must stay a value field: merging the properties independently can converge on a range that existed on no device. Prefer `value` when unsure.

  `record<T>()` rejects arrays and primitives at the schema with an explanatory type error, and rejects exotic objects (`Date`, `Map`, class instances) at merge time with a runtime error. None of them have independently mergeable properties; all belong in a `value` field.

  **Fixed:** `cleanup` rebuilt `$itemTimestamps` for map fields only, which would have wiped record per-property timestamps on every load and every merge.

## 0.0.13

### Patch Changes

- fix types

## 0.0.12

### Patch Changes

- add ignoreMissing option to not throw on removing item already removed

## 0.0.11

### Patch Changes

- 935a57b: use object-hash for tie-brak

## 0.0.10

### Patch Changes

- logging for storage

## 0.0.9

### Patch Changes

- 1813233: patch

## 0.0.8

### Patch Changes

- fix map empty

## 0.0.7

### Patch Changes

- fix

## 0.0.6

### Patch Changes

- fixmap unset

## 0.0.5

### Patch Changes

- new api for multi-account

## 0.0.4

### Patch Changes

- new api

## 0.0.3

### Patch Changes

- new release

## 0.0.2

### Patch Changes

- add readme

## 0.0.1

### Patch Changes

- first release
