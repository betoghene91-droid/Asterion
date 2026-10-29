// V3 fuzz-seed tests. Run with: node --test
//
// IMPORTANT — what these fixtures are and are not.
//
// Every JSON document below is HAND-WRITTEN to match Echidna's JSON encoder
// field-for-field. None of it is captured output: no Solidity toolchain exists
// in the environment where these tests run (forge, echidna, solc are all
// absent), so no Echidna campaign has been executed against this code.
//
// The schema the fixtures follow is taken from the encoder itself:
//   lib/Echidna/Output/JSON.hs, crytic/echidna @ 7242229787d5b0 (v2.3.3)
//   https://github.com/crytic/echidna/blob/master/lib/Echidna/Output/JSON.hs
//
// What that proves: the transform is correct for the schema as documented. What
// it does NOT prove: that a real campaign produces exactly these bytes. That is
// the CI stage's job, and it is stated as unproven in the report.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCampaign,
  seedsFromCampaign,
  renderArg,
  renderCall,
  synthesizeFromFuzz,
  signatureOf,
  echidnaHarness,
  echidnaConfig,
  propertyFor,
  PROPERTIES,
} from '../build/fuzzseed.js';
import { judge } from '../build/proof.js';

// ── fixtures (synthetic, schema-accurate) ──────────────────────────────

/** A campaign where one property was falsified with a 3-step sequence. */
const SOLVED = {
  success: true,
  error: null,
  seed: 1234,
  coverage: {},
  tests: [
    {
      contract: '',
      name: 'name',
      status: 'solved',
      error: null,
      reason: 'ReturnFalse',
      events: [],
      type: 'property',
      transactions: [
        { contract: '', function: 'deposit', arguments: [], gas: '8000000', gasprice: '0', value: '1000000000000000000' },
        { contract: '', function: 'withdraw', arguments: ['1'], gas: '8000000', gasprice: '0', value: '0' },
        { contract: '', function: 'withdraw', arguments: ['1'], gas: '8000000', gasprice: '0', value: '0' },
      ],
    },
  ],
};

/** Every property held. Nothing to seed. */
const ALL_PASSED = {
  success: true,
  error: null,
  seed: 99,
  coverage: {},
  tests: [
    { contract: '', name: 'name', status: 'passed', error: null, reason: null, events: [], type: 'property', transactions: null },
  ],
};

/** Echidna's execution environment broke. Not evidence about the target. */
const ERRED = {
  success: false,
  error: null,
  seed: 7,
  coverage: {},
  tests: [
    { contract: '', name: 'name', status: 'error', error: 'ErrorOutOfGas', reason: null, events: [], type: 'property', transactions: null },
  ],
};

/** Still shrinking: a falsification was found but not yet minimized. */
const SHRINKING = {
  success: true,
  error: null,
  seed: 5,
  coverage: {},
  tests: [
    {
      contract: '', name: 'name', status: 'shrinking', error: null, reason: 'ReturnFalse', events: [], type: 'property',
      transactions: [{ contract: '', function: 'donate', arguments: ['5'], gas: '8000000', gasprice: '0', value: '0' }],
    },
  ],
};

// ── parsing: bad input is a normal outcome ─────────────────────────────

test('a valid campaign parses', () => {
  const p = parseCampaign(JSON.stringify(SOLVED));
  assert.equal(p.ok, true);
});

test('empty output parses to a rejection, not a throw', () => {
  const p = parseCampaign('');
  assert.equal(p.ok, false);
  assert.match(p.reason, /empty/);
});

test('malformed JSON does not throw', () => {
  const p = parseCampaign('{"tests": [');
  assert.equal(p.ok, false);
  assert.match(p.reason, /not valid JSON/);
});

test('a JSON array is not a campaign', () => {
  const p = parseCampaign('[]');
  assert.equal(p.ok, false);
});

test('a campaign whose tests is not an array is rejected', () => {
  const p = parseCampaign('{"tests": {"a": 1}}');
  assert.equal(p.ok, false);
  assert.match(p.reason, /not an array/);
});

test('non-JSON noise before the object is rejected rather than salvaged', () => {
  const p = parseCampaign('Analyzing contract: /src/Vault.sol\n{"tests": []}');
  assert.equal(p.ok, false);
});

// ── extraction: honest degradation ─────────────────────────────────────

// `withdraw` takes an argument, and echidna's JSON does not type it, so the
// ABI must be supplied for the sequence to be replayable at all. These tests
// pass it explicitly — which is the same thing the CI stage must do.
const ABI = { withdraw: ['uint256'] };

