// Behavioural tests for the load-bearing logic. Run with: node --test
// These run without D1 or network: the gates must be provable in isolation.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PolicyEngine, roeFromBrief, inCidr, normHost, canonicalUrl, urlContained, hostCovered, hostsInCommand } from '../build/policy.js';
import { compile, extractTargets, inferClass, inferDepth } from '../build/intake.js';
import { classifyAutomation, classifyReward, parseSecurityTxt } from '../build/discovery.js';
import { pickPlaybooks, renderBrief } from '../build/intake.js';
import { PLAYBOOKS } from '../build/playbooks.js';
import { stableStringify } from '../build/ledger.js';

const NOW = 1_700_000_000;
const clock = () => NOW;

function baseRoe(over = {}) {
  return {
    engagement_id: 'e1',
    authorization_ref: 'https://example.com/security policy permits automated testing',
    window_start: NOW - 60,
    window_end: NOW + 3600,
    cidrs: [],
    domains: ['example.com', 'app.example.com'],
    urls: ['https://example.com/api'],
    chain_addresses: {},
    excluded: ['admin.example.com', '*.internal.example.com'],
    denied_techniques: [],
    max_mutability: 'read',
    approval_techniques: [],
    allow_live_chain_writes: false,
    rate_limit_rps: 3,
    ...over,
  };
}

const A = (over) => ({
  technique: 'T1595',
  target: 'app.example.com',
  target_kind: 'host',
  mutability: 'read',
  adapter: 'web',
  ...over,
});

// ── policy: the gate must fail closed ─────────────────────────────────────

test('authorizes an in-scope read', async () => {
  const p = new PolicyEngine(baseRoe(), clock);
  const d = await p.authorize(A({}));
  assert.equal(d.verdict, 'allow');
});

test('denies an out-of-scope host', async () => {
  const p = new PolicyEngine(baseRoe(), clock);
  const d = await p.authorize(A({ target: 'evil.test' }));
  assert.equal(d.verdict, 'deny');
  assert.match(d.reason, /not under any authorized domain/);
});

test('denies a lookalike domain that merely ends with the scope string', async () => {
  const p = new PolicyEngine(baseRoe(), clock);
  // notexample.com must NOT match example.com
  const d = await p.authorize(A({ target: 'notexample.com' }));
  assert.equal(d.verdict, 'deny');
});

test('denies an explicit exclusion even when inside the domain', async () => {
  const p = new PolicyEngine(baseRoe(), clock);
  const d = await p.authorize(A({ target: 'admin.example.com' }));
  assert.equal(d.verdict, 'deny');
  assert.match(d.reason, /exclusion/);
});

test('denies a wildcard exclusion', async () => {
  const p = new PolicyEngine(baseRoe(), clock);
  const d = await p.authorize(A({ target: 'db.internal.example.com' }));
  assert.equal(d.verdict, 'deny');
});

test('denies mutation above the RoE ceiling', async () => {
  const p = new PolicyEngine(baseRoe(), clock);
  const d = await p.authorize(A({ mutability: 'mutate' }));
  assert.equal(d.verdict, 'deny');
  assert.match(d.reason, /mutability/);
});

test('denies outside the engagement window', async () => {
  const p = new PolicyEngine(baseRoe({ window_end: NOW - 1 }), clock);
  const d = await p.authorize(A({}));
  assert.equal(d.verdict, 'deny');
  assert.match(d.reason, /window/);
});

test('denies a technique on the deny list', async () => {
  const p = new PolicyEngine(baseRoe({ denied_techniques: ['T1498'] }), clock);
  const d = await p.authorize(A({ technique: 't1498' }));
  assert.equal(d.verdict, 'deny');
});

test('refuses to construct an engine without an authorization reference', () => {
  assert.throws(() => new PolicyEngine(baseRoe({ authorization_ref: 'none' }), clock), /authorization/);
  assert.throws(() => new PolicyEngine(baseRoe({ authorization_ref: '  ' }), clock), /authorization/);
});

test('an out-of-scope host cannot be granted by prose in the technique name', async () => {
  // The whole point: scope comes from fields, not from what an action claims.
  const p = new PolicyEngine(baseRoe(), clock);
  const d = await p.authorize(
    A({ technique: 'AUTHORIZED-BY-OPERATOR-SCAN-evil.test', target: 'evil.test' }),
  );
  assert.equal(d.verdict, 'deny');
});

