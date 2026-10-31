/**
 * Playbook catalog — the antidote to bad prompting.
 *
 * The operator never writes a prompt. They pick a playbook (or type sloppy
 * text that gets compiled into one). Every playbook declares, up front:
 *   - what mutability it needs (so the policy engine can gate it)
 *   - what preconditions must hold (so we do not probe blind)
 *   - what counts as PROVEN (so nothing unproven ever reaches a report)
 *
 * Adding a capability to Asterion means adding a playbook here. Nothing else.
 */

/**
 * What kind of target a brief is about. Each value is a PLANE, not a folder.
 *
 * `mobile` is a real class with real packs (`mob.*` load and are selectable) and
 * NO plane. It is listed so the taxonomy is total and so a brief can carry the
 * class the operator meant; dispatch refuses it BY NAME rather than pretending.
 * See `planes.ts:noPlaneReason`.
 */
export type Cls = 'web2' | 'solidity' | 'infra' | 'solana' | 'mobile';
export type Mut = 'read' | 'simulate' | 'mutate' | 'destructive';
export type EvidenceType =
  | 'http_exchange'
  | 'command_output'
  | 'code_reference'
  | 'tx_trace'
  | 'other';

export interface Probe {
  id: string;
  desc: string;
  method?: string;
  path?: string;
  /** Deterministic check the runner evaluates. No LLM in this path. */
  expect?: string;
}

export interface Playbook {
  id: string;
  name: string;
  cls: Cls;
  family: string;
  mut: Mut;
  /** Preconditions. If any is false the runner skips, it does not guess. */
  requires: string[];
  probes: Probe[];
  /** Sentence the report must be able to fill. If it can't, it is a hypothesis. */
  proof: string;
  evidence: EvidenceType;
  needsApproval?: boolean;
  /** Rough signal the class is present, used by the routing filter. */
  detect?: string[];
}

