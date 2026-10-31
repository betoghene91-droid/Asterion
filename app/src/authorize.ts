/**
 * The authorization ingress — the one place an operator can create an anchor.
 *
 * WHY THIS FILE EXISTS
 *
 * `programs.policy_url` was written by exactly ONE place in the whole codebase:
 * `discovery.ts`, when it crawled a host's `security.txt` and found a `Policy:`
 * key. The refusal card told the operator that they could "paste the exact policy
 * sentence that authorizes testing", and no such ingress existed — there were
 * four slash commands and none of them recorded a policy. So the only way to
 * authorize anything was to `/seed` a host, wait up to an hour for the crawler,
 * and hope the host publishes RFC 9116 at the apex. For a repo target that route
 * did not exist at all: every repo collapsed onto one `github.com` program row,
 * so two different repos shared a single verdict.
 *
 * WHAT THIS FILE IS NOT
 *
 * It is NOT a second policy engine and NOT a second classifier. The gate itself
 * is `authorizationFor()` below, which is the SAME logic the Telegram webhook and
 * the Mini App work layer both call — they delegate here rather than each keeping
 * a copy, which is how the two surfaces are guaranteed to agree instead of merely
 * being asserted to. Classification is `discovery.ts:classifyAutomation` /
 * `classifyReward`, the same functions the crawler uses, so an ingress-recorded
 * verdict and a crawl-recorded verdict can never disagree about the same bytes.
 *
 * THE INVARIANT THIS FILE MUST NOT BREAK
 *
 * Authorization is decided from FIELDS, never from prose (see `policy.ts`'s
 * header). Nothing here reads a chat message for permission:
 *
 *   · Free text can never become `policy_url`. `/policy` takes a URL, FETCHES it,
 *     and records what the classifier said about the bytes that came back. The
 *     operator chooses the source; the document supplies the verdict.
 *   · `/policy` additionally refuses a document that is not served by the target
 *     itself (or by a bug-bounty platform that hosts that programme's brief), so
 *     "point at any file that says nothing" is not a way to mint an anchor.
 *   · `/own` is the only path where the operator is the source of authority, and
 *     it is fenced to REPO targets, recorded with identity + timestamp, marked
 *     with a `self:` scheme that no fetched policy can ever have, and it refuses
 *     to touch a row whose policy already says automation is prohibited.
 *   · Nothing here can turn `automation = 'prohibited'` into anything permissive.
 *     A re-fetch may record `prohibited` (that is the truth, and it is strictly
 *     more restrictive); only a document that AFFIRMATIVELY permits automated
 *     testing can lift a prohibition, which is exactly what the shared classifier
 *     requires before it says `allowed`.
 */

import {
  classifyAutomation,
  classifyReward,
  fetchPolicyDocument,
  type CrawlFetcher,
  type PolicyFetch,
} from './discovery.js';
import { chainSpec } from './chains.js';
import { esc } from './telegram.js';

