#!/usr/bin/env node
/**
 * capture.mjs — run one test command and record its real exit status.
 *
 * This exists because of one shell bug that silently destroyed every real
 * reproduction in this pipeline:
 *
 *     forge test ... | tee run.log
 *     echo $?            # always 0 — that is TEE's status, not forge's
 *
 * Recording 0 for a failing test makes `judge()` read "the test passed on this
 * commit", which it reports as `disproved`. That is worse than a crash: it
 * throws away real findings while still looking authoritative.
 *
 * Usage (this is what prove.yml calls):
 *
 *     node build/capture.mjs --log ../results/x.log --exit ../results/x.exit \
 *       -- forge test --match-test '^x$' -vvv
 *
 * Writes:
 *   --log    combined stdout+stderr of the command (via tee, to a file)
 *   --exit   a single line `EXIT=<n>`
 *
 * Exit status of THIS script is the command's status, so a workflow step can
 * still branch on it without re-deriving anything from a pipeline.
 *
 * Deliberate choices, each with a test:
 *
 * - The pipeline runs under `bash -o pipefail`. Without it the left-hand
 *   failure is masked by tee. Verified against the `sh` control, which prints 0.
 * - A spawn error, timeout or signal yields 124 or 137, never 0. "Did not run"
 *   must never look like "passed".
 * - Paths are single-quoted through one place, so a test name from a plan cannot
 *   inject shell syntax into the command line.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExitFile } from './evidence.js';

/** POSIX single-quote quoting, so a value can never be shell-injected. */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run `command` with its combined output teed to `logPath`, returning the
 * COMMAND's exit status (not tee's).
 */
export function runCapture(command, opts = {}) {
  const { cwd, logPath, env, timeoutMs = 900000 } = opts;
  if (!logPath) throw new Error('runCapture requires a logPath');
  mkdirSync(dirname(logPath), { recursive: true });

  const pipeline = `${command} 2>&1 | tee ${shQuote(logPath)}`;
  const r = spawnSync('bash', ['-o', 'pipefail', '-c', pipeline], {
    cwd,
    env: env ?? process.env,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  });

  // status === null means the process died (timeout / OOM / spawn failure).
  // 124 is the conventional timeout code; anything but 0 must not read as a pass.
  let exit_code;
  if (r.error || r.status === null) exit_code = 124;
  else exit_code = r.status;

  let log = '';
  try {
    log = readFileSync(logPath, 'utf8');
  } catch {
    /* tee may not have created the file if the command never started */
  }
  return { exit_code, log };
}

/**
 * Read one recorded run from a results directory.
 *
 * Returns null when NOTHING was recorded for that test name: the caller must
 * then say "this did not run" rather than invent an exit code. There is no
 * `[PASS]`-in-output fallback on purpose — it let a log with no exit file be
 * read as a pass, which is exactly the laundering the proof contract exists to
 * prevent.
 */
export function readRun(resultsDir, testName) {
  const logPath = `${resultsDir}/${testName}.log`;
  const exitPath = `${resultsDir}/${testName}.exit`;
  const hasLog = existsSync(logPath);
  const hasExit = existsSync(exitPath);
  if (!hasLog && !hasExit) return null;

  let output = '';
  if (hasLog) {
    try {
      output = readFileSync(logPath, 'utf8').slice(0, 20000);
    } catch {
      output = '';
    }
  }
  let exit_code = null;
  if (hasExit) {
    try {
      exit_code = parseExitFile(readFileSync(exitPath, 'utf8'));
    } catch {
      exit_code = null;
    }
  }

  return {
    exit_code,
    output,
    failure_reason: exit_code === null ? 'no EXIT= file recorded for this run' : null,
    duration_ms: 0,
  };
}

function main(argv) {  const sep = argv.indexOf('--');
  const own = sep > -1 ? argv.slice(0, sep) : argv;
  const command = sep > -1 ? argv.slice(sep + 1) : [];

  const pick = (name) => {
    const i = own.indexOf(`--${name}`);
    return i > -1 && own[i + 1] ? own[i + 1] : null;
  };
  const logPath = pick('log');
  const exitPath = pick('exit');

  if (!logPath || !exitPath || command.length === 0) {
    console.error(
      'usage: capture.mjs --log <file> --exit <file> -- <command> [args...]',
    );
    return 2;
  }

  // Re-quote every argument: the command arrives already split by the shell, and
  // re-assembling it as a string is the only way to feed it through pipefail.
  const cmd = command.map(shQuote).join(' ');
  const { exit_code } = runCapture(cmd, { cwd: process.cwd(), logPath });

  mkdirSync(dirname(exitPath), { recursive: true });
  writeFileSync(exitPath, `EXIT=${exit_code}\n`);
  console.log(`EXIT=${exit_code}`);
  return exit_code;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    // realpath, not a string compare: a workflow invokes `node build/capture.mjs`
    // with a RELATIVE argv[1], which would never equal the absolute module URL.
    // Getting this wrong makes the CLI silently exit 0 without doing anything.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