test('a falsified property yields exactly one seed', () => {
  const { seeds } = seedsFromCampaign(SOLVED, { abi: ABI });
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].transactions.length, 3);
  assert.equal(seeds[0].status, 'solved');
  assert.equal(seeds[0].reason, 'ReturnFalse');
});

test('a falsified property without an ABI is refused, not guessed', () => {
  // The sequence calls withdraw(uint256); with no type we cannot know whether
  // "1" is a uint, an int, or the decimal rendering of a bytes1.
  const { seeds, rejected } = seedsFromCampaign(SOLVED);
  assert.equal(seeds.length, 0);
  assert.match(rejected[0].reason, /no ABI type is known/);
});

test('the transaction sequence is preserved in order', () => {
  const { seeds } = seedsFromCampaign(SOLVED, { abi: ABI });
  assert.deepEqual(
    seeds[0].transactions.map((t) => t.function),
    ['deposit', 'withdraw', 'withdraw'],
  );
  // and the arguments survive verbatim
  assert.deepEqual(seeds[0].transactions[1].arguments, ['1']);
});

test('an all-passed campaign yields no seeds and says why', () => {
  const { seeds, rejected } = seedsFromCampaign(ALL_PASSED);
  assert.equal(seeds.length, 0);
  assert.ok(rejected.length >= 1);
  assert.match(rejected[0].reason, /no test was falsified/);
});

test('an error status is NOT a seed, even though echidna exits non-zero', () => {
  // Error means the environment broke (out of gas, dead path). Treating it as
  // a finding would turn an infrastructure problem into a vulnerability claim.
  const { seeds, rejected } = seedsFromCampaign(ERRED);
  assert.equal(seeds.length, 0);
  assert.match(rejected[0].reason, /no test was falsified/);
});

test('a campaign with no tests yields no seeds', () => {
  const { seeds, rejected } = seedsFromCampaign({ success: true, tests: [] });
  assert.equal(seeds.length, 0);
  assert.match(rejected[0].reason, /no tests/);
});

test('a missing tests field yields no seeds', () => {
  const { seeds, rejected } = seedsFromCampaign({});
  assert.equal(seeds.length, 0);
  assert.match(rejected[0].reason, /no tests/);
});

test('a shrinking status is a falsification and does yield a seed', () => {
  const { seeds } = seedsFromCampaign(SHRINKING, { abi: { donate: ['uint256'] } });
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].status, 'shrinking');
});

test('two falsified tests are refused, because echidna names them all "name"', () => {
  const two = {
    ...SOLVED,
    tests: [SOLVED.tests[0], { ...SOLVED.tests[0], status: 'shrinking' }],
  };
  const { seeds, rejected } = seedsFromCampaign(two);
  assert.equal(seeds.length, 0);
  assert.match(rejected[0].reason, /cannot be attributed/);
});

test('a falsified test with no transactions is refused', () => {
  const empty = {
    success: true,
    tests: [{ contract: '', name: 'name', status: 'solved', reason: 'ReturnFalse', transactions: [] }],
  };
  const { seeds, rejected } = seedsFromCampaign(empty);
  assert.equal(seeds.length, 0);
  assert.match(rejected[0].reason, /no transactions/);
});

test('a sequence containing a contract creation is refused whole', () => {
  const withCreate = {
    success: true,
    tests: [{
      contract: '', name: 'name', status: 'solved', reason: 'ReturnFalse',
      transactions: [
        { contract: '', function: '<CREATE>', arguments: null, gas: '1', gasprice: '0', value: '0' },
        { contract: '', function: 'withdraw', arguments: [], gas: '1', gasprice: '0', value: '0' },
      ],
    }],
  };
  const { seeds, rejected } = seedsFromCampaign(withCreate);
  assert.equal(seeds.length, 0);
  assert.match(rejected[0].reason, /non-callable/);
});

test('a one-step-bad sequence is rejected entirely, never partially replayed', () => {
  // A partially replayable sequence is a DIFFERENT sequence.
  const mixed = {
    success: true,
    tests: [{
      contract: '', name: 'name', status: 'solved', reason: 'ReturnFalse',
      transactions: [
        { contract: '', function: 'deposit', arguments: [], gas: '1', gasprice: '0', value: '0' },
        { contract: '', function: 'setFee', arguments: ['0x1234'], gas: '1', gasprice: '0', value: '0' },
      ],
    }],
  };
  const { seeds, rejected } = seedsFromCampaign(mixed);
  assert.equal(seeds.length, 0);
  assert.match(rejected[0].reason, /no ABI type is known/);
});

// ── argument rendering: typed or refused ───────────────────────────────