// ─────────────────────────────────────────────────────────────────────────────
// target identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A resolved target reference: what kind of thing it is, and the `programs.id`
 * it belongs to.
 *
 * THE REPO-IDENTITY BUG THIS TYPE EXISTS TO FIX. `ensureSelfProgram()` derives
 * the program id from a HOSTNAME regex over the raw text, so
 * `https://github.com/acme/vault` resolved to the program `github.com` — the same
 * row as `https://github.com/acme/other`. Two unrelated repositories therefore
 * shared one `automation` verdict and one `policy_url`: authorizing the first
 * silently authorized the second. A repo now gets its own id, built from
 * `host:owner/name`, which the schema already anticipates ("slug: host or
 * platform:id") and which a hostname can never collide with — a hostname contains
 * neither ':' nor '/'.
 */
export type TargetRef =
  | {
      kind: 'repo';
      /** `programs.id`, e.g. `github.com:acme/vault`. */
      program: string;
      /** `owner/name`, lowercased. */
      repo: string;
      /** The repo's host, e.g. `github.com`. */
      host: string;
      /** The clone URL recorded as the row's homepage. */
      homepage: string;
    }
  | {
      kind: 'host';
      /** `programs.id`, e.g. `app.example.com`. */
      program: string;
      host: string;
    }
  | {
      /**
       * A bare `0x…` address.
       *
       * WITHOUT a chain it is `unscoped`: an address does not identify its chain,
       * so there is no honest identity to give it and no policy page to attach.
       * WITH a chain it gets `chain:<chain_id>:<0x…lowercased>`, which is the
       * identity that makes the row mean one thing.
       */
      kind: 'address';
      program: string;
      address: string;
      chainId: number | null;
    }
  | { kind: 'none'; program: string };

/**
 * The hosts `planes.ts:splitRepoTarget` already treats as source repositories.
 * Kept in sync with that list on purpose: a reference this module decides is a
 * repo must be the same reference the plane registry will clone.
 */
const REPO_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'] as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const URL_SHAPE = /^https?:\/\//i;

/** `/owner/name`, optional `.git`, optional `@<sha>` / `#<sha>` pin. */
const REPO_PATH = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:[@#][0-9a-f]{7,40})?$/i;

/**
 * A bare `owner/name`.
 *
 * The owner pattern is GitHub's own rule (alphanumerics and hyphens, no dots), and
 * that restriction is what makes this form UNAMBIGUOUS: `app.example.com/api` has a
 * dot in its first segment, so it is never read as a repo, and a genuine hostname
 * never resolves differently because of this arm. `name` may contain dots
 * (`owner/security.txt` is a file, but `owner/vault.js` is a real repo).
 */
const BARE_SLUG = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;

/**
 * The hostname regex `ensureSelfProgram()` has always used.
 *
 * Transcribed EXACTLY, `\b`-anchored and case-insensitive, so that every input the
 * pre-existing code resolved to a host still resolves to the same host here. It
 * runs only AFTER the repo arms, which is the whole fix: it matched `github.com`
 * inside `https://github.com/acme/vault`, and that match was the collapse.
 */
const HOSTNAME = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/i;

function repoProgramId(host: string, repo: string): string {
  return `${host.toLowerCase()}:${repo.toLowerCase()}`;
}

/**
 * The `programs.id` for one contract, on one chain.
 *
 * The chain is part of the identity on purpose. An address alone does not name an
 * engagement, and the previous shared `unscoped` row meant EVERY contract in the
 * system shared one `automation` verdict and one `policy_url` — so authorising one
 * address authorised all of them. Naming the chain in the id is also what makes
 * the same bytes on Base and on Ethereum two distinct rows, which is the property
 * `policy.ts` insists on and the reason it refuses an address brief with no
 * `chain_id`.
 */
export function chainProgramId(chainId: number, address: string): string {
  return `chain:${chainId}:${address.toLowerCase()}`;
}

/** True when a `programs.id` is a chain address (`chain:<id>:0x…`). */
export function isChainProgramId(id: string): boolean {
  return /^chain:\d+:0x[0-9a-f]{40}$/i.test(id);
}

/**
 * Resolve one target reference to its program identity.
 *
 * Order matters and is the fix:
 *   1. an EVM address (identity unchanged: `unscoped`);
 *   2. a URL whose host is a known source-repo host → that repo's own id;
 *   3. a scheme-less `<repo-host>/owner/name` → that repo's own id;
 *   4. a bare `owner/name`, ONLY when the caller says the whole string is the
 *      reference (`allowBareSlug`), so free text can never be misread as a repo;
 *   5. the historical hostname match → the host, unchanged;
 *   6. nothing.
 *
 * `allowBareSlug` is true for the explicit `/policy` and `/own` arguments, where
 * the whole token is by construction a target, and false for the free-text hunt
 * path, where `api/v2` inside a sentence must stay a word rather than become a
 * repository.
 */
export function resolveTargetRef(raw: string, allowBareSlug = false, chainId: number | null = null): TargetRef {
  const text = (raw ?? '').trim();
  if (!text) return { kind: 'none', program: 'unscoped' };

  if (ADDRESS.test(text)) {
    const address = text.toLowerCase();
    return {
      kind: 'address',
      // THE IDENTITY FIX. Without a chain the address is `unscoped` — it cannot
      // honestly be anything else. WITH a chain it is `chain:<id>:<address>`, so
      // the same 20 bytes on Base and on Ethereum are two different engagements
      // and can never share one `automation` verdict.
      program: chainId === null ? 'unscoped' : chainProgramId(chainId, address),
      address,
      chainId,
    };
  }

  // 1b. an address INSIDE a sentence, e.g. "hunt 0xdAC17F…".
  //
  // The anchored arm above only matches when the whole string is the address, and
  // the free-text hunt path hands over the entire message. Without this arm the
  // chain the operator tapped was computed and then dropped, because resolution fell
  // through to the hostname regex and produced `unscoped` — so the CA dead end
  // survived the fix. A 40-hex `0x` token in free text is unambiguous: nothing else
  // in a hunter's message has that shape.
  if (!ADDRESS.test(text)) {
    const inText = /(?:^|[^0-9a-zA-Z])0x([0-9a-fA-F]{40})(?![0-9a-fA-F])/.exec(text);
    const found = inText?.[1];
    if (found) {
      const address = `0x${found.toLowerCase()}`;
      return {
        kind: 'address',
        program: chainId === null ? 'unscoped' : chainProgramId(chainId, address),
        address,
        chainId,
      };
    }
  }

  // 2. a full URL, either a repo or a host
  if (URL_SHAPE.test(text)) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(text);
    } catch {
      parsed = null;
    }
    if (parsed) {
      const host = parsed.hostname.toLowerCase();
      if ((REPO_HOSTS as readonly string[]).includes(host)) {
        const m = REPO_PATH.exec(parsed.pathname);
        const owner = m?.[1];
        const name = m?.[2];
        if (owner && name && name !== '.' && name !== '..') {
          return repoRef(host, `${owner}/${name}`);
        }
      }
      // A non-repo URL still names a host; fall through to the hostname arm so the
      // program id is byte-identical to what the pre-existing code produced.
    }
  }

  // 3. a scheme-less `<repo-host>/owner/name`
  if (!URL_SHAPE.test(text)) {
    const bare = /^(github\.com|gitlab\.com|bitbucket\.org)(\/.*)?$/i.exec(text);
    if (bare?.[1]) {
      const host = bare[1].toLowerCase();
      const m = REPO_PATH.exec(bare[2] ?? '');
      const owner = m?.[1];
      const name = m?.[2];
      if (owner && name && name !== '.' && name !== '..') {
        return repoRef(host, `${owner}/${name}`);
      }
      // `github.com` alone is a host, not a repo: fall through unchanged.
    }
  }

  // 3. a repo reference INSIDE a sentence, e.g. "audit https://github.com/acme/vault carefully"
  //
  // This arm exists because the free-text hunt path hands the whole message to this
  // function. Without it, "audit https://github.com/acme/vault" failed the URL arm
  // (the string does not START with https://) and fell through to the hostname
  // regex, which matched `github.com` — so a repo hunt was silently filed as a HOST
  // hunt with no policy and refused. The reference is anchored on a forge host and
  // bounded so it cannot run into trailing prose.
  const embedded = /(?:https?:\/\/)?(github\.com|gitlab\.com|bitbucket\.org)\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:[@#][0-9a-f]{7,40})?(?=$|[\s,;)"'<>])/i.exec(
    text,
  );
  if (embedded?.[1] && embedded[2] && embedded[3]) {
    const name = embedded[3];
    if (name !== '.' && name !== '..') {
      return repoRef(embedded[1].toLowerCase(), `${embedded[2]}/${name}`);
    }
  }

  // 4. a bare `owner/name`, only when the caller declared the string is a target
  if (allowBareSlug && !URL_SHAPE.test(text)) {
    const m = BARE_SLUG.exec(text);
    const owner = m?.[1];
    const name = m?.[2];
    if (owner && name && name !== '.' && name !== '..') {
      return repoRef('github.com', `${owner}/${name}`);
    }
  }

  // 5. the historical hostname arm — unchanged for every genuine host
  const hostMatch = text.match(HOSTNAME)?.[0]?.toLowerCase();
  if (hostMatch) return { kind: 'host', program: hostMatch, host: hostMatch };

  return { kind: 'none', program: 'unscoped' };
}

