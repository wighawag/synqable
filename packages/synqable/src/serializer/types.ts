/**
 * A Serializer handles conversion between typed data and strings.
 * Can optionally include encryption/decryption logic.
 */
export interface Serializer<T> {
	serialize: (data: T) => string | Promise<string>;
	deserialize: (data: string) => T | Promise<T | undefined>;
}

/**
 * Creates a basic JSON serializer without encryption.
 * Returns sync functions (not Promises) for optimal performance.
 */
export function createJsonSerializer<T>(): Serializer<T> {
	return {
		serialize: (data: T) => JSON.stringify(data),
		deserialize: (data: string) => JSON.parse(data) as T,
	};
}

/**
 * Type guard to check if a value is a Promise.
 * Used to avoid unnecessary microtask scheduling with sync functions.
 */
export function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
	return value instanceof Promise;
}

// Usage pattern to avoid microtask overhead:
//   const resultOrPromise = serializer.serialize(data);
//   const result = isPromise(resultOrPromise) ? await resultOrPromise : resultOrPromise;
