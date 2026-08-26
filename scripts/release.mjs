#!/usr/bin/env node
/**
 * Release runner, split into two halves.
 *
 *   prepare   verify, build, push commits. Slow, idempotent, safe to re-run.
 *   publish   publish to npm, push tags. Irreversible, and the only half that
 *             takes an OTP.
 *
 * The split exists because npm OTP codes last about 30 seconds while typecheck,
 * build and push do not. Running the halves separately lets you generate a code
 * immediately before the step that needs it. It also means a rejected code
 * costs you only the publish step, not the whole chain.
 *
 * The publish flag has to live in a script file rather than a package.json
 * script string: pnpm appends extra args to the end of the whole command, so
 * `--otp` in a chain would land on the last command instead of on publish.
 */

import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MODES = ['prepare', 'publish', 'all'];

const USAGE = `
Usage:
  pnpm release:prepare [--dry-run] [--allow-dirty]
  pnpm release:publish [--otp <code>] [--dry-run] [--allow-dirty]
  pnpm release         [--otp <code>] [--dry-run] [--allow-dirty]
                                        runs prepare then publish

Options:
  --otp <code>    npm one-time password, forwarded to \`changeset publish\`.
                  publish only. Omit it to let changesets prompt you.
  --dry-run       Print the steps without running any of them.
  --allow-dirty   Skip the clean-working-tree check.

Note:
  \`pnpm release --otp <code>\` works, but the code is typed before the build
  and push run and may expire before publish is reached. Prefer running
  \`pnpm release:prepare\` first, then \`pnpm release:publish --otp <fresh code>\`.
`;

function fail(message) {
	console.error(`\nrelease: ${message}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	let mode;
	let otp;
	let dryRun = false;
	let allowDirty = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		if (arg === '--help' || arg === '-h') {
			console.log(USAGE);
			process.exit(0);
		} else if (arg === '--otp') {
			otp = argv[++i];
			if (!otp || otp.startsWith('-')) {
				fail('--otp requires a code, for example: pnpm release:publish --otp 123456');
			}
		} else if (arg.startsWith('--otp=')) {
			otp = arg.slice('--otp='.length);
			if (!otp) {
				fail('--otp requires a code, for example: pnpm release:publish --otp=123456');
			}
		} else if (arg === '--dry-run') {
			dryRun = true;
		} else if (arg === '--allow-dirty') {
			allowDirty = true;
		} else if (!arg.startsWith('-') && mode === undefined) {
			mode = arg;
		} else {
			fail(`unknown argument "${arg}".\n${USAGE}`);
		}
	}

	if (!MODES.includes(mode)) {
		fail(`expected one of ${MODES.join(', ')}, received "${mode ?? 'nothing'}".\n${USAGE}`);
	}

	if (otp !== undefined && mode === 'prepare') {
		fail(
			'--otp applies to the publish step only, not to prepare.\n' +
				'Run `pnpm release:publish --otp <code>`.',
		);
	}

	if (otp !== undefined && !/^\d{6}$/.test(otp)) {
		// Not fatal: some registries issue codes in other shapes.
		console.warn(`release: warning: --otp "${otp}" is not the usual 6 digits, sending it anyway`);
	}

	return {mode, otp, dryRun, allowDirty};
}

function run(label, command, args, {dryRun}) {
	const printable = [command, ...args].join(' ');

	if (dryRun) {
		console.log(`  [dry-run] ${label}: ${printable}`);
		return;
	}

	console.log(`\nrelease: ${label}\n  $ ${printable}`);
	const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', shell: false});

	if (result.error) {
		fail(`${label} could not start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		fail(`${label} failed with exit code ${result.status}. Nothing further was run.`);
	}
}

function capture(command, args) {
	const result = spawnSync(command, args, {cwd: root, encoding: 'utf8'});
	return result.status === 0 ? result.stdout.trim() : '';
}

/**
 * Checks that apply to both halves, since publish can be run on its own.
 */
function preflight({allowDirty, dryRun}) {
	// A dirty tree means the files that get packed are not the files in the tag.
	const status = capture('git', ['status', '--porcelain']);
	if (status && !allowDirty) {
		fail(
			'working tree is not clean, so the published files would not match the tag.\n' +
				'Commit or stash first, or pass --allow-dirty if you are sure.\n\n' +
				status,
		);
	}
	if (status && allowDirty) {
		console.warn('release: warning: running against a dirty working tree (--allow-dirty)');
	}

	// A leftover changeset means `changeset version` has not been run, so the
	// version about to be published is the previous one.
	const changesetDir = join(root, '.changeset');
	if (existsSync(changesetDir)) {
		const pending = readdirSync(changesetDir).filter(
			(file) => file.endsWith('.md') && file.toLowerCase() !== 'readme.md',
		);
		if (pending.length > 0) {
			fail(
				`${pending.length} unreleased changeset(s) found: ${pending.join(', ')}.\n` +
					'Run `pnpm changeset version` and commit the result before releasing.',
			);
		}
	}

	if (dryRun) {
		console.log(
			`release: preflight passed (${status ? 'dirty tree allowed' : 'clean tree'}, no pending changesets)`,
		);
	}
}

const {mode, otp, dryRun, allowDirty} = parseArgs(process.argv.slice(2));

if (dryRun) {
	console.log(`\nrelease: dry run of "${mode}", nothing will be executed\n`);
}

if (mode === 'all') {
	// Delegate to the two halves rather than chaining them in a package.json
	// script string. A string chain would append pnpm's extra args to the LAST
	// command only, so `pnpm release --dry-run` would really run prepare,
	// including its `git push --all`.
	const shared = [...(dryRun ? ['--dry-run'] : []), ...(allowDirty ? ['--allow-dirty'] : [])];

	run('prepare', 'pnpm', ['release:prepare', ...shared], {dryRun: false});
	run('publish', 'pnpm', ['release:publish', ...shared, ...(otp ? ['--otp', otp] : [])], {
		dryRun: false,
	});

	process.exit(0);
}

preflight({allowDirty, dryRun});

if (mode === 'prepare') {
	run('verify and build', 'pnpm', ['prepublishOnly'], {dryRun});
	run('push commits', 'git', ['push', '--all'], {dryRun});

	if (!dryRun) {
		console.log(
			'\nrelease: prepared. Publish with:\n' +
				'  pnpm release:publish --otp <fresh code>\n',
		);
	}
} else {
	const changeset = join(root, 'node_modules', '.bin', 'changeset');
	run('publish', changeset, ['publish', ...(otp ? ['--otp', otp] : [])], {dryRun});
	run('push tags', 'git', ['push', '--tags'], {dryRun});
}

console.log(dryRun ? `\nrelease: dry run of "${mode}" complete\n` : `\nrelease: ${mode} done\n`);
