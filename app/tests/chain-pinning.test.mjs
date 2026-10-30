/**
 * B5 + B6 — chain pinning.
 *
 * THE TWO BUGS THIS PINS DOWN
 *
 * B5 (`policy.ts`). `roeFromBrief` filed EVERY bare `0x…` target under
 *     const id = 8453; // Base; overridden per engagement when known
 * and nothing ever overrode it. So an Ethereum-mainnet contract was authorized
 * as a Base address, and every downstream gate that reasons about `chain_id` —
 * scope membership, which RPC `prove.yml` forks, whether `drain.ts` may send —
 * reasoned about a chain nobody chose. The authorization was therefore for a
 * different object than the operator meant.
 *
 * B6 (`prove.yml` + `poc.ts`). The workflow had no `chain_id` input and read one
 * `secrets.FORK_RPC` across four steps, so a Base-Sepolia run whose operator had
 * pointed that one secret at mainnet forked mainnet: a PoC written against a
 * testnet address reverted in setUp, or "proved" a delta against unrelated
 * mainnet state. Nothing in the run could notice.
 *
 * WHAT IS ASSERTED HERE
 *
 *   · a brief with a bare address and no chain_id is REFUSED, and the message
 *     names `chain_id` (this is the gate the assignment specifies);
 *   · the refusal is a REFUSAL, not a narrowing: no RoE is produced at all;
 *   · an unknown chain is refused by name rather than filed;
 *   · a web2/repo brief with no address needs no chain and still works;
 *   · the grant tests are RE-POINTED, not relaxed: missing / unapproved /
 *     expired / malformed grants still yield `allow_live_chain_writes: false`,
 *     and they now have to supply a chain to reach the grant logic at all;
 *   · the generated Solidity carries a real `EXPECTED_CHAIN_ID` guard;
 *   · `prove.yml` declares `chain_id`, resolves each chain to a literally-named
 *     secret, fails by name when one is missing, and asserts `cast chain-id`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  PolicyEngine,
  chainForBrief,
  grantIsUsable,
  roeFromBrief,
} from '../build/policy.js';
import { synthesize, HARNESSED } from '../build/poc.js';
import { CHAINS, DEFAULT_FORK_RPC_ENV, parseChainToken, rpcEnvFor } from '../build/chains.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const NOW = 1_700_000_000;
const clock = () => NOW;
const ADDR = '0x' + 'ab'.repeat(20);
const OTHER = '0x' + 'cd'.repeat(20);

/** A minimal brief shaped like `intake.Brief`, addressed. */
function addrBrief(over = {}) {
  return {
    program_id: 'p1',
    targets: [ADDR],
    max_mutability: 'mutate',
    time_box_minutes: 60,
    authorization_ref: 'programme permits automated testing',
    ...over,
  };
}

function grant(over = {}) {
  return {
    approved: true,
    operator: 'operator@example.test',
    chain_id: 8453,
    max_value_wei: 0n,
    expires_at: NOW + 3600,
    ...over,
  };
}

// ── 1. the headline: a bare address with no chain is refused BY NAME ────────

test('a brief with a bare 0x address and no chain_id is REFUSED, naming chain_id', () => {
  let thrown = null;
  try {
    roeFromBrief(addrBrief(), NOW);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'a chainless address brief must throw, not silently pick a chain');
  assert.match(thrown.message, /^scope refused:/);
  assert.match(thrown.message, /chain_id/, 'the refusal must name chain_id — that is the field to add');
  // The reason must also say WHY, so an operator is not left guessing.
  assert.match(thrown.message, /does not identify its chain/);
  // eslint-disable-next-line no-console
  console.log('B5 refusal message:\n  ' + thrown.message);
});

test('the refusal is a refusal, not a narrowing: no engagement exists to run', () => {
  // If the old code had been "narrowed" instead of refused, the address would
  // silently vanish from the RoE and the run would look scoped but cover nothing.
  for (const targets of [[ADDR], [OTHER, ADDR], [ADDR, 'app.example.com']]) {
    assert.throws(
      () => roeFromBrief(addrBrief({ targets }), NOW),
      /scope refused: .*chain_id/,
      `targets ${JSON.stringify(targets)} must be refused`,
    );
  }
});

