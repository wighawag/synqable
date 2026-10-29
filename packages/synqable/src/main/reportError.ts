/**
 * Report an error that has no caller to throw to, without throwing: through
 * `reportError` where the runtime has it (browsers, Deno, Bun: the same path
 * as an uncaught error, so it reaches `window.onerror` and the console), and
 * `console.error` otherwise (Node has no `reportError`). Never swallowed.
 */
export function reportUncaught(description: string, error: unknown): void {
	const report = (globalThis as {reportError?: (error: unknown) => void}).reportError;
	if (typeof report === 'function') {
		report(error);
	} else {
		console.error(`synqable: ${description}`, error);
	}
}