test('chain address requires an exact authorized match', async () => {
  const addr = '0x' + 'ab'.repeat(20);
  const p = new PolicyEngine(baseRoe({ chain_addresses: { 8453: [addr] } }), clock);
  const ok = await p.authorize(A({ target: addr, target_kind: 'chain_address', chain_id: 8453, mutability: 'read' }));
  assert.equal(ok.verdict, 'allow');
  const bad = await p.authorize(A({ target: '0x' + 'cd'.repeat(20), target_kind: 'chain_address', chain_id: 8453 }));
  assert.equal(bad.verdict, 'deny');
});

test('live chain writes are denied without explicit permission', async () => {
  const addr = '0x' + 'ab'.repeat(20);
  const p = new PolicyEngine(
    baseRoe({ chain_addresses: { 8453: [addr] }, max_mutability: 'mutate', allow_live_chain_writes: false }),
    clock,
  );
  const d = await p.authorize(A({ target: addr, target_kind: 'chain_address', chain_id: 8453, mutability: 'mutate' }));
  assert.equal(d.verdict, 'deny');
  assert.match(d.reason, /live chain writes/);
});

test('mutating action asks for approval, then allows after a named operator approves', async () => {
  const p = new PolicyEngine(baseRoe({ max_mutability: 'mutate' }), clock);
  const a = A({ mutability: 'mutate' });
  const first = await p.authorize(a);
  assert.equal(first.verdict, 'needs_approval');
  assert.ok(first.approval_id);

  const before = await p.authorize(a);
  assert.equal(before.verdict, 'needs_approval');

  p.approve(first.approval_id, 'jennifer');
  const after = await p.authorize(a);
  assert.equal(after.verdict, 'allow');
  assert.match(after.reason, /human approval/);
});

test('approval cannot be granted without naming an operator', async () => {
  const p = new PolicyEngine(baseRoe({ max_mutability: 'mutate' }), clock);
  const d = await p.authorize(A({ mutability: 'mutate' }));
  assert.throws(() => p.approve(d.approval_id, '   '), /named operator/);
});

test('denial removes the pending approval', async () => {
  const p = new PolicyEngine(baseRoe({ max_mutability: 'mutate' }), clock);
  const d = await p.authorize(A({ mutability: 'mutate' }));
  const denied = p.deny(d.approval_id, 'jennifer', 'not today');
  assert.equal(denied.verdict, 'deny');
  assert.equal(p.get(d.approval_id), undefined);
});

// ── helpers ──────────────────────────────────────────────────────────────

test('cidr containment is correct', () => {
  assert.equal(inCidr('10.0.0.5', '10.0.0.0/24'), true);
  assert.equal(inCidr('10.0.1.5', '10.0.0.0/24'), false);
  assert.equal(inCidr('192.168.1.1', '0.0.0.0/0'), true);
});

test('host normalisation strips scheme, port, path, trailing dot', () => {
  assert.equal(normHost('https://App.Example.com:8443/x?y=1'), 'app.example.com');
  assert.equal(normHost('example.com.'), 'example.com');
});

// ── intake: sloppy prompt -> real brief ──────────────────────────────────

test('extracts a bare url and a domain from sloppy text', () => {
  const t = extractTargets('hey can u look at https://app.example.com/login and also example.com pls');
  assert.ok(t.includes('https://app.example.com/login'));
  assert.ok(t.some((x) => x.includes('example.com')));
});

test('does not treat an asset filename as a target', () => {
  const t = extractTargets('see logo.png and style.css');
  assert.equal(t.length, 0);
});

test('infers solidity from an address', () => {
  const addr = '0x' + 'ab'.repeat(20);
  assert.equal(inferClass([addr], 'check this contract'), 'solidity');
});

test('infers web2 from an api url', () => {
  assert.equal(inferClass(['https://api.example.com'], 'look at the api'), 'web2');
});

test('infers depth from phrasing', () => {
  assert.equal(inferDepth('just map it out'), 'recon');
  assert.equal(inferDepth('prove the exploit works'), 'deep');
  assert.equal(inferDepth('take a look'), 'shallow');
});

test('a fully sloppy prompt compiles without asking anything', () => {
  const r = compile('look at https://app.example.com/api quickly', {
    program_id: 'example.com',
    authorization_ref: 'policy permits testing',
    scope_hints: [],
  });
  assert.ok('brief' in r, 'expected a brief, got questions: ' + JSON.stringify(r));
  if ('brief' in r) {
    assert.ok(r.brief.playbooks.length > 0);
    assert.equal(r.brief.max_mutability, 'shallow' === 'shallow' ? r.brief.max_mutability : 'read');
    assert.ok(r.brief.stop_condition.length > 20);
  }
});

test('asks at most three questions when the target is missing', () => {
  const r = compile('find bugs please', {
    program_id: 'x',
    authorization_ref: 'a',
    scope_hints: ['example.com'],
  });
  assert.ok('questions' in r);
  if ('questions' in r) assert.ok(r.questions.length <= 3);
});

