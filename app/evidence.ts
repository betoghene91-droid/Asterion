/**
 * Evidence parsing — the boring, pure half of the proof pipeline.
 *
 * Everything here is a pure function with no I/O, so it is compiled by tsc and
 * unit-tested directly. The subprocess side (`runCapture`, which is what fixes
 * the exit-code bug) lives in `capture.mjs` because it needs Node builtins that
 * the Workers-typed tsconfig does not provide.
 *
 * Why this exists at all:
 *
 *   forge test ... | tee run.log
 *   echo $?            # always 0 — that is TEE's status, not forge's
 *
 * Recording exit 0 for a failing test makes `judge()` read "the test passed on
 * this commit", which it reports as `disproved`. That is worse than a crash: it
 * throws away real findings while looking authoritative.
 *
 * The other half is `parseImpact`: the PoC prints
 *
 *     IMPACT_BEFORE=<n>
 *     IMPACT_AFTER=<n>
 *     IMPACT_DESC=<text>
 *
 * as plain lines (see `_impact` in poc.ts). Parsing is deliberately literal: a
 * missing or ambiguous marker yields null, and `judge()` then refuses to call
 * the result `proven`. Nothing here may guess an impact.
 */

export interface ParsedImpact {
  description: string;
  measured: { before: string; after: string };
}

export interface PatchEdit {
  /** Literal text to find. Must occur exactly `expect` times. */
  find: string;
  /** Literal replacement. */
  replace: string;
  /** Required occurrence count. Defaults to 1. */
  expect?: number;
}

/** Parse an `EXIT=<n>` file body. Returns null when absent or malformed. */
export function parseExitFile(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null;
  // Uppercase only: `exit=0` must not match, so a stray lowercase echo in a log
  // cannot be mistaken for the recorded status.
  const m = text.match(/EXIT=(\d+)/);
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

const MARKERS = ['IMPACT_BEFORE', 'IMPACT_AFTER', 'IMPACT_DESC'] as const;

function markerValues(output: string, name: string): string[] {
  // forge prefixes console output with trace indentation and keeps it for a
  // failing test under -vvv, so the marker is never required at column 0.
  const out: string[] = [];
  const rx = new RegExp(`^.*\\b${name}=(.*)$`, 'gm');
  for (let m = rx.exec(output); m; m = rx.exec(output)) out.push((m[1] ?? '').trim());
  return out;
}

/**
 * Extract the measured impact from a run's output.
 *
 * Returns null unless all three markers appear exactly once with a non-empty
 * value. Duplicated markers (two attempts' logs concatenated, a re-run
 * appended) are ambiguous, so they are refused rather than averaged.
 */
export function parseImpact(output: string | null | undefined): ParsedImpact | null {
  if (typeof output !== 'string' || !output) return null;

  const found: Record<string, string> = {};
  for (const name of MARKERS) {
    const values = markerValues(output, name);
    if (values.length !== 1) return null;
    found[name] = values[0] ?? '';
  }

  const before = found.IMPACT_BEFORE ?? '';
  const after = found.IMPACT_AFTER ?? '';
  const description = found.IMPACT_DESC ?? '';
  if (!before || !after || !description) return null;

  return { description, measured: { before, after } };
}

/** Literal occurrence count. An empty needle is zero, not "infinite". */
export function occurrences(source: string, needle: string): number {
  if (!needle) return 0;
  return source.split(needle).length - 1;
}

/**
 * Apply literal, counted replacements to a source string.
 *
 * All `find` texts are resolved against the ORIGINAL source and substituted in
 * ONE left-to-right pass. Sequential replacement looks equivalent but is not:
 * an edit that inserts text another edit searches for will match the inserted
 * copy on the second pass and apply twice. A two-line SWAP is exactly that case
 * (each line becomes the other), and the sequential version refused it with
 * "matched 2 time(s), expected 1".
 *
 * The scan is hand-written rather than a RegExp because the find texts are
 * arbitrary source code: escaping them into a pattern is one quoting mistake
 * away from silently matching the wrong thing.
 *
 * Every edit must match EXACTLY `expect` times. A patch that half-applies would
 * produce a "with-fix" run that is a different program than the one the
 * rationale describes, so a count mismatch is a hard refusal — the caller then
 * falls back to the precondition-removed counterfactual instead of claiming a
 * fix it did not make.
 */
export function applyEdits(
  source: string,
  edits: PatchEdit[],
): { ok: true; source: string; applied: { index: number; count: number }[] } | { ok: false; reason: string } {
  if (typeof source !== 'string') return { ok: false, reason: 'source is not a string' };
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, reason: 'no edits supplied' };

  const applied: { index: number; count: number }[] = [];
  const live: { find: string; replace: string }[] = [];

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!e || typeof e.find !== 'string' || !e.find) {
      return { ok: false, reason: `edit ${i} has no find text` };
    }
    if (typeof e.replace !== 'string') {
      return { ok: false, reason: `edit ${i} has no replace text` };
    }
    const expect = Number.isInteger(e.expect) ? (e.expect as number) : 1;
    const count = occurrences(source, e.find);
    if (count !== expect) {
      return {
        ok: false,
        reason: `edit ${i} matched ${count} time(s), expected ${expect}: the patch does not apply to this source`,
      };
    }
    applied.push({ index: i, count });
    live.push({ find: e.find, replace: e.replace });
  }

  // Longest find first: a find that is a prefix of another must not win the match.
  live.sort((a, b) => b.find.length - a.find.length);

  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    let hit: { find: string; replace: string } | null = null;
    for (const e of live) {
      if (source.startsWith(e.find, i)) {
        hit = e;
        break;
      }
    }
    if (hit) {
      out.push(hit.replace);
      i += hit.find.length;
    } else {
      out.push(source[i] as string);
      i += 1;
    }
  }

  return { ok: true, source: out.join(''), applied };
}

/** Reject absolute paths and any path that escapes the target checkout. */
export function safeTargetFile(relPath: string): string | null {
  if (typeof relPath !== 'string' || !relPath) return null;
  if (relPath.startsWith('/') || relPath.startsWith('\\')) return null;
  const parts = relPath.split(/[\\/]+/);
  if (parts.some((p) => p === '..')) return null;
  return relPath;
}
