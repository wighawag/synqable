import {DeepPartial} from './types.js';

export function deepMerge<T>(target: T, source: DeepPartial<T>): T {
	if (typeof source !== 'object' || source === null) {
		return source as T;
	}

	if (Array.isArray(source)) {
		return source as T;
	}

	if (typeof target !== 'object' || target === null || Array.isArray(target)) {
		return source as T;
	}

	const result = {...target};

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
