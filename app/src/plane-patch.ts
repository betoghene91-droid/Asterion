/**
 * Deriving a with_fix counterfactual for the Solana plane.
 *
 * WHY THIS IS NOT IN `patch.ts`
 *
 * `patch.ts` derives a minimal fix for a SOLIDITY lead: it finds a function head
 * and inserts a modifier, or swaps two statements inside a checks-effects
 * ordering. None of those constructs exists in Rust, so extending the switch
 * there would mean a `case 'sol.svm-signer':` arm that shares no logic with its
 * neighbours and drags Rust parsing into a module every Foundry run loads.
 *
 * What IS shared, and is deliberately reused rather than re-implemented:
 *
 *   · the `DerivedPatch` / `PatchEdit` shape (`{ file, rationale, edits[] }`
 *     with a counted literal `find`/`replace`), so `applyEdits` in `evidence.ts`
 *     can apply it and refuse a partial application;
 *   · the refusal contract — a patch that cannot be derived EXACTLY returns
 *     `{ ok: false, reason }` and the run falls back to `without_precondition`
 *     rather than claiming a fix it did not make.
 *
 * WHAT MAKES THE SOLANA PATCH SOUND
 *
 * The fix has to be the real one, not a change that merely breaks the test. For
 * `sol.svm-signer` the defect is an authorization check that reads the account's
 * ADDRESS but never asks whether it SIGNED. The minimal correct fix is therefore
 * "also require `is_signer`", inserted immediately before the state change, and
 * it must be inserted at a point where the program has already resolved the
 * authority account.
 *
 * Because a textual patch can only be as good as its anchor, the derivation
 * REFUSES in three cases, all of which would otherwise produce a confident lie:
 *
 *   · the anchor is not unique in the file (the fix could land in the wrong fn);
 *   · a signer check already exists at the anchor (the "fix" would be a no-op
 *     and the attack would still succeed, which reads as "not causal");
 *   · the anchor is absent (the program does not look like the shape the
 *     playbook describes, so this is not the class).
 */

import type { PatchEdit } from './evidence.js';

export interface DerivedRustPatch {
  file: string;
  rationale: string;
  edits: PatchEdit[];
}

export type RustPatchResult =
  | { ok: true; patch: DerivedRustPatch }
  | { ok: false; reason: string };

/** Literal occurrence count. An empty needle is zero, not "infinite". */
function occurrences(source: string, needle: string): number {
  if (!needle) return 0;
  return source.split(needle).length - 1;
}

/**
 * The first writable state change the program makes.
 *
 * `try_borrow_mut_data` is where a Solana program commits a decision: every
 * check that is going to happen has happened by then, and everything after is
 * the effect. Inserting the signer requirement immediately BEFORE it is the
 * smallest edit that cannot change any other behaviour — which is what "minimal
 * fix" has to mean if the re-run is to be interpretable.
 */
const MUTATION_ANCHORS = [
  'try_borrow_mut_data()?;',
  'try_borrow_mut_data().unwrap();',
  'try_borrow_mut_data()',
];

/**
 * The check the fix adds.
 *
 * `msg!` before the error is not decoration: without it a refused transaction
 * and a wrong-instruction transaction look identical in the run log, and the
 * whole point of the counterfactual is that a reader can tell them apart.
 */
function signerCheck(varName: string): string {
  return [
    '// FIX (derived): the recorded authority must also have SIGNED.',
    '    if !' + varName + '.is_signer {',
    '        msg!("authority did not sign");',
    '        return Err(ProgramError::MissingRequiredSignature);',
    '    }',
    '',
  ].join('\n    ');
}

/**
 * The name of the account the program treats as the authority.
 *
 * Read out of the file rather than assumed: a program may call it `authority`,
 * `owner`, `signer` or `admin`, and hardcoding one would make the derivation fail
 * on correct code for a reason that has nothing to do with the defect.
 */
function authorityVar(source: string): string | null {
  // A binding introduced from the accounts iterator, which is how every native
  // program names its accounts.
  const it = source.match(/let\s+([a-z_][a-z0-9_]*)\s*=\s*next_account_info\s*\(/i);
  if (it?.[1]) return it[1];
  // An Anchor-style struct field. `authority` first because the playbook's proof
  // sentence is phrased in terms of an authority.
  for (const name of ['authority', 'owner', 'signer', 'admin']) {
    if (new RegExp(`\\b${name}\\s*:\\s*(UncheckedAccount|AccountInfo|Signer)`, 'i').test(source)) {
      return name;
    }
  }
  return null;
}

/**
 * Derive a with_fix patch for one Solana playbook, or say why none is derivable.
 *
 * `source` must be the file's current text so the anchor is resolved against the
 * code that produced the lead, exactly as `patch.ts:derivePatch` requires.
 */
export function deriveSolanaPatch(
  playbook: string,
  file: string,
  source: string,
): RustPatchResult {
  if (typeof source !== 'string' || !source) {
    return { ok: false, reason: 'the lead file could not be read' };
  }
  if (!file || file.startsWith('/')) {
    return { ok: false, reason: 'the lead file path is not relative to the target checkout' };
  }
  if (!/\.rs$/i.test(file)) {
    return { ok: false, reason: `${file} is not a Rust source file` };
  }

  if (playbook !== 'sol.svm-signer') {
    // No derivation for the other Solana classes. They have no harness either,
    // so this is a second line of defence rather than the primary one.
    return {
      ok: false,
      reason: `no minimal, mechanically correct Rust fix is derivable for ${playbook}`,
    };
  }

  const varName = authorityVar(source);
  if (!varName) {
    return {
      ok: false,
      reason:
        'no authority account could be identified: the file has neither a next_account_info ' +
        'binding nor an authority/owner/signer field, so the signer requirement has nothing ' +
        'to attach to',
    };
  }

  // A signer check that already exists means the tree is not the vulnerable one,
  // OR an earlier attempt patched and failed to restore. Either way, adding a
  // second check would make the attack fail for the RIGHT reason and look like a
  // fix — which is exactly the false positive this refusal exists to prevent.
  if (new RegExp(`\\.is_signer\\b`).test(source)) {
    return {
      ok: false,
      reason:
        'the source already references `is_signer`, so the signer requirement is not missing ' +
        'here; adding another check would make the attack fail for a reason this patch did not ' +
        'introduce',
    };
  }

  for (const anchor of MUTATION_ANCHORS) {
    const n = occurrences(source, anchor);
    if (n === 0) continue;
    if (n > 1) {
      return {
        ok: false,
        reason:
          `the state-change anchor "${anchor}" appears ${n} times, so the fix could land in the ` +
          'wrong function; a patch that cannot be placed uniquely is not a minimal fix',
      };
    }
    const find = anchor;
    const replace = signerCheck(varName) + anchor;
    return {
      ok: true,
      patch: {
        file,
        rationale:
          `authorization: the recorded ${varName} must have signed, not merely be present. ` +
          'The requirement is inserted immediately before the first state mutation, so every ' +
          'check the program already made still runs and only the missing one is added.',
        edits: [{ find, replace, expect: 1 }],
      },
    };
  }

  return {
    ok: false,
    reason:
      'no writable state change was found (no try_borrow_mut_data), so there is no point at ' +
      'which a signer requirement would guard the effect this playbook claims',
  };
}