function repoRef(host: string, repo: string): TargetRef {
  const clean = repo.toLowerCase().replace(/\.git$/, '');
  return {
    kind: 'repo',
    program: repoProgramId(host, clean),
    repo: clean,
    host: host.toLowerCase(),
    homepage: `https://${host.toLowerCase()}/${clean}`,
  };
}

/** True when a `programs.id` is a repo id (`host:owner/name`) rather than a host. */
export function isRepoProgramId(id: string): boolean {
  return /^[a-z0-9.-]+:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// the program row
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthEnv {
  DB: D1Database;
  OPERATOR_NAME?: string;
  /** Daily cap on policy fetches triggered from chat. See `spendPolicyFetch`. */
  POLICY_DAILY_FETCH_CAP?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// the operator's gate setting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How much the anchor gate demands before it will authorize work.
 *
 * THE OPERATOR IS THE AUTHORITY ON THEIR OWN SCOPE. The gate exists to stop the
 * tool LYING about what it may touch — to prevent one approval silently covering a
 * target nobody chose — not to argue with the operator about what they are allowed
 * to test. So the *policy* half of the gate is a setting they own, and the
 * *correctness* half is not.
 *
 *   · `strict`    — every class needs a fetched policy anchor. Today's behaviour,
 *                   kept reachable because a cautious operator may want it.
 *   · `own_scope` — DEFAULT. For the two classes where the operator IS the
 *                   authority and no third party needs to be consulted, a
 *                   declaration is enough: a repo they can already clone, and a
 *                   public contract read only-plus-simulated on a public ledger.
 *                   No remote host to hammer, no service to disrupt, no rate
 *                   budget to spend: demanding a fetched policy for public chain
 *                   data is a category error, exactly as `policy.ts` already says
 *                   it is for repos.
 *   · `open`      — no anchor required for any class. The operator has said in so
 *                   many words that they will decide scope themselves.
 *
 * WHAT THIS MODE NEVER CHANGES, in ANY of the three — because these are
 * correctness, and dropping them would make the tool report the wrong thing rather
 * than give the operator freedom:
 *
 *   1. PER-TARGET IDENTITY. `chain:<id>:<0x…>` for an address, `host:owner/name`
 *      for a repo. Without it, one hunt authorises every other contract and every
 *      other repo on the forge — the tool widening scope the operator did NOT
 *      choose, which is the exact opposite of "I decide scope myself".
 *   2. THE CHAIN IS SUPPLIED, BUT ASKED, NEVER GUESSED. `policy.ts:chainForBrief`
 *      still refuses an address brief with no `chain_id`.
 *   3. `automation='prohibited'` is terminal for that exact program id. If the
 *      operator's own recorded document says no, the tool honours it until they
 *      change it deliberately.
 *   4. DISTINCT VERDICTS PER CHAIN. The same 20 bytes on two chains are two rows.
 */
export type GateMode = 'strict' | 'own_scope' | 'open';

export const GATE_MODES: readonly GateMode[] = ['strict', 'own_scope', 'open'];

/** The default. See {@link GateMode} for why this one. */
export const GATE_MODE_DEFAULT: GateMode = 'own_scope';

const GATE_KV_KEY = 'policy_gate';

export function isGateMode(v: unknown): v is GateMode {
  return typeof v === 'string' && (GATE_MODES as readonly string[]).includes(v);
}

/**
 * Read the operator's gate setting.
 *
 * A missing row — a fresh database, a restored backup, a first run — means the
 * default, not `strict` and not `open`. An unreadable value also falls back to the
 * default rather than throwing: a corrupt setting must not lock the operator out
 * of their own tool, and it must not silently grant the most permissive mode
 * either. `own_scope` is the safe reading of "I do not know", because it is
 * permissive exactly where no third party is affected.
 */
export async function gateMode(env: AuthEnv): Promise<GateMode> {
  try {
    const row = await env.DB.prepare('SELECT value FROM kv WHERE key=?')
      .bind(GATE_KV_KEY)
      .first<{ value: string }>();
    return isGateMode(row?.value) ? row.value : GATE_MODE_DEFAULT;
  } catch {
    return GATE_MODE_DEFAULT;
  }
}

/**
 * Change the gate setting, recording the change in the ledger.
 *
 * The ledger line is written for EVERY mode including `open`, because an audit
 * trail is the one thing that must survive the operator waiving the policy gate —
 * "why did this run" has to stay answerable. Returns the previous mode so the
 * reply can say what changed.
 */
export async function setGateMode(
  env: AuthEnv,
  mode: GateMode,
  operator: string,
  ledger?: (kind: string, payload: unknown) => Promise<void>,
  now = Math.floor(Date.now() / 1000),
): Promise<{ ok: boolean; previous: GateMode; mode: GateMode; at: number }> {
  const previous = await gateMode(env);
  const ts = now;
  await env.DB.prepare(
    `INSERT INTO kv (key,value,ts) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts`,
  )
    .bind(GATE_KV_KEY, mode, ts)
    .run();
  // Best-effort, exactly like every other ledger write in this codebase: a failed
  // audit line must not lose the operator's setting, and a failed setting must not
  // be reported as done because the ledger write succeeded.
  if (ledger) {
    try {
      await ledger('policy.gate_changed', { by: operator, from: previous, to: mode, at: ts });
    } catch {
      /* the setting is already committed */
    }
  }
  return { ok: true, previous, mode, at: ts };
}

/**
 * Which target classes a mode will authorize WITHOUT a fetched policy.
 *
 * `chain_address` and `repo` are exactly the two classes where the operator is the
 * authority: a contract on a public ledger (read-only + simulation) and source they
 * can already clone. A HOST or DOMAIN is a third party's live service — that is
 * where the anchor requirement earns its keep — so it is only anchor-free in
 * `strict`... which is to say never, except in `open`, which the operator must
 * choose explicitly.
 */
export function anchorFreeFor(mode: GateMode, kind: TargetRef['kind']): boolean {
  if (mode === 'strict') return false;
  if (mode === 'open') return true;
  // own_scope
  return kind === 'repo' || kind === 'address';
}

/**
 * Resolve the program row a hunt hangs off, creating a self-scoped one on first
 * use. Shared by the Telegram webhook and the Mini App work layer, so the two
 * cannot drift into creating different rows for the same request.
 *
 * Neither synthetic id is a crawl candidate: `CRAWL_CANDIDATE_SQL` in `discovery.ts`
 * excludes any id containing ':' (a hostname never does) and the literal
 * `unscoped`, so these rows cannot burn the discovery budget probing a
 * `security.txt` that does not exist. That filter is what makes "/seed a host, then
 * let discovery parse its policy" true instead of merely plausible.
 *
 * `chainId` is threaded through because an address's identity depends on it. When
 * it is absent the address still resolves to `unscoped` — the caller has to ask
 * the operator which chain (see `intake.ts`'s chain question) before anything can
 * be scoped, and this function must not invent an answer.
 */
export async function ensureProgramRow(
  env: AuthEnv,
  raw: string,
  chainId: number | null = null,
): Promise<string> {
  return upsertProgramRow(env, resolveTargetRef(raw, false, chainId));
}

/**
 * Create the row for an ALREADY-RESOLVED reference.
 *
 * Separate from `ensureProgramRow` because resolution is NOT idempotent across
 * callers: `/policy` and `/own` resolve with `allowBareSlug: true` (the whole token
 * is a target, so `acme/vault` IS a repo), while the free-text hunt path must
 * resolve with `false` (`api/v2` inside a sentence is not). The two ingress paths
 * resolve once and pass THAT ref here, which is the difference between writing
 * `github.com:acme/vault` and silently writing `unscoped` because a second
 * resolution disagreed with the first.
 *
 * That bug was real and is why this function exists: `/own acme/vault` reported
 * success while creating only the `unscoped` row, so the UPDATE that followed
 * matched nothing and no anchor was ever recorded.
 */
async function upsertProgramRow(env: AuthEnv, ref: TargetRef): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (ref.kind === 'repo') {
    // No `next_check` forestalling is needed: a repo id contains ':' and is
    // excluded from the crawl queue by `CRAWL_CANDIDATE_SQL` on that basis.
    await env.DB.prepare(
      `INSERT INTO programs (id,name,platform,homepage,status,discovered_at)
       VALUES (?,?,?,?,'new',?) ON CONFLICT(id) DO NOTHING`,
    )
      .bind(ref.program, ref.repo, 'repo', ref.homepage, now)
      .run();
    return ref.program;
  }

  if (ref.kind === 'address' && ref.chainId !== null) {
    // One row per (chain, address). `platform='chain'` so the inventory can tell a
    // contract from a host. It is also excluded from the crawl queue by id shape —
    // `chain:<id>:0x…` contains ':' — because there is no security.txt on a
    // contract to probe.
    await env.DB.prepare(
      `INSERT INTO programs (id,name,platform,homepage,status,discovered_at)
       VALUES (?,?,?,?,'new',?) ON CONFLICT(id) DO NOTHING`,
    )
      .bind(
        ref.program,
        ref.address,
        'chain',
        chainExplorerUrl(ref.chainId, ref.address),
        now,
      )
      .run();
    return ref.program;
  }

  if (ref.kind === 'host') {
    await env.DB.prepare(
      `INSERT INTO programs (id,name,platform,homepage,status,discovered_at)
       VALUES (?,?,?,?,'new',?) ON CONFLICT(id) DO NOTHING`,
    )
      .bind(ref.host, ref.host, 'self', `https://${ref.host}`, now)
      .run();
    return ref.host;
  }

  // An address with no chain (or nothing recognisable) keeps the pre-existing
  // behaviour: a row keyed `unscoped`, which no policy can ever anchor.
  await env.DB.prepare(
    `INSERT INTO programs (id,name,platform,homepage,status,discovered_at)
     VALUES (?,?,?,?,'new',?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind('unscoped', 'unscoped', 'self', 'https://unscoped', now)
    .run();
  return 'unscoped';
}

/** A block-explorer link for a contract, when the registry knows the chain. */
function chainExplorerUrl(chainId: number, address: string): string {
  const spec = chainSpec(chainId);
  if (!spec || !spec.explorer) return `https://example.invalid/${address}`;
  return `https://${spec.explorer}/address/${address}`;
}

/**
 * THE GATE. Returns the authorization anchor, or `null` for "refuse".
 *
 * Unchanged in strength from the original, plus two additions the operator asked
 * for and one that correctness demanded:
 *
 *   · `automation = 'prohibited'` → `null`, ALWAYS, before anything else is read.
 *     Never lifted here; only a document that affirmatively permits automated
 *     testing can change the recorded value, and that is `/policy`'s job.
 *   · a HOST row whose `policy_url` carries the `self:` scheme → `null`. `/own`
 *     refuses host targets, so this can only fire on a hand-edited row; it is the
 *     belt to that brace and costs one string comparison.
 *   · (new) in `own_scope`, a REPO or a CHAIN ADDRESS with no anchor at all still
 *     resolves, to an anchor that SAYS it was the operator's own declaration. That
 *     is what stops the CA dead-end without inventing permission: the brief and
 *     the report carry the provenance line, so nothing claims a policy document
 *     said something it did not.
 *   · (new) in `open`, every class resolves the same way, because the operator has
 *     chosen that. The provenance string still names the mode and the timestamp.
 *
 * A host is never anchor-free unless the mode is literally `open` — the one place
 * a third party's service is concerned is the one place the requirement stays.
 */
export async function authorizationFor(
  env: AuthEnv,
  programId: string,
  mode?: GateMode,
): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT automation, policy_url, policy_text FROM programs WHERE id=?',
  )
    .bind(programId)
    .first<{ automation: string; policy_url: string | null; policy_text: string | null }>();
  if (!row) return null;

  // Absolute, in every mode.
  if (row.automation === 'prohibited') return null;

  const selfAssertion = row.policy_url?.startsWith(SELF_SCHEME) === true;
  const isChain = isChainProgramId(programId);
  const isRepo = isRepoProgramId(programId);

  // A self-assertion is only ever meaningful for something the operator owns: a
  // repo. A host carrying one (hand-edited, restored from backup) is refused.
  if (selfAssertion && !isRepo) return null;

  if (row.policy_url) {
    if (row.automation === 'allowed') return `${row.policy_url} permits automated testing`;
    return `${row.policy_url} (no prohibition on automated testing)`;
  }

  // No anchor on file. Whether that is fatal now depends on the operator's own
  // setting and on whether a third party is affected.
  const effective = mode ?? (await gateMode(env));
  const kind: TargetRef['kind'] = isChain ? 'address' : isRepo ? 'repo' : 'host';
  if (!anchorFreeFor(effective, kind)) return null;

  const at = new Date().toISOString();
  // NEVER A SILENT ANCHOR. The string names the mode and the moment, so a
  // dispatch that happened without a policy document can still answer "why did
  // this run" from its own `authorization_ref`.
  return `operator-declared scope (gate=${effective}, ${at})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// the refusal copy — ONE source, so the two surfaces cannot disagree
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The commands the refusal may name.
 *
 * Every entry here is dispatched by `index.ts:handleUpdate`, and the test suite
 * proves that by driving each one through the webhook and asserting it is not
 * treated as free text. That is the whole point: the previous copy named a path
 * ("paste the exact policy sentence") that did not exist, so an operator following
 * the instruction dead-ended. A refusal that names a command nobody implements is
 * worse than no refusal, because it looks like the operator's mistake.
 */
export const ANCHOR_COMMANDS: ReadonlyArray<{ cmd: string; example: string; what: string }> = [
  {
    cmd: '/policy',
    example: '/policy example.com https://example.com/security',
    what: 'fetch that policy now and record what it actually says',
  },
  {
    cmd: '/seed',
    example: '/seed example.com',
    what: 'queue the host; discovery reads its security.txt on the next hourly tick',
  },
  {
    cmd: '/own',
    example: '/own acme/vault',
    what: 'you own this repo: records an audit-only self-assertion, repos only',
  },
];

export interface RefusalInput {
  /** The program id that was resolved (or `unscoped`). */
  program: string;
  /** The targets the compiler produced, if any, for the "compiled, not queued" line. */
  targets?: string[];
  /** The resolved target kind, so the address case can explain itself. */
  kind?: TargetRef['kind'];
  /** The address, when `kind` is `'address'`. */
  address?: string;
}

/**
 * The anchor refusal, rendered for one surface.
 *
 * `mode: 'text'` is the Mini App's string; `mode: 'html'` is the Telegram card.
 * They are built from the same lines in the same order, so the only difference is
 * the tags — which the parity test asserts by stripping them and diffing.
 */
export function authorizationRefusal(input: RefusalInput, mode: 'text' | 'html'): string {
  const header = 'NO AUTHORIZATION ON FILE';

  // AN ADDRESS HAS ONE NEXT ACTION, AND IT IS A TAP.
  //
  // This is not a "record an anchor" situation: nothing can be scoped, forked or
  // simulated until the chain is named, and naming it is the chain question's job
  // (see `intake.ts:compile`). Telling the operator to run a command here would be
  // the same mistake the old copy made — naming a path that is not the shortest one.
  if (input.kind === 'address') {
    return render(
      [
        header,
        'This contract still needs its chain.',
        '',
        'An address is not a programme: the same 20 bytes exist on every EVM chain, so ' +
          'nothing can be scoped until a chain is named. I will not guess one — guessing is ' +
          'how an Ethereum mainnet contract once got recorded as a Base address.',
        '',
        'Send it again and tap the chain button, or pin it inline:',
        '    hunt 0x… chain:8453',
        '',
        'Nothing is queued until then.',
      ],
      mode,
    );
  }

  // NEVER SHOW THE INTERNAL `unscoped` ID. It is a placeholder meaning "I could not
  // name this target"; printing it at the operator made the bot look broken rather
  // than specific, and it was the visible tell that identity was missing.
  const shown = (input.targets ?? []).filter((t) => t && t !== 'unscoped').join(', ');

  return render(
    [
      header,
      'I will not touch a target whose program policy is not recorded.',
      '',
      ...(shown ? [`Compiled, but not queued: ${shown}`, ''] : []),
      'Record an anchor with one of these:',
      ...ANCHOR_COMMANDS.map((c) => `    ${c.example}`),
      '',
      'Nothing is queued until one of those lands.',
    ],
    mode,
  );
}

/**
 * One body, two renderings.
 *
 * `text` is returned verbatim for the Mini App; `html` escapes the same text and
 * bolds the header. Building both from one line list is what makes the two surfaces
 * provably agree — the parity test strips the tags and diffs them, which is only
 * meaningful if there is nothing to diverge except the markup.
 */
function render(lines: string[], mode: 'text' | 'html'): string {
  if (mode === 'text') return lines.join('\n');
  const [head, ...rest] = lines;
  return [`<b>${esc(head ?? '')}</b>`, `<code>${'─'.repeat(22)}</code>`, esc(rest.join('\n'))].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// outbound fetch budget
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Charge one outbound policy fetch against a daily budget, before making it.
 *
 * `/policy` is the only path where a chat message causes the Worker to fetch a URL
 * a person typed, so it is the only path that needs this. The `quota` table is the
 * existing mechanism (`llm.ts` spends `llm_tokens` from it, `desk/db.ts` spends
 * `desk_subrequests`); a new bucket keeps the two budgets independent so a burst of
 * re-checks cannot starve the desk or the model.
 *
 * The cap is deliberately small. A legitimate operator authorizes a handful of
 * targets a day; anything above a couple of hundred is a loop, a typo, or someone
 * probing the Worker as an open proxy.
 *
 * Note on `pace.ts`: `pacerFor()` spaces requests made ON AN ENGAGEMENT'S BEHALF,
 * which needs a target and a rate the target declared. This call is not
 * engagement-scoped — it happens before any engagement exists — so the correct
 * control is a daily cap, not a per-second interval. Claiming a pacer here would be
 * the exact "declaration nothing honours" pattern `pace.ts` was written to remove.
 */
async function spendPolicyFetch(env: AuthEnv, n = 1): Promise<{ ok: boolean; used: number; cap: number }> {
  const day = new Date().toISOString().slice(0, 10);
  const cap = Number(env.POLICY_DAILY_FETCH_CAP ?? '200');
  const row = await env.DB.prepare(
    "SELECT used FROM quota WHERE day=? AND bucket='policy_subrequests'",
  )
    .bind(day)
    .first<{ used: number }>();
  const used = row?.used ?? 0;
  if (used + n > cap) return { ok: false, used, cap };
  await env.DB.prepare(
    `INSERT INTO quota (day, bucket, used, cap) VALUES (?,?,?,?)
     ON CONFLICT(day, bucket) DO UPDATE SET used = used + excluded.used, cap = excluded.cap`,
  )
    .bind(day, 'policy_subrequests', n, cap)
    .run();
  return { ok: true, used: used + n, cap };
}

// ─────────────────────────────────────────────────────────────────────────────
// /policy — fetch a document and record what it says
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hosts that legitimately serve a programme's policy without being the programme's
 * own site. These are the platforms `app/schema.sql` already enumerates, because a
 * HackerOne brief lives on hackerone.com and its "policy" is not served by the
 * target's apex.
 */
const PLATFORM_HOSTS = [
  'hackerone.com',
  'bugcrowd.com',
  'immunefi.com',
  'cantina.xyz',
  'code4rena.com',
  'sherlock.xyz',
  'codehawks.com',
  'hackenproof.com',
  'intigriti.com',
  'yeswehack.com',
] as const;

function siteOf(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Is `docHost` allowed to speak for `targetHost`?
 *
 * This is the narrowness that stops `/policy` from becoming "point at any file".
 * Without it, `/policy victim.com https://my-server/x.txt` with a file containing
 * the word "scanners are welcome" — or nothing at all, which classifies
 * `not_mentioned` and still satisfies the gate — would mint an anchor out of thin
 * air. The document must come from the target's own site (in either direction, so
 * the apex can speak for `app.example.com` and vice versa) or from a platform that
 * hosts programme briefs.
 *
 * The comparison is label-aware: `evilexample.com` is NOT the same site as
 * `example.com`, because the suffix test includes the leading dot.
 */
