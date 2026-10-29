/**
 * Patch derivation — the with-fix counterfactual, derived from real source.
 *
 * A with-fix run is only meaningful if the patch is a real, minimal change that
 * removes the claimed defect. Two rules make that true here:
 *
 * 1. The patch is derived from the ACTUAL text of the target file. Nothing is
 *    invented from the class name alone; the line the scanner flagged has to
 *    contain the shape the patch rewrites.
 * 2. Every edit must match a known, exact number of times. A patch that
 *    half-applies would produce a "with-fix" run that is a different program
 *    than the one the rationale describes, so a mismatch is a refusal.
 *
 * Refusal is a normal outcome, not an error. When no minimal fix can be derived
 * for a class, the caller falls back to the other counterfactual mechanism
 * (remove the precondition and require the test to pass). That is why
 * `PatchResult` is a sum type with a reason instead of a thrown exception: the
 * fallback is part of the contract, not an accident.
 *
 * What a with-fix run still cannot prove is stated in the workflow: it shows
 * the test stops failing when this specific change is made. It does not show
 * that the change is the project's chosen remediation.
 */

export interface PatchEdit {
  /** Literal text to find. Must be unique in the file, exactly `expect` times. */
  find: string;
  /** Literal replacement. */
  replace: string;
  /** Required occurrence count in the ORIGINAL source. Defaults to 1. */
  expect: number;
}

export interface DerivedPatch {
  /** Path relative to the target checkout root. */
  file: string;
  edits: PatchEdit[];
  /** Why this is believed to remove the claimed defect. */
  rationale: string;
}

export type PatchResult =
  | { ok: true; patch: DerivedPatch }
  | { ok: false; reason: string };

/** Literal occurrence count. Zero/empty needle is zero. */
export function occurrences(source: string, needle: string): number {
  if (!needle) return 0;
  return source.split(needle).length - 1;
}