test('chainForBrief reports the same refusal without throwing', () => {
  const got = chainForBrief(addrBrief());
  assert.equal(got.ok, false);
  assert.match(got.reason, /chain_id/);
  // Every address in the brief is listed, bounded, so the operator knows which
  // target triggered it.
  assert.ok(got.reason.includes(ADDR));
});

test('several addresses: the refusal stays bounded and still names chain_id', () => {
  const many = Array.from({ length: 6 }, (_, i) => `0x${String(i + 1).repeat(40)}`);
  const got = chainForBrief(addrBrief({ targets: many }));
  assert.equal(got.ok, false);
  assert.match(got.reason, /and 3 more/, 'the message must not dump every address');
});

// ── 2. an explicitly pinned chain is honoured, not guessed ──────────────────

test('an explicit chain_id files the address under THAT chain', () => {
  for (const chain_id of [1, 8453, 84532, 11155111, 31337]) {
    const roe = roeFromBrief(addrBrief({ chain_id }), NOW);
    assert.deepEqual(
      Object.keys(roe.chain_addresses),
      [String(chain_id)],
      `chain_id ${chain_id} must be the only chain filed`,
    );
    assert.deepEqual(roe.chain_addresses[chain_id], [ADDR]);
    // And explicitly NOT under Base, which was the bug.
    if (chain_id !== 8453) {
      assert.equal(roe.chain_addresses[8453], undefined, `chain_id ${chain_id} must not also file 8453`);
    }
  }
});

test('a `chain:<id>` token in the notes is accepted as an explicit pin', () => {
  const roe = roeFromBrief(addrBrief({ notes: 'contract:Vault chain:1 fork_block:19000000' }), NOW);
  assert.deepEqual(Object.keys(roe.chain_addresses), ['1']);
});

test('the field wins over the notes, so a stale note cannot retarget the run', () => {
  const roe = roeFromBrief(addrBrief({ chain_id: 11155111, notes: 'chain:8453' }), NOW);
  assert.deepEqual(Object.keys(roe.chain_addresses), ['11155111']);
});

test('an unknown chain is refused by name rather than filed', () => {
  assert.throws(() => roeFromBrief(addrBrief({ chain_id: 999999 }), NOW), /not a chain this bot can fork/);
  assert.throws(() => roeFromBrief(addrBrief({ chain_id: 0 }), NOW), /not a positive integer/);
  assert.throws(() => roeFromBrief(addrBrief({ chain_id: -1 }), NOW), /not a positive integer/);
  assert.throws(() => roeFromBrief(addrBrief({ chain_id: 1.5 }), NOW), /not a positive integer/);
  // A string is a caller bug, not an invitation to coerce.
  assert.throws(
    () => roeFromBrief(addrBrief({ chain_id: '8453' }), NOW),
    /not a positive integer/,
  );
});

test('a chain-named-but-unlisted id is refused, and the message lists what works', () => {
  let msg = '';
  try {
    roeFromBrief(addrBrief({ chain_id: 137 }), NOW);
  } catch (e) {
    msg = e.message;
  }
  assert.match(msg, /137/);
  // The operator needs the valid ids, not a puzzle. Order is JS's ascending
  // numeric key order, so assert on membership rather than spelling it out.
  for (const id of Object.keys(CHAINS)) {
    assert.ok(msg.includes(id), `the refusal must list the forkable id ${id}`);
  }
});

test('prose cannot mint a chain: a bare number in the notes is not a chain id', () => {
  // `fork_block:19000000` is a block number. Reading it as a chain would fork a
  // chain that does not exist.
  assert.throws(() => roeFromBrief(addrBrief({ notes: 'fork_block:19000000' }), NOW), /chain_id/);
  assert.equal(parseChainToken('fork_block:19000000'), null);
  assert.equal(parseChainToken('crosschain:5'), null);
});