export function policySourceAllowed(targetHost: string, docHost: string): boolean {
  const t = siteOf(targetHost);
  const d = siteOf(docHost);
  if (!t || !d || !d.includes('.')) return false;
  if (d === t || d.endsWith(`.${t}`) || t.endsWith(`.${d}`)) return true;
  return (PLATFORM_HOSTS as readonly string[]).some((p) => d === p || d.endsWith(`.${p}`));
}

export type PolicyOutcome =
  | {
      ok: true;
      program: string;
      policyUrl: string;
      automation: 'allowed' | 'not_mentioned';
      reward: string;
      bytes: number;
      sha: string;
      anchor: string;
    }
  | {
      /** The document was fetched and read, and it FORBIDS automated testing. */
      ok: false;
      reason: 'prohibited';
      program: string;
      policyUrl: string;
      bytes: number;
      sha: string;
    }
  | {
      ok: false;
      reason: 'bad_target' | 'bad_url' | 'not_https' | 'cross_site' | 'budget' | 'unreachable' | 'unusable';
      program: string;
      detail: string;
    };

export interface AuthorizeDeps {
  /** Injected for tests; defaults to the global fetch, exactly like `discovery.ts`. */
  fetch?: CrawlFetcher;
  now?: number;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `/policy <target> <policy-url>` — fetch, classify, record.
 *
 * NOTHING IS HALF-WRITTEN. The fetch and the classification both complete before
 * the first `UPDATE`, and the `UPDATE` is a single statement, so there is no
 * window in which a row has a `policy_url` but a stale `automation`. A failure to
 * fetch, a non-https scheme, a cross-site document, an exhausted budget or an empty
 * body all return before any write.
 *
 * `prohibited` DOES write, and that is deliberate rather than a contradiction: the
 * prohibition is the finding, and recording it is the only way it becomes durable.
 * It writes `automation='prohibited'`, which makes `authorizationFor()` return
 * `null` — strictly the same refusal as writing nothing, plus an audit trail that
 * a later `/seed`-driven crawl cannot quietly erase.
 */
export async function authorizeWithPolicy(
  env: AuthEnv,
  target: string,
  policyUrl: string,
  deps: AuthorizeDeps = {},
): Promise<PolicyOutcome> {
  const ref = resolveTargetRef(target, true);
  const now = deps.now ?? Math.floor(Date.now() / 1000);

  if (ref.kind === 'address') {
    return {
      ok: false,
      reason: 'bad_target',
      program: ref.program,
      detail:
        'an address is not a programme: it has no policy page, and the same 20 bytes exist on ' +
        'every EVM chain, so a brief for it must name chain_id instead',
    };
  }
  if (ref.kind === 'none') {
    return {
      ok: false,
      reason: 'bad_target',
      program: ref.program,
      detail: `I cannot tell what "${target}" names. Give me a host (example.com) or a repo (github.com/owner/name).`,
    };
  }

  let docUrl: URL;
  try {
    docUrl = new URL(policyUrl.trim());
  } catch {
    return {
      ok: false,
      reason: 'bad_url',
      program: ref.program,
      detail: `"${policyUrl}" is not a URL. It must be an absolute https:// address.`,
    };
  }
  if (docUrl.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'not_https',
      program: ref.program,
      detail: `only https is fetched; ${docUrl.protocol} is refused, because a policy we act on must not be alterable in transit`,
    };
  }