function isComment(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Reentrancy: move the state write above the external value call.
 *
 * This is the checks-effects-interactions fix, and it is exactly what the
 * scanner's own `needsWriteAfter` condition looks for: a `.call{value:...}`
 * with an assignment shortly after it. Swapping those two complete statements
 * is minimal and does not change any other line.
 */
function deriveChecksEffectsSwap(file: string, source: string, line: number): PatchResult {
  const lines = source.split('\n');
  const CALL = /\.call\{value:[^}]*\}\(/;
  const WRITE = /^\s*[A-Za-z_$][\w$.\[\]']*\s*(=|-=|\+=)\s*[^=]/;

  let callIdx = -1;
  const callFrom = Math.max(0, line - 1);
  const callTo = Math.min(lines.length, callFrom + 40);
  for (let i = callFrom; i < callTo; i++) {
    const l = lines[i];
    if (l === undefined || isComment(l)) continue;
    if (CALL.test(l)) {
      callIdx = i;
      break;
    }
  }
  if (callIdx < 0) {
    return { ok: false, reason: 'no external value call found near the lead line' };
  }

  let writeIdx = -1;
  const writeTo = Math.min(lines.length, callIdx + 13);
  for (let i = callIdx + 1; i < writeTo; i++) {
    const l = lines[i];
    if (l === undefined || isComment(l)) continue;
    if (CALL.test(l)) continue;
    if (WRITE.test(l)) {
      writeIdx = i;
      break;
    }
  }
  if (writeIdx < 0) {
    return { ok: false, reason: 'no state write follows the external call within 12 lines' };
  }

  const callLine = lines[callIdx] ?? '';
  const writeLine = lines[writeIdx] ?? '';

  if (callLine.trim() === writeLine.trim()) {
    return { ok: false, reason: 'the call line and the state write are the same line' };
  }
  if (!callLine.trimEnd().endsWith(';') || !writeLine.trimEnd().endsWith(';')) {
    return {
      ok: false,
      reason: 'the call or the state write spans several lines, so a line swap is not minimal',
    };
  }
  if (occurrences(source, callLine) !== 1 || occurrences(source, writeLine) !== 1) {
    return {
      ok: false,
      reason: 'the call line or the state write is not unique in the file, so a swap would be ambiguous',
    };
  }

  return {
    ok: true,
    patch: {
      file,
      rationale:
        'checks-effects-interactions: the state write is moved above the external value call, ' +
        'so a reentrant callback observes the updated state',
      edits: [
        { find: callLine, replace: writeLine, expect: 1 },
        { find: writeLine, replace: callLine, expect: 1 },
      ],
    },
  };
}

/**
 * Missing modifier: add an existing, already-declared modifier to the function.
 *
 * We only do this when the file already mentions the modifier elsewhere — a
 * patch that references an undeclared modifier would not compile, and a compile
 * failure is not causality evidence. It would also be an invented fix rather
 * than a derived one.
 */
function deriveModifierInsert(
  file: string,
  source: string,
  line: number,
  modifier: string,
  rationale: string,
): PatchResult {
  if (!new RegExp(`\\b${modifier}\\b`).test(source)) {
    return {
      ok: false,
      reason: `the source never mentions \`${modifier}\`, so adding it would reference an undeclared modifier`,
    };
  }

  const lines = source.split('\n');
  const headIdx = (() => {
    const from = Math.min(line - 1, lines.length - 1);
    for (let i = from; i >= 0; i--) {
      const l = lines[i];
      if (l === undefined) continue;
      if (/^\s*function\s+[A-Za-z_$][\w$]*\s*\(/.test(l)) return i;
      // A closing brace with no function on it means we already left the body.
      if (/^\s*}\s*$/.test(l)) return -1;
    }
    return -1;
  })();

  if (headIdx < 0) {
    return { ok: false, reason: 'no function declaration found at or above the lead line' };
  }

  const head = lines[headIdx] ?? '';
  if (new RegExp(`\\b${modifier}\\b`).test(head)) {
    return { ok: false, reason: `the flagged function already carries \`${modifier}\`` };
  }
  if (!/\b(external|public)\b/.test(head)) {
    return {
      ok: false,
      reason: 'the function head is split across lines, so a modifier cannot be inserted textually',
    };
  }
  if (occurrences(source, head) !== 1) {
    return { ok: false, reason: 'the function head is not unique in the file' };
  }

  const patched = head.replace(/\b(external|public)\b/, (m) => `${m} ${modifier}`);
  if (patched === head) {
    return { ok: false, reason: 'the visibility keyword could not be rewritten' };
  }

  return {
    ok: true,
    patch: {
      file,
      rationale,
      edits: [{ find: head, replace: patched, expect: 1 }],
    },
  };
}

/**
 * Derive a minimal fix for one lead, or say why none can be derived.
 *
 * `source` must be the file's current text and `line` the 1-based line the
 * scanner flagged, so the patch lands on the code that produced the lead.
 */
export function derivePatch(
  playbook: string,
  file: string,
  source: string,
  line: number,
): PatchResult {
  if (typeof source !== 'string' || !source) {
    return { ok: false, reason: 'the lead file could not be read' };
  }
  if (!file || file.startsWith('/')) {
    return { ok: false, reason: 'the lead file path is not relative to the target checkout' };
  }
  if (!Number.isInteger(line) || line < 1) {
    return { ok: false, reason: 'the lead has no usable line number' };
  }

  switch (playbook) {
    case 'sol.reentrancy':
      return deriveChecksEffectsSwap(file, source, line);

    case 'sol.accesscontrol':
      return deriveModifierInsert(
        file,
        source,
        line,
        'onlyOwner',
        'access control: an existing `onlyOwner` modifier is added to the flagged entrypoint, ' +
          'so the unprivileged caller is rejected before any state changes',
      );

    case 'sol.upgrade':
      return deriveModifierInsert(
        file,
        source,
        line,
        'initializer',
        'initialisation: an existing `initializer` modifier is added to the flagged function, ' +
          'so it can only run once',
      );

    default:
      // oracle / rounding / inflation / dos: the defect is in a calculation or
      // an unbounded structure. A one-line textual patch there would be a guess,
      // so we refuse and let the caller use the precondition-removed run.
      return {
        ok: false,
        reason: `no minimal, mechanically correct fix is derivable for ${playbook}`,
      };
  }
}