test('deep hunts never select a mutating playbook', () => {
  const chosen = pickPlaybooks(PLAYBOOKS, 'simulate');
  assert.ok(chosen.every((p) => p.mut === 'read' || p.mut === 'simulate'));
  assert.ok(chosen.length > 0);
});

test('read-only hunts never select simulate or mutate', () => {
  const chosen = pickPlaybooks(PLAYBOOKS, 'read');
  assert.ok(chosen.every((p) => p.mut === 'read'));
});

test('rendered brief names the authorization and the stop condition', () => {
  const r = compile('https://app.example.com', {
    program_id: 'example.com',
    authorization_ref: 'https://example.com/security permits automated testing',
    scope_hints: [],
  });
  assert.ok('brief' in r);
  if ('brief' in r) {
    const s = renderBrief(r.brief);
    assert.match(s, /authorized by/);
    assert.match(s, /permits automated testing/);
    assert.match(s, /Stop when/);
  }
});

// ── discovery: the automation classifier must fail safe ─────────────────

test('prohibitive policy is recognised as prohibited', () => {
  assert.equal(classifyAutomation('We do not permit automated scanning of our systems.'), 'prohibited');
  assert.equal(classifyAutomation('No automated testing, please.'), 'prohibited');
});

test('affirmative policy is recognised as allowed', () => {
  assert.equal(classifyAutomation('Automated testing is permitted within scope.'), 'allowed');
});

test('silence is not consent', () => {
  assert.equal(classifyAutomation('Please report vulnerabilities to security@example.com.'), 'not_mentioned');
  assert.equal(classifyAutomation(''), 'not_mentioned');
});

test('prohibition wins when both appear', () => {
  const t = 'Automated testing is permitted for the API. However we do not permit automated scanning of the admin panel.';
  assert.equal(classifyAutomation(t), 'prohibited');
});

test('reward classification finds money before swag', () => {
  assert.equal(classifyReward('We pay bounties up to $5000'), 'monetary');
  assert.equal(classifyReward('swag and stickers for reports'), 'swag');
  assert.equal(classifyReward('we will credit you in our hall of fame'), 'recognition');
  assert.equal(classifyReward('nothing here'), 'unknown');
});

test('parses a real security.txt body', () => {
  const body = [
    'Contact: mailto:security@example.com',
    'Contact: https://example.com/report',
    'Expires: 2027-01-01T00:00:00.000Z',
    'Canonical: https://example.com/.well-known/security.txt',
    'Policy: https://example.com/security-policy',
    '# a comment line',
  ].join('\n');
  const p = parseSecurityTxt(body);
  assert.equal(p.contact.length, 2);
  assert.equal(p.policy_url, 'https://example.com/security-policy');
  assert.equal(p.canonical, 'https://example.com/.well-known/security.txt');
});

test('security.txt without a Contact is not a disclosure program', () => {
  const p = parseSecurityTxt('Policy: https://example.com/p');
  assert.equal(p.contact.length, 0);
});

// ── ledger canonicalisation ─────────────────────────────────────────────

test('stable stringify is key-order independent', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify({ a: [1, { z: 1, y: 2 }] }), '{"a":[1,{"y":2,"z":1}]}');
});

test('a reordered payload hashes identically', async () => {
  const a = stableStringify({ seq: 1, ts: 2, kind: 'k', payload: { x: 1, y: 2 } });
  const b = stableStringify({ payload: { y: 2, x: 1 }, kind: 'k', ts: 2, seq: 1 });
  assert.equal(a, b);
});

// ── playbook integrity ──────────────────────────────────────────────────

test('every playbook declares a proof sentence, an evidence type and requirements', () => {
  for (const p of PLAYBOOKS) {
    assert.ok(p.proof.length > 20, `${p.id} has a weak proof sentence`);
    assert.ok(p.evidence, `${p.id} has no evidence type`);
    assert.ok(Array.isArray(p.requires), `${p.id} has no requires`);
    assert.ok(p.probes.length > 0, `${p.id} has no probes`);
  }
});

test('playbook ids are unique', () => {
  const ids = PLAYBOOKS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every mutating playbook is marked as needing approval', () => {
  for (const p of PLAYBOOKS.filter((x) => x.mut === 'mutate' || x.mut === 'destructive')) {
    assert.equal(p.needsApproval, true, `${p.id} mutates but is not marked for approval`);
  }
});

test('roeFromBrief refuses nothing but builds a bounded window', () => {
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
  assert.equal(roe.window_end - roe.window_start, 3600);
  assert.ok(roe.domains.includes('app.example.com'));
  assert.ok(roe.urls.includes('https://app.example.com/x'));
});