  // The document must be allowed to speak for the target. For a repo the "site" is
  // the forge, so a SECURITY.md on github.com is accepted and a file on an
  // unrelated host is not.
  const targetHost = ref.kind === 'repo' ? ref.host : ref.host;
  if (!policySourceAllowed(targetHost, docUrl.hostname)) {
    return {
      ok: false,
      reason: 'cross_site',
      program: ref.program,
      detail:
        `${docUrl.hostname} is not ${targetHost} and is not a programme platform, so a document ` +
        `there cannot tell me what ${targetHost} permits`,
    };
  }

  const budget = await spendPolicyFetch(env);
  if (!budget.ok) {
    return {
      ok: false,
      reason: 'budget',
      program: ref.program,
      detail: `the daily policy-fetch budget is spent (${budget.used}/${budget.cap}); try again tomorrow`,
    };
  }

  const got: PolicyFetch = await fetchPolicyDocument(docUrl.toString(), deps.fetch);
  if (!got.ok) {
    return {
      ok: false,
      reason: got.reason === 'not_text' ? 'unusable' : 'unreachable',
      program: ref.program,
      detail:
        got.reason === 'not_text'
          ? `that URL answered, but not with text (${got.detail}), so there is nothing to classify`
          : `could not read that URL (${got.detail}); nothing was written`,
    };
  }
  if (!got.text.trim()) {
    return {
      ok: false,
      reason: 'unusable',
      program: ref.program,
      detail: 'that URL returned an empty body; nothing was written',
    };
  }