// ── 3. non-address briefs still need no chain ──────────────────────────────

test('a web2 brief needs no chain and still builds a bounded RoE', () => {
  const roe = roeFromBrief(
    {
      program_id: 'ex',
      targets: ['https://app.example.com/x'],
      max_mutability: 'read',
      time_box_minutes: 60,
      authorization_ref: 'policy',
    },
    NOW,
  );
  assert.deepEqual(roe.chain_addresses, {});
  assert.equal(roe.window_end - roe.window_start, 3600);
  assert.ok(roe.domains.includes('app.example.com'));
});

test('a bare-host infra brief needs no chain', () => {
  const roe = roeFromBrief(
    {
      program_id: 'ex',
      targets: ['api.example.com'],
      max_mutability: 'read',
      time_box_minutes: 30,
      authorization_ref: 'policy',
    },
    NOW,
  );
  assert.deepEqual(roe.chain_addresses, {});
  assert.ok(roe.domains.includes('api.example.com'));
});

// ── 4. the grant guard: RE-POINTED, never relaxed ───────────────────────────
//
// These are the most important assertions in the repo. They are not relaxed by
// the chain change: they now have to supply a chain to reach the grant logic at
// all, and every one of them still proves `allow_live_chain_writes: false`.

test('roeFromBrief: no grant => allow_live_chain_writes stays false (regression)', () => {
  assert.equal(roeFromBrief(addrBrief({ chain_id: 8453 }), NOW).allow_live_chain_writes, false);
});

test('roeFromBrief: explicit null grant => false (regression)', () => {
  assert.equal(roeFromBrief(addrBrief({ chain_id: 8453 }), NOW, null).allow_live_chain_writes, false);
});

test('roeFromBrief: an undefined grant => false', () => {
  assert.equal(
    roeFromBrief(addrBrief({ chain_id: 8453 }), NOW, undefined).allow_live_chain_writes,
    false,
  );
});

test('roeFromBrief: with a valid grant => true (the guard still opens)', () => {
  assert.equal(roeFromBrief(addrBrief({ chain_id: 8453 }), NOW, grant()).allow_live_chain_writes, true);
});

test('roeFromBrief: unapproved grant => false', () => {
  assert.equal(
    roeFromBrief(addrBrief({ chain_id: 8453 }), NOW, grant({ approved: false })).allow_live_chain_writes,
    false,
  );
  // And `approved` omitted entirely is absent, not permissive.
  const noFlag = grant();
  delete noFlag.approved;
  assert.equal(roeFromBrief(addrBrief({ chain_id: 8453 }), NOW, noFlag).allow_live_chain_writes, false);
});

test('roeFromBrief: expired grant => false', () => {
  assert.equal(
    roeFromBrief(addrBrief({ chain_id: 8453 }), NOW + 10_000, grant()).allow_live_chain_writes,
    false,
  );
});

test('roeFromBrief: a grant cannot rescue a chainless brief', () => {
  // The chain refusal happens BEFORE the grant is consulted, so a valid live
  // write grant on an un-pinned chain is still refused. Granting permission to
  // write on "some chain" is not permission to write on the one that got picked.
  assert.throws(() => roeFromBrief(addrBrief(), NOW, grant()), /chain_id/);
});

test('grantIsUsable is unchanged by the chain work', () => {
  assert.equal(grantIsUsable(null, NOW), false);
  assert.equal(grantIsUsable(undefined, NOW), false);
  assert.equal(grantIsUsable(grant(), NOW), true);
  assert.equal(grantIsUsable(grant({ operator: '' }), NOW), false);
  assert.equal(grantIsUsable(grant({ chain_id: 1.5 }), NOW), false);
  assert.equal(grantIsUsable(grant({ max_value_wei: 'abc' }), NOW), false);
  assert.equal(grantIsUsable(grant({ max_value_wei: -1n }), NOW), false);
});