test('bare decimals render without a hint, because they can only be integers', () => {
  assert.equal(renderArg('42'), '42');
  assert.equal(renderArg(-7), '-7');
});

test('booleans render without a hint', () => {
  assert.equal(renderArg(true), 'true');
  assert.equal(renderArg(false), 'false');
});

test('hex is refused without a type: it could be an address or bytes', () => {
  assert.equal(renderArg('0x10000'), null);
  assert.equal(renderArg('0xdeadbeef'), null);
});

test('an unpadded hex address is left-padded to 20 bytes when typed', () => {
  assert.equal(renderArg('0x10000', 'address'), `address(0x${'10000'.padStart(40, '0')})`);
});

test('typed bytes become a hex literal', () => {
  assert.equal(renderArg('0xdeadbeef', 'bytes'), 'hex"deadbeef"');
  assert.equal(renderArg('0xcafe', 'bytes4'), 'hex"cafe"');
});

test('a typed string is quoted and escaped', () => {
  assert.equal(renderArg('a"b', 'string'), '"a\\"b"');
});

test('a string that arrived as hex is refused, since it is the non-UTF8 fallback', () => {
  assert.equal(renderArg('0xdead', 'string'), null);
});

test('an overflowing address is refused rather than truncated', () => {
  assert.equal(renderArg('0x' + 'ab'.repeat(21), 'address'), null);
});

test('unknown ABI types are refused', () => {
  assert.equal(renderArg('1', 'uint256[2]'), null);
  assert.equal(renderArg('1', 'tuple'), null);
});

test('signatures normalize int to int256 and preserve zero-arg functions', () => {
  assert.equal(signatureOf('withdraw', ['uint']), 'withdraw(uint256)');
  assert.equal(signatureOf('deposit', []), 'deposit()');
  assert.equal(signatureOf('deposit', undefined), 'deposit()');
  assert.equal(signatureOf('transfer', ['address', 'uint256']), 'transfer(address,uint256)');
});

// ── call rendering ─────────────────────────────────────────────────────

test('a zero-argument call needs no ABI', () => {
  const r = renderCall({ function: 'withdraw', arguments: [], value: '0' });
  assert.equal(r.ok, true);
  assert.match(r.solidity, /withdraw\(\)/);
});

test('a typed call encodes its signature', () => {
  const r = renderCall(
    { function: 'withdraw', arguments: ['1'], value: '0' },
    { abi: { withdraw: ['uint256'] } },
  );
  assert.equal(r.ok, true);
  assert.match(r.solidity, /withdraw\(uint256\)/);
});

test('a value-carrying call passes the value through', () => {
  const r = renderCall({ function: 'deposit', arguments: [], value: '1000000000000000000' });
  assert.equal(r.ok, true);
  assert.match(r.solidity, /1000000000000000000/);
});

test('a call with a non-decimal value is refused', () => {
  const r = renderCall({ function: 'deposit', arguments: [], value: '1 ether' });
  assert.equal(r.ok, false);
});

test('raw calldata replays as a hex literal', () => {
  const r = renderCall({ function: '0xdeadbeef', arguments: null, value: '0' });
  assert.equal(r.ok, true);
  assert.match(r.solidity, /hex"deadbeef"/);
});

test('an ABI arity mismatch is refused, not silently padded', () => {
  const r = renderCall(
    { function: 'withdraw', arguments: ['1', '2'], value: '0' },
    { abi: { withdraw: ['uint256'] } },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /declares 1 argument/);
});

// ── seed → PocSpec: the SAME contract as V2 ────────────────────────────

const synthOpts = { contract: 'Vault', forkBlock: 30000000, abi: ABI };

/** A seed extracted with the ABI, ready to synthesise. */
const solvedSeed = () => seedsFromCampaign(SOLVED, { abi: ABI }).seeds[0];

test('a seed produces a PocSpec with the V2 field shape', () => {
  const spec = synthesizeFromFuzz(solvedSeed(), synthOpts);

  assert.ok(spec);
  // exactly the PocSpec fields poc.ts declares
  assert.equal(typeof spec.test_name, 'string');
  assert.equal(typeof spec.control_name, 'string');
  assert.equal(typeof spec.solidity, 'string');
  assert.equal(typeof spec.claim.kind, 'string');
  assert.ok(Array.isArray(spec.requires));
  // and the control convention V2 relies on
  assert.equal(spec.control_name, `${spec.test_name}_control`);
  assert.ok(spec.solidity.includes(`function ${spec.control_name}() public`));
});