  const automation = classifyAutomation(got.text);
  const reward = classifyReward(got.text);
  const sha = await sha256Hex(got.text);

  // The row must exist before it can be updated, and the id must be THIS target's.
  // The ref was resolved ONCE above with `allowBareSlug: true` and is reused here:
  // re-resolving with different flags would disagree — `acme/vault` is a repo when
  // it is the whole argument and nothing when it is inside a sentence — and the
  // UPDATE below would then match no row while still reporting success.
  await upsertProgramRow(env, ref);
  const programId = ref.program;

  if (automation === 'prohibited') {
    await env.DB.prepare(
      `UPDATE programs SET policy_url=?, policy_text=?, policy_sha=?, automation='prohibited',
         reward=?, status='parsed', last_checked=?, next_check=NULL
       WHERE id=?`,
    )
      .bind(docUrl.toString(), got.text, sha, reward, now, ref.program)
      .run();
    return { ok: false, reason: 'prohibited', program: ref.program, policyUrl: docUrl.toString(), bytes: got.text.length, sha };
  }

  /**
   * A prohibition is only lifted by a document that AFFIRMATIVELY permits
   * automated testing. `not_mentioned` is not permission, so it must not be able to
   * overwrite a recorded `prohibited` — that would let a weaker document quietly
   * re-open a programme that had said no.
   */
  const current = await env.DB.prepare('SELECT automation FROM programs WHERE id=?')
    .bind(ref.program)
    .first<{ automation: string }>();
  if (current?.automation === 'prohibited' && automation !== 'allowed') {
    return {
      ok: false,
      reason: 'unusable',
      program: ref.program,
      detail:
        'this programme is already recorded as prohibiting automated testing, and that document ' +
        'merely fails to mention it. Only a policy that affirmatively permits automated testing ' +
        `can lift that; nothing was changed`,
    };
  }