test('the engine still denies a live write on a pinned chain without a grant', async () => {
  // End to end through PolicyEngine: the chain is now correct, and the live-write
  // gate still fires independently of it.
  const roe = roeFromBrief(addrBrief({ chain_id: 8453, max_mutability: 'mutate' }), NOW);
  const engine = new PolicyEngine(roe, clock);
  const d = await engine.authorize({
    technique: 'DRAIN',
    target: ADDR,
    target_kind: 'chain_address',
    chain_id: 8453,
    mutability: 'mutate',
    adapter: 'foundry',
    is_fork: false,
  });
  assert.equal(d.verdict, 'deny');
  assert.match(d.reason, /live chain writes/);

  // The same action on a fork is allowed by the live-write axis (a fork is not
  // live), which shows the deny above was the live-write gate and not the chain.
  const forked = await engine.authorize({
    technique: 'DRAIN',
    target: ADDR,
    target_kind: 'chain_address',
    chain_id: 8453,
    mutability: 'mutate',
    adapter: 'foundry',
    is_fork: true,
  });
  assert.notEqual(forked.verdict, 'deny');
});

test('an address authorized on chain 1 is NOT authorized on chain 8453', async () => {
  // The scope bug restated as a behavioural test: before the fix the RoE always
  // said 8453, so an Ethereum address "matched" on Base.
  const roe = roeFromBrief(addrBrief({ chain_id: 1, max_mutability: 'read' }), NOW);
  const engine = new PolicyEngine(roe, clock);
  const onMainnet = await engine.authorize({
    technique: 'T1595',
    target: ADDR,
    target_kind: 'chain_address',
    chain_id: 1,
    mutability: 'read',
    adapter: 'foundry',
  });
  assert.equal(onMainnet.verdict, 'allow');

  const onBase = await engine.authorize({
    technique: 'T1595',
    target: ADDR,
    target_kind: 'chain_address',
    chain_id: 8453,
    mutability: 'read',
    adapter: 'foundry',
  });
  assert.equal(onBase.verdict, 'deny');
  assert.match(onBase.reason, /not in authorized set for chain 8453/);
});

// ── 5. B6 in code: the generated harness carries EXPECTED_CHAIN_ID ──────────