test('the generated Solidity replays every step in order', () => {
  const spec = synthesizeFromFuzz(solvedSeed(), synthOpts);
  const s = spec.solidity;

  const deposit = s.indexOf('deposit()');
  const firstWithdraw = s.indexOf('withdraw(uint256)');
  const lastWithdraw = s.lastIndexOf('withdraw(uint256)');
  assert.ok(deposit > -1 && firstWithdraw > -1 && lastWithdraw > -1);
  assert.ok(deposit < firstWithdraw, 'deposit must precede the withdrawals');
  assert.notEqual(firstWithdraw, lastWithdraw, 'both withdrawals must be present');
});

test('the control drops the final step, which is what makes it a counterfactual', () => {
  const spec = synthesizeFromFuzz(solvedSeed(), synthOpts);
  const s = spec.solidity;

  // Split the generated contract at the control function, then count calls in
  // each half: the attack replays all 3 steps, the control replays 2.
  const controlAt = s.indexOf(`function ${spec.control_name}()`);
  assert.ok(controlAt > -1);

  const afterControl = s.indexOf(`function ${spec.nocond_name}()`);
  assert.ok(afterControl > controlAt, 'nocond must follow the control');

  const attackBody = s.slice(0, controlAt);
  const controlBody = s.slice(controlAt, afterControl);

  // `withdraw(uint256)` appears in the signature string of each replay call,
  // plus once more in the control because the sequence ends with withdraw.
  const attackWithdraws = (attackBody.match(/withdraw\(uint256\)/g) ?? []).length;
  const controlWithdraws = (controlBody.match(/withdraw\(uint256\)/g) ?? []).length;

  assert.equal(attackWithdraws, 2, 'attack must replay both withdraw calls');
  assert.equal(controlWithdraws, 1, 'control must replay only the first withdraw');
  assert.equal((attackBody.match(/deposit\(\)/g) ?? []).length, 1);
  assert.equal((controlBody.match(/deposit\(\)/g) ?? []).length, 1);

  // The nocond run must keep the ATTACK's bound while replaying the same
  // reduced sequence: that is what makes it a counterfactual rather than a
  // second copy of the control.
  const nocondBody = s.slice(afterControl);
  assert.equal((nocondBody.match(/withdraw\(uint256\)/g) ?? []).length, 1);
  assert.match(nocondBody, /NOCOND:/);
  assert.doesNotMatch(nocondBody, /FUZZ SEED:/);
});

test('a one-step seed still produces an empty-sequence control', () => {
  const { seeds } = seedsFromCampaign(SHRINKING, { abi: { donate: ['uint256'] } });
  const spec = synthesizeFromFuzz(seeds[0], {
    contract: 'Vault',
    forkBlock: 1,
    abi: { donate: ['uint256'] },
  });
  assert.ok(spec);
  assert.ok(spec.solidity.includes('the empty sequence is the control'));
});

test('synthesise refuses a seed it cannot render (missing ABI), rather than emitting an empty call', () => {
  const { seeds } = seedsFromCampaign(SHRINKING, { abi: { donate: ['uint256'] } });
  assert.equal(synthesizeFromFuzz(seeds[0], { contract: 'Vault', forkBlock: 1 }), null);
});