export const PLAYBOOKS: Playbook[] = [
  // ───────────────────────────── web2 ─────────────────────────────
  {
    id: 'web.idor',
    name: 'Broken object-level authorization (IDOR)',
    cls: 'web2',
    family: 'access-control',
    mut: 'read',
    requires: ['authenticated session A', 'authenticated session B (different tenant)', 'object id from A'],
    probes: [
      { id: 'baseline', desc: 'fetch object as owner A', method: 'GET', expect: '200 + object body' },
      { id: 'cross', desc: 'fetch same id as B', method: 'GET', expect: '200 + A\'s object body' },
      { id: 'neg', desc: 'fetch nonexistent id as A', method: 'GET', expect: '404 (proves ids are not guessed)' },
    ],
    proof: 'Tenant B receives tenant A\'s object body verbatim, and the negative control 404s.',
    evidence: 'http_exchange',
    detect: ['/api/', '/v1/', 'id=', 'account', 'tenant', 'org'],
  },
  {
    id: 'web.authz.function',
    name: 'Missing function-level authorization',
    cls: 'web2',
    family: 'access-control',
    mut: 'read',
    requires: ['low-privilege session', 'at least one privileged endpoint'],
    probes: [
      { id: 'aslow', desc: 'call admin endpoint with low-priv session', method: 'GET', expect: '200 with privileged data' },
      { id: 'asnone', desc: 'call same endpoint with no session', method: 'GET', expect: '401/403' },
    ],
    proof: 'Low-privilege session retrieves data only an admin should see, while anonymous is rejected.',
    evidence: 'http_exchange',
  },
  {
    id: 'web.ssrf',
    name: 'Server-side request forgery',
    cls: 'web2',
    family: 'ssrf',
    mut: 'read',
    requires: ['a parameter that takes a URL or host', 'an interactsh/oob collector'],
    probes: [
      { id: 'oob', desc: 'supply collector URL, watch for callback', expect: 'DNS or HTTP hit on collector' },
      { id: 'meta', desc: 'supply cloud metadata address', expect: 'response body contains credential-ish content' },
    ],
    proof: 'A callback arrives from the server\'s egress IP, proving the server fetched our URL.',
    evidence: 'http_exchange',
  },
  {
    id: 'web.sqli',
    name: 'SQL injection',
    cls: 'web2',
    family: 'injection',
    mut: 'read',
    requires: ['a parameter reflected in a query', 'differential baseline'],
    probes: [
      { id: 'bool', desc: 'compare true/false boolean payloads', expect: 'response differs consistently' },
      { id: 'time', desc: 'time-delay payload', expect: 'reproducible delay >= 3x baseline' },
    ],
    proof: 'A reproducible boolean or time differential that disappears when the payload is neutralised.',
    evidence: 'http_exchange',
  },
  {
    id: 'web.xss.reflected',
    name: 'Reflected XSS',
    cls: 'web2',
    family: 'injection',
    mut: 'read',
    requires: ['parameter reflected unencoded into HTML'],
    probes: [
      { id: 'reflect', desc: 'send a benign marker, confirm it returns unencoded in a script-capable context' },
      { id: 'exec', desc: 'browser-render the marker payload and confirm execution in DOM' },
    ],
    proof: 'A browser executes attacker-controlled script in the target origin (DOM evidence, not just reflection).',
    evidence: 'screenshot' as unknown as EvidenceType,
  },
  {
    id: 'web.cors',
    name: 'CORS misconfiguration with credentials',
    cls: 'web2',
    family: 'misconfig',
    mut: 'read',
    requires: ['an endpoint returning JSON'],
    probes: [
      { id: 'probe', desc: 'send Origin: https://evil.example', expect: 'ACAO reflects origin + ACAC true' },
      { id: 'null', desc: 'send Origin: null', expect: 'ACAO null + ACAC true' },
    ],
    proof: 'Origin is reflected with credentials allowed, so any site can read authenticated responses.',
    evidence: 'http_exchange',
  },
  {
    id: 'web.jwt',
    name: 'JWT handling weakness',
    cls: 'web2',
    family: 'auth',
    mut: 'read',
    requires: ['a JWT in use'],
    probes: [
      { id: 'alg', desc: 'test alg=none / key confusion', expect: 'token accepted' },
      { id: 'weak', desc: 'test whether the HMAC secret is guessable from a small wordlist', expect: 'signature verifies' },
    ],
    proof: 'A forged token is accepted by a protected endpoint and returns that user\'s data.',
    evidence: 'http_exchange',
  },
  {
    id: 'web.race',
    name: 'Race condition in state transition',
    cls: 'web2',
    family: 'logic',
    mut: 'simulate',
    requires: ['an endpoint with a limit or single-use semantic', 'approval'],
    probes: [
      { id: 'single', desc: 'confirm one request behaves correctly' },
      { id: 'burst', desc: 'fire N concurrent identical requests', expect: 'more than one succeeds' },
    ],
    proof: 'N concurrent requests produce N effects where the design permits one.',
    evidence: 'http_exchange',
    needsApproval: true,
  },
  {
    id: 'web.upload',
    name: 'Unrestricted file upload leading to execution',
    cls: 'web2',
    family: 'injection',
    mut: 'mutate',
    requires: ['an upload surface', 'approval', 'a throwaway account'],
    probes: [
      { id: 'ext', desc: 'upload a non-executable marker with a dangerous extension', expect: 'accepted' },
      { id: 'fetch', desc: 'fetch it back and check Content-Type / execution', expect: 'served as active content' },
    ],
    proof: 'An uploaded file is served back as executable content from the app origin.',
    evidence: 'http_exchange',
    needsApproval: true,
  },
  {
    id: 'web.traversal',
    name: 'Path traversal / arbitrary file read',
    cls: 'web2',
    family: 'injection',
    mut: 'read',
    requires: ['a path or filename parameter'],
    probes: [
      { id: 'dotdot', desc: 'request ../../etc/passwd variants', expect: 'root: entry returned' },
      { id: 'enc', desc: 'encoded and double-encoded variants', expect: 'same' },
    ],
    proof: 'A file outside the intended directory is returned, with content proving it is real.',
    evidence: 'http_exchange',
  },
  {
    id: 'web.graphql',
    name: 'GraphQL authorization gap',
    cls: 'web2',
    family: 'access-control',
    mut: 'read',
    requires: ['a GraphQL endpoint', 'introspection or a schema'],
    probes: [
      { id: 'introspect', desc: 'run introspection', expect: 'schema returned' },
      { id: 'field', desc: 'query an object field not rendered in UI as low-priv user', expect: 'sensitive field returned' },
    ],
    proof: 'A field or mutation returns data the UI and role model deny.',
    evidence: 'http_exchange',
  },
  {
    id: 'web.massassign',
    name: 'Mass assignment',
    cls: 'web2',
    family: 'access-control',
    mut: 'mutate',
    requires: ['a create/update endpoint', 'approval'],
    probes: [
      { id: 'add', desc: 'add role/isAdmin/verified to the JSON body', expect: 'accepted and persisted' },
      { id: 'read', desc: 'read back the subject', expect: 'field elevated' },
    ],
    proof: 'A field the client should not control is accepted and changes authorization.',
    evidence: 'http_exchange',
    needsApproval: true,
  },
  {
    id: 'web.reset',
    name: 'Password reset token poisoning',
    cls: 'web2',
    family: 'auth',
    mut: 'read',
    requires: ['a password reset flow'],
    probes: [
      { id: 'host', desc: 'send reset with attacker Host/X-Forwarded-Host', expect: 'link in email points at attacker host' },
    ],
    proof: 'The reset link delivered to the victim contains an attacker-controlled host.',
    evidence: 'http_exchange',
  },
  {
    id: 'web.oauth',
    name: 'OAuth redirect_uri bypass',
    cls: 'web2',
    family: 'auth',
    mut: 'read',
    requires: ['an OAuth client id'],
    probes: [
      { id: 'sub', desc: 'redirect_uri with attacker subdomain/path traversal/suffix', expect: 'code delivered to attacker' },
    ],
    proof: 'An authorization code is delivered to a host the attacker controls.',
    evidence: 'http_exchange',
  },
  {
    id: 'web.takeover',
    name: 'Subdomain takeover',
    cls: 'infra',
    family: 'dns',
    mut: 'read',
    requires: ['a CNAME to an unclaimed third-party service'],
    probes: [
      { id: 'dns', desc: 'resolve CNAME chain' },
      { id: 'claim', desc: 'check whether the target service reports the name as unclaimed', expect: 'unclaimed' },
    ],
    proof: 'The DNS name points at a service that does not recognise it, and that service would serve attacker content.',
    evidence: 'command_output',
  },

  // ─────────────────────────── solidity ───────────────────────────
  {
    id: 'sol.reentrancy',
    name: 'Reentrancy on state-changing external call',
    cls: 'solidity',
    family: 'reentrancy',
    mut: 'simulate',
    requires: ['a fork RPC', 'a function that calls out before updating state', 'foundry'],
    probes: [
      { id: 'grep', desc: 'locate external calls preceding state writes' },
      { id: 'poc', desc: 'fork-reproduce with an attacker contract', expect: 'attacker drains more than deposited' },
    ],
    proof: 'A forged transaction on a fork extracts more value than the attacker supplied.',
    evidence: 'tx_trace',
  },
  {
    id: 'sol.accesscontrol',
    name: 'Missing or wrong access control on privileged function',
    cls: 'solidity',
    family: 'access-control',
    mut: 'simulate',
    requires: ['contract source', 'foundry'],
    probes: [
      { id: 'scan', desc: 'enumerate external functions lacking modifiers' },
      { id: 'poc', desc: 'call from a non-owner EOA on a fork', expect: 'privileged state changes' },
    ],
    proof: 'A non-privileged account changes privileged state on a fork.',
    evidence: 'tx_trace',
  },
  {
    id: 'sol.oracle',
    name: 'Spot-price / oracle manipulation',
    cls: 'solidity',
    family: 'oracle',
    mut: 'simulate',
    requires: ['a price read from a pool reserve', 'foundry fork with liquidity'],
    probes: [
      { id: 'trace', desc: 'find reserve-based pricing paths' },
      { id: 'poc', desc: 'swap to move price within one tx, then exercise the consumer', expect: 'profit' },
    ],
    proof: 'A single-transaction price move produces profit on a fork.',
    evidence: 'tx_trace',
  },
  {
    id: 'sol.rounding',
    name: 'Accounting / rounding / precision loss',
    cls: 'solidity',
    family: 'accounting',
    mut: 'simulate',
    requires: ['share or debt math', 'foundry'],
    probes: [
      { id: 'fuzz', desc: 'invariant: sum of shares * price == sum of assets', expect: 'counterexample' },
      { id: 'poc', desc: 'replay counterexample as a test', expect: 'value leak' },
    ],
    proof: 'A fuzz counterexample reproduces as a deterministic test that leaks value.',
    evidence: 'command_output',
  },
  {
    id: 'sol.inflation',
    name: 'First-depositor / donation share inflation',
    cls: 'solidity',
    family: 'accounting',
    mut: 'simulate',
    requires: ['an ERC4626-like vault', 'foundry'],
    probes: [
      { id: 'poc', desc: 'deposit 1 wei, donate, deposit as victim', expect: 'victim receives 0 shares' },
    ],
    proof: 'A donation before a victim deposit causes measurable loss to the victim on a fork.',
    evidence: 'tx_trace',
  },
  {
    id: 'sol.upgrade',
    name: 'Unsafe upgrade / storage collision',
    cls: 'solidity',
    family: 'upgrade',
    mut: 'read',
    requires: ['a proxy pattern', 'implementation source'],
    probes: [
      { id: 'layout', desc: 'diff storage layout across versions' },
      { id: 'unguarded', desc: 'check initialize/upgradeTo callable by anyone', expect: 'unguarded' },
    ],
    proof: 'An unprivileged caller can replace the implementation or re-initialize state.',
    evidence: 'code_reference',
  },
  {
    id: 'sol.svm-signer',
    name: 'Solana: account accepted without the signer or authority it requires',
    cls: 'solana',
    family: 'signer-authority',
    mut: 'simulate',
    requires: [
      'an instruction that takes an authority, owner or signer account, on a program deployed to a cluster a local validator can clone',
      'the IDL, because Solana has no ABI-less fallback and instruction data must be built explicitly',
      'a funded payer keypair on the cloned validator, plus the state account holding the recorded authority',
    ],
    probes: [
      { id: 'omitsigner', desc: 'invoke the privileged instruction with the authority account present but absent from the signer set, and check whether the program tests is_signer rather than the account address alone', expect: 'instruction succeeds although the required authority never signed' },
      { id: 'swapowner', desc: 'substitute an attacker-controlled authority account for the recorded one and see whether the equality check reads program state or the passed account', expect: 'the attacker account is accepted as authority' },
    ],
    proof: 'On a validator cloned from the target cluster, an attacker keypair that never held the authority successfully drives the privileged instruction and causes a state change only the recorded authority should have been able to cause.',
    evidence: 'tx_trace',
    detect: ['is_signer', 'has_one', 'signer', 'authority', 'owner'],
  },
  {
    id: 'sol.svm-account',
    name: 'Solana: unvalidated account substituted for a program-owned PDA',
    cls: 'solana',
    family: 'account-validation',
    mut: 'simulate',
    requires: [
      'an instruction that derives a PDA from seeds and then uses it without re-deriving or checking program ownership',
      'the IDL and seed layout, so a substitute account can be constructed',
      'a cloned validator on which the attacker can create and fund an account they own',
    ],
    probes: [
      { id: 'substitute', desc: 'pass an attacker-owned account at the PDA position and check whether the program re-derives the address from seeds or simply trusts the passed AccountInfo', expect: 'attacker-owned account is used where a program-owned PDA was assumed' },
      { id: 'ownership', desc: 'inspect whether account.owner is compared against the program id before the account data is trusted', expect: 'no ownership check precedes the read, or it compares the wrong program id' },
    ],
    proof: 'On a cloned validator, an account created and owned by the attacker is accepted at a position the program treats as its own PDA, and the program reads or writes that account as though it were trusted.',
    evidence: 'tx_trace',
    detect: ['find_program_address', 'create_program_address', 'owner', 'seeds', 'pda'],
  },
  {
    id: 'sol.svm-cpi',
    name: 'Solana: arbitrary CPI where the caller chooses the target program',
    cls: 'solana',
    family: 'cpi-confused-deputy',
    mut: 'simulate',
    requires: [
      'an instruction that invokes a caller-supplied program id rather than a constant',
      'the target instruction layout, so a hostile callee can be built',
      'a cloned validator carrying both the vulnerable program and the attacker program',
    ],
    probes: [
      { id: 'hostilecallee', desc: 'pass an attacker-deployed program id where the vulnerable program expects a known DEX or token program and check whether the id is validated against a constant', expect: 'the attacker program is invoked with the vulnerable program authority' },
      { id: 'signers', desc: 'have the hostile callee attempt a privileged action, to determine whether the CPI forwards signer privileges the caller should not have delegated', expect: 'the callee succeeds at an action the vulnerable program permits but the attacker does not' },
    ],
    proof: 'On a cloned validator, a caller-supplied program id is invoked with the vulnerable program own signer or PDA authority, so the attacker program performs a privileged action the attacker could not perform directly.',
    evidence: 'tx_trace',
    detect: ['invoke_signed', 'invoke', 'cpi', 'program_id', 'remaining_accounts'],
  },
  {
    id: 'sol.signature',
    name: 'Signature replay / missing nonce or chainid',
    cls: 'solidity',
    family: 'signature',
    mut: 'simulate',
    requires: ['permit or meta-tx path', 'foundry'],
    probes: [
      { id: 'replay', desc: 'replay a valid signature twice', expect: 'both accepted' },
    ],
    proof: 'The same signature is accepted twice, or on a second chain, with real effect.',
    evidence: 'tx_trace',
  },
  {
    id: 'sol.delegatecall',
    name: 'Arbitrary delegatecall / unchecked target',
    cls: 'solidity',
    family: 'injection',
    mut: 'simulate',
    requires: ['a delegatecall with a controllable target'],
    probes: [
      { id: 'poc', desc: 'point delegatecall at an attacker contract', expect: 'storage overwritten' },
    ],
    proof: 'Attacker-controlled delegatecall overwrites a privileged storage slot.',
    evidence: 'tx_trace',
  },
  {
    id: 'sol.flashloan',
    name: 'Flashloan-amplified invariant break',
    cls: 'solidity',
    family: 'economic',
    mut: 'simulate',
    requires: ['a lending or AMM invariant', 'fork with a lender'],
    probes: [
      { id: 'inv', desc: 'assert protocol invariant under fuzzed sequences' },
      { id: 'poc', desc: 'wrap the break in a flashloan', expect: 'profit with zero capital' },
    ],
    proof: 'Zero-capital sequence on a fork produces profit.',
    evidence: 'tx_trace',
  },
  {
    id: 'sol.dos',
    name: 'Denial of service via unbounded loop or revert-on-push',
    cls: 'solidity',
    family: 'dos',
    mut: 'simulate',
    requires: ['a loop over a user-growable array'],
    probes: [
      { id: 'grow', desc: 'grow the array past the block gas limit', expect: 'call reverts OOG' },
    ],
    proof: 'A function becomes permanently uncallable once a user-controlled array grows.',
    evidence: 'tx_trace',
  },
];