test('every generated harness carries an EXPECTED_CHAIN_ID guard when a chain is pinned', () => {
  const lead = { playbook: 'sol.reentrancy', file: 'Vault.sol', line: 7, snippet: 'x', severity: 'high' };
  const spec = synthesize(lead, { contract: 'Vault', forkBlock: 30000000, chainId: 84532 });
  assert.ok(spec, 'the reentrancy harness must synthesize');

  assert.match(spec.solidity, /uint256 constant EXPECTED_CHAIN_ID = 84532;/);
  // A guard that is never checked is decoration. Both halves must be present.
  assert.match(spec.solidity, /if \(EXPECTED_CHAIN_ID != 0\) \{/);
  assert.match(spec.solidity, /require\(\s*block\.chainid == EXPECTED_CHAIN_ID,/);
  assert.match(spec.solidity, /WRONG CHAIN:/);
  // And it must run BEFORE the PoC can touch the target, or a wrong-chain fork
  // is measured first and judged afterwards.
  const guardAt = spec.solidity.indexOf('block.chainid == EXPECTED_CHAIN_ID');
  const targetAt = spec.solidity.indexOf('target = Vault(vm.envAddress("TARGET"))');
  assert.ok(guardAt > -1 && targetAt > guardAt, 'the guard must precede the target attach');

  // Every harnessed class, not just the one above.
  for (const pb of HARNESSED) {
    const s = synthesize({ ...lead, playbook: pb }, { contract: 'V', forkBlock: 1, chainId: 8453 });
    assert.ok(s, `${pb} must synthesize`);
    assert.match(s.solidity, /EXPECTED_CHAIN_ID = 8453;/, `${pb}: chain guard missing`);
  }
});

test('an unpinned chain makes the guard an explicit no-op, not a guess', () => {
  const lead = { playbook: 'sol.dos', file: 'V.sol', line: 3, snippet: 'x', severity: 'high' };
  const spec = synthesize(lead, { contract: 'V', forkBlock: 1 });
  assert.match(spec.solidity, /EXPECTED_CHAIN_ID = 0;/);
  // 0 means "no chain pinned", and the guard body is skipped rather than
  // comparing against a magic number.
  assert.match(spec.solidity, /if \(EXPECTED_CHAIN_ID != 0\) \{/);
  assert.ok(!/WRONG CHAIN/.test(spec.solidity.split('contract V_PoC')[0]), 'no chain in the doc header');
  assert.match(spec.solidity, /none pinned: the environment decides/);
});

test('the header names the chain when one is pinned (so a reviewer can see it)', () => {
  const lead = { playbook: 'sol.oracle', file: 'V.sol', line: 9, snippet: 'x', severity: 'high' };
  assert.match(
    synthesize(lead, { contract: 'V', forkBlock: 100, chainId: 11155111 }).solidity,
    /at block 100 on chain 11155111/,
  );
});

// ── 6. B6 in the workflow: one chain, one secret, asserted ─────────────────

const PROVE = readFileSync(join(ROOT, '.github', 'workflows', 'prove.yml'), 'utf8');
const DEPLOY = readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');

test('prove.yml declares a chain_id workflow_dispatch input', () => {
  // GitHub answers a dispatch carrying an undeclared input with 422, so the
  // declaration is a hard requirement of the dispatch, not documentation.
  const m = PROVE.match(/\n {6}chain_id:\n((?: {8}.*\n)+)/);
  assert.ok(m, 'prove.yml must declare a top-level chain_id input');
  assert.match(m[1], /description:/);
  assert.match(m[1], /required: false/);
});

test('prove.yml enumerates every forkable chain literally, never indexing secrets', () => {
  // `secrets["X"]` and `secrets[env.X]` do not exist in GitHub Actions. Every
  // chain that can be forked must therefore appear as its own named secret.
  for (const id of Object.keys(CHAINS)) {
    assert.ok(
      PROVE.includes(`secrets.FORK_RPC_${id}`),
      `prove.yml must reference secrets.FORK_RPC_${id} literally for chain ${id}`,
    );
    assert.ok(PROVE.includes(`RPC_${id}:`), `prove.yml must bind FORK_RPC_${id} to a local variable`);
    assert.ok(PROVE.includes(`${id})`), `the case statement must have a literal arm for ${id}`);
  }
  // No dynamic indexing in any real expression. The prose in the step comment
  // mentions `secrets["X"]` to explain why it is impossible, so only the
  // `${{ ... }}` expressions are inspected.
  const expressions = PROVE.match(/\$\{\{[^}]*\}\}/g) ?? [];
  assert.ok(expressions.length > 0, 'the workflow must have expressions to check');
  for (const e of expressions) {
    assert.ok(!/secrets\[/.test(e), `secrets cannot be indexed dynamically: ${e}`);
  }
});

test('the four forking steps read the RESOLVED value, not a fresh secret', () => {
  // The bug was four independent reads of one secret. Now there is one read and
  // four consumers of the same resolved value.
  const forkers = PROVE.match(/FORK_RPC: \$\{\{ env\.FORK_RPC \}\}/g) ?? [];
  assert.equal(forkers.length, 4, `expected 4 steps consuming env.FORK_RPC, found ${forkers.length}`);
  assert.equal(
    (PROVE.match(/FORK_RPC: \$\{\{ secrets\.FORK_RPC \}\}/g) ?? []).length,
    0,
    'no step may read the legacy single secret directly; that is the bug',
  );
  // The one legitimate read of the legacy secret is the explicit fallback arm.
  assert.match(PROVE, /RPC_LEGACY: \$\{\{ secrets\.FORK_RPC \}\}/);
});

test('a missing RPC fails the job BY NAME', () => {
  assert.match(PROVE, /::error::\$SECRET is not set/, 'the error must interpolate the secret name');
  assert.match(PROVE, /Add the Actions secret \$SECRET/, 'the operator must be told what to add');
  // Every case arm assigns the literal, chain-specific secret name, so the
  // failure message can only ever name the secret that is actually missing.
  for (const id of Object.keys(CHAINS)) {
    assert.match(
      PROVE,
      new RegExp(`SECRET=FORK_RPC_${id}\\b`),
      `the case arm for ${id} must set SECRET=FORK_RPC_${id}`,
    );
  }
  assert.match(PROVE, /\$SECRET is not set/, 'the error must interpolate that computed name');
  // No falling back to another chain's RPC.
  assert.match(PROVE, /Refusing to fall back to another chain's RPC/);
});

test('an unknown chain_id is a hard failure in the case statement', () => {
  assert.match(PROVE, /\*\)\n\s+echo "::error::chain_id '\$CHAIN_ID' is not a chain this workflow can fork/);
  assert.match(PROVE, /exit 1/, 'the unknown arm must exit non-zero');
});

test('prove.yml asserts cast chain-id against the pinned chain', () => {
  assert.match(PROVE, /cast chain-id --rpc-url "\$FORK_RPC"/);
  assert.match(PROVE, /WRONG CHAIN: \$RESOLVED_RPC_SECRET reports chain-id \$ACTUAL/);
  // The assertion must run AFTER the chain is resolved and BEFORE any PoC runs,
  // so no test is ever executed on an unverified fork.
  const resolveAt = PROVE.indexOf('resolve FORK_RPC for the pinned chain');
  const assertAt = PROVE.indexOf('assert the fork RPC serves the pinned chain');
  const firstRunAt = PROVE.indexOf('run each PoC attack and capture the exit status');
  assert.ok(resolveAt > -1, 'there must be a resolution step');
  assert.ok(assertAt > resolveAt, 'the assertion must follow resolution');
  assert.ok(firstRunAt > assertAt, 'the assertion must precede every PoC run');
});

test('the chain is carried into plan.mjs so the harness guard has a value', () => {
  assert.match(PROVE, /--chain-id "\$\{PINNED_CHAIN_ID:-\}"/);
  assert.match(PROVE, /PINNED_CHAIN_ID: \$\{\{ env\.RESOLVED_CHAIN_ID \}\}/);
});

test('the legacy single secret is an explicit, labelled fallback only', () => {
  // It is allowed for a repo-only brief with no chain to pin, and the run says
  // so out loud, so a later reader cannot mistake the delta for a reproduction.
  assert.match(PROVE, /no chain_id pinned; using the legacy FORK_RPC secret/);
  assert.match(PROVE, /must not be read as a reproduction/);
  // An unpinned run with no RPC at all is still a hard failure.
  assert.match(PROVE, /no chain_id was pinned and the legacy FORK_RPC secret is not set/);
});

test('deploy.yml no longer swallows the corpus load failure (B4 regression)', () => {
  const digestStep = DEPLOY.slice(DEPLOY.indexOf('load the distilled corpus digest into D1'));
  assert.ok(
    !/continue-on-error:\s*true/.test(digestStep.split('- name:')[0] ?? ''),
    'the digest step must not be continue-on-error',
  );
  assert.match(DEPLOY, /node scripts\/load-corpus\.mjs --apply/);
  assert.match(DEPLOY, /::error::no corpus-digest\.json/);
});

test('chain metadata is consistent between chains.ts and prove.yml', () => {
  // One table, mirrored in a place GitHub can actually read. If they drift, a
  // chain in the registry would have no RPC arm and vice versa.
  for (const [idStr, spec] of Object.entries(CHAINS)) {
    const id = Number(idStr);
    assert.equal(rpcEnvFor(id), `FORK_RPC_${id}`, `rpcEnvFor(${id}) must agree with the workflow`);
    assert.equal(spec.rpc_env, `FORK_RPC_${id}`);
    assert.ok(PROVE.includes(`${spec.rpc_env}`), `${spec.rpc_env} missing from prove.yml`);
  }
  assert.equal(rpcEnvFor(null), DEFAULT_FORK_RPC_ENV);
  assert.equal(rpcEnvFor(undefined), DEFAULT_FORK_RPC_ENV);
});