test('the spec asserts a measured bound, never the vulnerability', () => {
  const spec = synthesizeFromFuzz(solvedSeed(), synthOpts);
  assert.match(spec.solidity, /assertLe\(after_, before_/);
  assert.doesNotMatch(spec.solidity, /assertTrue\(true/);
  // no claim language inside the Solidity
  assert.doesNotMatch(spec.solidity, /vulnerab/i);
});

test('replay caveats are carried onto the spec so a non-reproduction is read correctly', () => {
  const spec = synthesizeFromFuzz(solvedSeed(), synthOpts);
  assert.ok(spec.requires.some((r) => /no sender/i.test(r)));
  assert.ok(spec.solidity.includes('no sender'));
});

test('a malformed contract name yields null rather than a broken import', () => {
  assert.equal(synthesizeFromFuzz(solvedSeed(), { contract: '../evil', forkBlock: 1 }), null);
});

test('the same sequence always produces the same test name', () => {
  const a = synthesizeFromFuzz(solvedSeed(), synthOpts);
  const b = synthesizeFromFuzz(solvedSeed(), synthOpts);
  assert.equal(a.test_name, b.test_name);
});

test('a different sequence produces a different test name', () => {
  const a = synthesizeFromFuzz(solvedSeed(), synthOpts);
  const b = synthesizeFromFuzz(
    seedsFromCampaign(SHRINKING, { abi: { donate: ['uint256'] } }).seeds[0],
    { contract: 'Vault', forkBlock: 30000000, abi: { donate: ['uint256'] } },
  );
  assert.ok(a && b);
  assert.notEqual(a.test_name, b.test_name);
});

// ── the contract that matters: a seed cannot self-declare proven ───────

const run = (exit_code, output) => ({ exit_code, output, failure_reason: null, duration_ms: 1 });

test('a seeded PoC with no counterfactual is only partial, never proven', () => {
  const spec = synthesizeFromFuzz(solvedSeed(), synthOpts);

  // The strongest thing the seed can produce: the replay failed with a real
  // assertion, and it even carries a measured impact.
  const r = judge({
    hypothesis_id: spec.test_name,
    commit: 'deadbeef',
    test_name: spec.test_name,
    reproduced: run(1, '[FAIL. Reason: FUZZ SEED: replayed sequence left the attacker in profit]'),
    impact: {
      kind: 'value_transfer',
      description: spec.claim.description,
      measured: { before: '1000000000000000000', after: '3000000000000000000' },
    },
  });

  assert.equal(r.verdict, 'partial');
  assert.equal(r.claim, null);
  assert.ok(r.reasons.some((x) => /counterfactual/.test(x)));
});

test('an echidna seed cannot be smuggled in as a with_fix replacement', () => {
  // A seed says "the fuzzer found this". That is a reproduction, not causality.
  const spec = synthesizeFromFuzz(solvedSeed(), synthOpts);

  const r = judge({
    hypothesis_id: spec.test_name,
    commit: 'deadbeef',
    test_name: spec.test_name,
    reproduced: run(1, '[FAIL. Reason: FUZZ SEED: replayed sequence left the attacker in profit]'),
    // seed metadata dressed up as a counterfactual run — must not be enough
    with_fix: run(1, '[FAIL. Reason: FUZZ SEED: replayed sequence left the attacker in profit]'),
    impact: {
      kind: 'value_transfer',
      description: spec.claim.description,
      measured: { before: '1', after: '3' },
    },
  });
  assert.equal(r.verdict, 'partial');
  assert.equal(r.claim, null);
});

test('only a real counterfactual upgrade lets a seeded PoC become proven', () => {
  const spec = synthesizeFromFuzz(solvedSeed(), synthOpts);

  const r = judge({
    hypothesis_id: spec.test_name,
    commit: 'deadbeef',
    test_name: spec.test_name,
    reproduced: run(1, '[FAIL. Reason: FUZZ SEED: replayed sequence left the attacker in profit]'),
    without_precondition: run(0, '[PASS] control passed'),
    impact: {
      kind: 'value_transfer',
      description: spec.claim.description,
      measured: { before: '1 ether', after: '3 ether' },
    },
  });
  assert.equal(r.verdict, 'proven');
  // and the claim is the measured description, not anything the seed asserted
  assert.equal(r.claim, spec.claim.description);
});

test('a seed does not influence the verdict field of the spec', () => {
  const spec = synthesizeFromFuzz(solvedSeed(), synthOpts);
  // A PocSpec has no verdict member at all: the type cannot express one.
  assert.equal('verdict' in spec, false);
  assert.equal('proven' in spec, false);
});

// ── harness generation ─────────────────────────────────────────────────

test('only classes with an honest property get a harness', () => {
  for (const pb of ['sol.accesscontrol', 'sol.oracle', 'sol.upgrade', 'sol.dos']) {
    assert.equal(propertyFor(pb), null, `${pb} must not have an invented property`);
  }
  assert.ok(propertyFor('sol.reentrancy'));
});

test('a harness names its property with the echidna_ prefix', () => {
  const h = echidnaHarness('sol.reentrancy', 'Vault');
  assert.ok(h);
  assert.match(h, /function echidna_no_profit\(\)/);
  // a property without the prefix is never evaluated
  assert.ok(/echidna_/.test(h));
});

test('an unharnessed class returns null', () => {
  assert.equal(echidnaHarness('sol.signature', 'Vault'), null);
});

test('a harness rejects an unsafe contract name', () => {
  assert.equal(echidnaHarness('sol.reentrancy', 'Vault; rm -rf /'), null);
});

test('the config sets allContracts, without which the property is never fuzzed', () => {
  const c = echidnaConfig();
  assert.match(c, /allContracts: true/);
  assert.match(c, /prefix: echidna_/);
  assert.match(c, /testMode: property/);
});

test('the config pins senders explicitly, because the JSON drops them', () => {
  const c = echidnaConfig();
  assert.match(c, /sender:/);
  assert.match(c, /balanceAddr:/);
});