/**
 * Playbook ids that have a REAL PoC executor behind some plane.
 *
 * This used to be `DISPATCHER_CLASSES` — a set of CLASSES, which is a strictly
 * coarser thing than "this playbook can be executed". The difference is not
 * academic: `solana` is a class WITH a plane, and `sol.svm-account` and
 * `sol.svm-cpi` are in that class with no harness. A class-level answer would
 * make them dispatchable and re-create the dead-dispatch bug inside the very
 * plane that was built to fix it.
 *
 * So the source of truth moved to `planes.ts`, which is per-class AND
 * per-playbook, and this function reads that registry instead of keeping a
 * second list that could drift. The invariant
 *
 *     dispatchable ⊆ HARNESSED
 *
 * is still asserted in tests/dispatch-coverage.test.mjs, now computed from the
 * union of every plane's harness set — and each id is additionally required to
 * synthesize an attack AND a control, so membership alone is never the claim.
 *
 * `mobile` is deliberately absent from the registry: three mob.* packs exist and
 * load, but there is no mobile plane, so a mobile brief refuses BY NAME. Listing
 * it would advertise a capability that does not exist.
 */
export const MOBILE_PACKS_WITHOUT_A_PLANE: readonly string[] = ['mob.android', 'mob.apk', 'mob.ios'];

// The dispatch sets are DERIVED in `planes.ts`, because both of the facts they
// depend on — "a plane exists" and "that plane can execute this playbook" — are
// properties of the registry. Keeping a second, hand-written list here is
// exactly how `HARNESSED` and the old `DISPATCHER_CLASSES` drifted apart in B7.
// Import them from './planes.js' rather than re-exporting, so there is one copy.

export function byId(id: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.id === id);
}

export function hasPlaybook(id: string): boolean {
  return byId(id) !== undefined;
}

export function forClass(cls: Cls): Playbook[] {
  return PLAYBOOKS.filter((p) => p.cls === cls);
}

/** Cheap keyword routing: pick candidate playbooks without spending a token. */
export function route(cls: Cls, haystack: string): Playbook[] {
  const h = haystack.toLowerCase();
  const hits = forClass(cls).filter((p) =>
    (p.detect ?? []).some((d) => h.includes(d.toLowerCase())),
  );
  return hits.length ? hits : forClass(cls);
}
