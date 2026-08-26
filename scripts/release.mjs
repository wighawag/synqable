#!/usr/bin/env node
/**
 * Release runner.
 *
 * Exists so that `pnpm release --otp 123456` can put the OTP on the publish
 * step. A package.json script string cannot: pnpm appends extra args to the end
 * of the whole command, which would have landed the flag on `git push --tags`.
 */

import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
Usage: pnpm release [--otp <code>] [--dry-run] [--allow-dirty]

  --otp <code>    npm one-time password, forwarded to \`changeset publish\`.
                  Omit it to let changesets prompt you at the publish step.
  --dry-run       Print the steps without running any of them.
  --allow-dirty   Skip the clean-working-tree check.
`;

function fail(message) {
	console.error(`\nrelease: ${message}\n`);
	process.exit(1);
}

function parseArgs(argv) {
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
				fail('--otp requires a code, for example: pnpm release --otp 123456');
			}
		} else if (arg.startsWith('--otp=')) {
			otp = arg.slice('--otp='.length);
			if (!otp) {
				fail('--otp requires a code, for example: pnpm release --otp=123456');
			}
		} else if (arg === '--dry-run') {
			dryRun = true;
		} else if (arg === '--allow-dirty') {
			allowDirty = true;
		} else {
			fail(`unknown argument "${arg}".\n${USAGE}`);
		}
	}

	if (otp !== undefined && !/^\d{6}$/.test(otp)) {
		// Not fatal: some registries issue codes in other shapes.
		console.warn(`release: warning: --otp "${otp}" is not the usual 6 digits, sending it anyway`);
	}

	return {otp, dryRun, allowDirty};
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

function preflight({allowDirty, dryRun}) {
	// Publishing from a dirty tree ships files that are not in the tagged commit.
	const status = capture('git', ['status', '--porcelain']);
	if (status && allowDirty) {
		console.warn('release: warning: publishing from a dirty working tree (--allow-dirty)');
	}
	if (status && !allowDirty) {
		fail(
			'working tree is not clean, so the published files would not match the tag.\n' +
				'Commit or stash first, or pass --allow-dirty if you are sure.\n\n' +
				status,
		);
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

const {otp, dryRun, allowDirty} = parseArgs(process.argv.slice(2));
const startedAt = Date.now();

if (dryRun) {
	console.log('\nrelease: dry run, nothing will be executed\n');
}

preflight({allowDirty, dryRun});

run('verify and build', 'pnpm', ['prepublishOnly'], {dryRun});
run('push commits', 'git', ['push', '--all'], {dryRun});

// OTP codes are typically valid for about 30 seconds, and everything above this
// point (typecheck, build, push) can easily outlive that. Say so rather than
// letting the registry reject a code that looked correct when it was typed.
if (otp && !dryRun) {
	const elapsed = Math.round((Date.now() - startedAt) / 1000);
	if (elapsed > 25) {
		console.warn(
			`\nrelease: warning: ${elapsed}s elapsed since start; the OTP may already have expired.\n` +
				'If publish fails with EOTP, re-run `pnpm release --otp <fresh code>`.\n' +
				'The build and push steps above are idempotent, so re-running is safe.',
		);
	}
}

const changeset = join(root, 'node_modules', '.bin', 'changeset');
run('publish', changeset, ['publish', ...(otp ? ['--otp', otp] : [])], {dryRun});

run('push tags', 'git', ['push', '--tags'], {dryRun});

console.log(dryRun ? '\nrelease: dry run complete\n' : '\nrelease: done\n');