  await env.DB.prepare(
    `UPDATE programs SET policy_url=?, policy_text=?, policy_sha=?, automation=?, reward=?,
       status='parsed', last_checked=?, next_check=NULL
     WHERE id=?`,
  )
    .bind(docUrl.toString(), got.text, sha, automation, reward, now, ref.program)
    .run();

  const anchor = await authorizationFor(env, ref.program);
  if (anchor === null) {
    // Cannot happen while the row above was just written as allowed/not_mentioned
    // with a policy_url, but it is checked rather than asserted: the return type
    // says `ok: true` only when an anchor really resolved, and a future change to
    // the gate must not be able to make this reply claim success falsely.
    return {
      ok: false,
      reason: 'unusable',
      program: ref.program,
      detail: 'the policy was recorded, but the gate still resolved no anchor for it',
    };
  }
  return {
    ok: true,
    program: ref.program,
    policyUrl: docUrl.toString(),
    automation,
    reward,
    bytes: got.text.length,
    sha,
    anchor,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// /own — the ONE path where the operator is the source of authority
// ─────────────────────────────────────────────────────────────────────────────

/** The prefix that marks a `policy_url` as an operator assertion, not a document. */
export const SELF_SCHEME = 'self:';

export interface OwnOutcome {
  ok: boolean;
  reason: 'ok' | 'not_a_repo' | 'address' | 'prohibited' | 'already_fetched';
  program: string;
  detail: string;
  /** The exact `policy_url` value written, or null when nothing was written. */
  selfRef: string | null;
}

/**
 * `/own <owner>/<repo>` — assert that the operator owns a repository.
 *
 * THE NARROWNESS ARGUMENT, because this is the only loosely-gated path:
 *
 *  1. REPOSITORIES ONLY. Auditing source you own needs nobody's permission — you
 *     can already `git clone` it, and the plane treats a repo as a read-only clone
 *     that produces a PoC. A HOST, domain, CIDR or chain address is a running
 *     third-party system; "this is mine" is not authorization for it, and there is
 *     no way for this Worker to check the claim. Those four kinds are refused BY
 *     NAME so the operator is told which rule they hit.
 *
 *  2. IT CANNOT GRANT WHAT A DOCUMENT FORBADE. If the row already says
 *     `automation='prohibited'`, the assertion is refused outright. A prohibition
 *     comes from a published policy; the operator's belief that they own the repo
 *     does not repeal it.
 *
 *  3. IT CANNOT OVERWRITE FETCHED EVIDENCE. If a real `https://` policy URL is
 *     already on file, `/own` refuses: replacing a fetched document with an
 *     assertion would destroy the stronger record.
 *
 *  4. IT IS AUDITABLE AND DISTINGUISHABLE. The written `policy_url` carries the
 *     `self:` scheme — a value no fetched URL can have, because the fetch path
 *     requires `https:` — plus the operator identity and the assertion timestamp.
 *     Anyone reading the database can tell a self-assertion from a document at a
 *     glance, and `meta` carries the same facts structured.
 *
 *  5. IT DOES NOT CLAIM A PERMISSION THAT DOES NOT EXIST. The row is written with
 *     `automation='not_mentioned'`, which is the literal truth: no policy mentions
 *     automation. It is NOT `allowed`, because there is no policy that allows
 *     anything. The gate still requires a non-null anchor, which the `self:` value
 *     supplies; the anchor text says `self:… (no prohibition on automated testing)`
 *     so the brief itself carries the distinction into the report.
 */
export async function selfAssertRepo(
  env: AuthEnv,
  target: string,
  operator: string,
  now = Math.floor(Date.now() / 1000),
): Promise<OwnOutcome> {
  const ref = resolveTargetRef(target, true);

  if (ref.kind === 'address') {
    return {
      ok: false,
      reason: 'address',
      program: ref.program,
      detail:
        'refused by name: an address is a live third-party contract, not source you can clone. ' +
        'Self-assertion is for repositories only.',
      selfRef: null,
    };
  }
  if (ref.kind !== 'repo') {
    return {
      ok: false,
      reason: 'not_a_repo',
      program: ref.program,
      detail:
        `refused by name: ${ref.kind === 'host' ? 'a host' : 'that'} is a running third-party system, ` +
        'and "this is mine" is not something this Worker can verify. Self-assertion covers ' +
        'repositories only — for a host use /policy with its published policy, or /seed.',
      selfRef: null,
    };
  }

  // Same reasoning as `/policy`: the ref resolved above (with `allowBareSlug`) is
  // the identity, so create THAT row rather than re-resolving and disagreeing.
  await upsertProgramRow(env, ref);

  const row = await env.DB.prepare('SELECT automation, policy_url FROM programs WHERE id=?')
    .bind(ref.program)
    .first<{ automation: string; policy_url: string | null }>();

  if (row?.automation === 'prohibited') {
    return {
      ok: false,
      reason: 'prohibited',
      program: ref.program,
      detail:
        'this programme is recorded as prohibiting automated testing; a self-assertion cannot ' +
        'overwrite that',
      selfRef: null,
    };
  }
  if (row?.policy_url && !row.policy_url.startsWith(SELF_SCHEME)) {
    return {
      ok: false,
      reason: 'already_fetched',
      program: ref.program,
      detail:
        `a fetched policy is already on file at ${row.policy_url}; a self-assertion will not ` +
        'replace a document with a claim',
      selfRef: null,
    };
  }

  const selfRef = `${SELF_SCHEME}operator=${operator};asserted_at=${now}`;
  const meta = JSON.stringify({
    self_assertion: { by: operator, at: now, kind: 'repo', repo: ref.repo, host: ref.host },
  });

  await env.DB.prepare(
    `UPDATE programs SET policy_url=?, policy_text=?, policy_sha=?, automation='not_mentioned',
       status='parsed', last_checked=?, next_check=NULL, meta=?
     WHERE id=?`,
  )
    .bind(
      selfRef,
      `Self-assertion by ${operator} at ${new Date(now * 1000).toISOString()}: the operator states ` +
        `they own ${ref.host}/${ref.repo} and that this engagement is a read-only audit of source ` +
        'they can already clone. No third-party policy exists for it.',
      null,
      now,
      meta,
      ref.program,
    )
    .run();

  return {
    ok: true,
    reason: 'ok',
    program: ref.program,
    detail: `${ref.host}/${ref.repo} is recorded as a self-asserted repository audit`,
    selfRef,
  };
}