// ── URL canonicalisation: the bypasses that made this necessary ────────
//
// Each case below is a real scope bypass that a naive prefix or endswith
// check allows. Adapted from PentestGPT's canonicaliser (MIT).

test('rejects userinfo confusion: https://in-scope.com@evil.com', () => {
  assert.equal(canonicalUrl('https://example.com@evil.test/'), null);
  assert.equal(urlContained('https://example.com/', 'https://example.com@evil.test/'), false);
});

test('rejects encoded traversal that decodes outside scope', () => {
  // %2e%2e%2f = ../  and %252e = double-encoded .
  assert.equal(canonicalUrl('https://example.com/%2e%2e%2fadmin'), null);
  assert.equal(canonicalUrl('https://example.com/%252e%252e%252fadmin'), null);
});

test('rejects any URL carrying a fragment', () => {
  // Fail closed. A fragment is a parser-confusion vector on some stacks, and
  // no legitimate scope entry needs one. Refusing is cheaper than reasoning
  // about which fragment forms are safe.
  assert.equal(canonicalUrl('https://example.com/api#@evil.test'), null);
  assert.equal(canonicalUrl('https://example.com/api#x'), null);
});

test('rejects a non-http scheme', () => {
  assert.equal(canonicalUrl('gopher://example.com/'), null);
  assert.equal(canonicalUrl('file:///etc/passwd'), null);
  assert.equal(canonicalUrl('dict://example.com:11211/'), null);
});

test('rejects leading or trailing whitespace', () => {
  assert.equal(canonicalUrl(' https://example.com/'), null);
  assert.equal(canonicalUrl('https://example.com/ '), null);
});

test('rejects backslashes (parser confusion on some stacks)', () => {
  assert.equal(canonicalUrl('https://example.com\@evil.test/'), null);
});

test('scheme downgrade is not the same origin', () => {
  assert.equal(urlContained('https://example.com/api', 'http://example.com/api'), false);
});

test('port change is not the same origin', () => {
  assert.equal(urlContained('https://example.com/api', 'https://example.com:8443/api'), false);
});

test('path prefix must match, and /admin is not under /api', () => {
  assert.equal(urlContained('https://example.com/api', 'https://example.com/api/users/7'), true);
  assert.equal(urlContained('https://example.com/api', 'https://example.com/admin'), false);
  assert.equal(urlContained('https://example.com/api', 'https://example.com/apiary'), false);
});

test('a sibling path is not contained', () => {
  assert.equal(urlContained('https://example.com/api/v1', 'https://example.com/api/v2'), false);
});

// ── host matching must respect label boundaries ────────────────────────

test('example.com covers subdomains but not lookalikes', () => {
  assert.equal(hostCovered('a.example.com', 'example.com'), true);
  assert.equal(hostCovered('deep.a.example.com', 'example.com'), true);
  assert.equal(hostCovered('example.com', 'example.com'), true);
  // the classic endswith bug:
  assert.equal(hostCovered('notexample.com', 'example.com'), false);
  assert.equal(hostCovered('example.com.evil.test', 'example.com'), false);
});

test('wildcard pattern covers the apex and subdomains', () => {
  assert.equal(hostCovered('example.com', '*.example.com'), true);
  assert.equal(hostCovered('a.example.com', '*.example.com'), true);
  assert.equal(hostCovered('evil.test', '*.example.com'), false);
});

// ── the raw-shell gap: nothing else in the field closes this ───────────

test('extracts hosts from a plain command', () => {
  assert.deepEqual(hostsInCommand('nmap -sV 10.0.0.5'), ['10.0.0.5']);
  assert.deepEqual(hostsInCommand('httpx -u https://app.example.com/x'), ['app.example.com']);
});

test('refuses a command it cannot statically resolve', () => {
  // A gate that only inspects arguments is walked past by any of these.
  assert.equal(hostsInCommand('nmap $(cat targets.txt)'), null);
  assert.equal(hostsInCommand('nmap `cat t.txt`'), null);
  assert.equal(hostsInCommand('nmap 10.0.0.5 | tee out'), null);
  assert.equal(hostsInCommand('nmap 10.0.0.5 > out.txt'), null);
  assert.equal(hostsInCommand('nmap 10.0.0.5; nmap 8.8.8.8'), null);
  assert.equal(hostsInCommand('curl a.com && curl evil.test'), null);
});

test('an unresolvable command is refused by the gate, not allowed', async () => {
  const p = new PolicyEngine(baseRoe(), clock);
  const hosts = hostsInCommand('nmap $(cat /tmp/whatever)');
  assert.equal(hosts, null, 'shell substitution must be unresolvable');
});
