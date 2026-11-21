/**
 * The ports the harness's driver runs a plywood scenario through
 * (chant `DriverPorts`): the harness's Forgejo and floci bucket, with
 * plywood's own pieces where the shop repository needs them.
 *
 *   reports    chant writes a preview of one stack under
 *              `<pr>/<head>/<member>/pr-plan.json` (reportKey with its
 *              member); the driver reads `<pr>/<head>/pr-plan.json`, so the
 *              bucket port falls back to the one member report below it
 *   ledger     the shop repository's chant/lifecycle, fetched from the forge
 *              and read with chant's own readers, its gated requests
 *              too (the harness's gated outcome)
 *   outOfBand  `plywood-e2e <check>` runs in process (./checks.ts) or in a
 *              job container; anything else runs through the harness's
 *              SafeRun. `${NAME:-default}` in a word comes from the arm's
 *              environment, so a BREAK arm can change a value
 *   arm        keeps the arm's environment, lays a base overlay on main
 *              when PLYWOOD_E2E_BASE_OVERLAY names one, and starts the lock
 *              observer
 *   chant      `plywood approve` as the reviewer, in a job container
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { readRunLedger } from "@intentius/chant/lifecycle/run-ledger";
import { readGateLedger } from "@intentius/chant/lifecycle/gate-ledger";
import { readGatedRequests, type GatedRequestRead } from "@intentius/chant/lifecycle/gated-request";
import { readOverrideLedger } from "@intentius/chant/lifecycle/override-ledger";
import { actionScript } from "./action";
import { BUCKETS, FLOCI_NET, FORGEJO_NET, ORG, PROJECT, REPO, jobEnv, plungeStoreUrl, s3BackendUrl } from "./bench";
import {
  canaryFirst,
  disjointTogether,
  doraCounts,
  driftIssueHolds,
  expandWord,
  finishedRuns,
  hasMarkers,
  lockishKeys,
  movedNotGated,
  oneNote,
  overrideRecorded,
  reportHolds,
  stackTarget,
  targetIsStack,
  waitsAtGate,
  waveRuns,
  EXIT,
  type CheckResult,
  type IssueView,
} from "./checks";
import { driftIssueTitle, driftOpName } from "../packages/plywood/src/words";
import type { ApproveInput, Arm, BucketPort, Clock, HarnessModule, LedgerRecord, Person, SafeRunInstance } from "./harness";
import { overlayFiles, readOverlay } from "./overlays";
import { CANARY_JS, MCP_JS, PROMOTE_JS, STAGE_JS, RECEIVED_FILE, RECEIVED_JS, RECEIVER, RECEIVER_JS, RECEIVER_PORT, RECEIVER_URL, ROLLBACK_JS, ROWS_JS } from "./probes";
import { RELEASE_GATE } from "../packages/plywood/src/init/render";

// ── reports ─────────────────────────────────────────────────────────────

/**
 * A bucket whose `get` of `<x>/pr-plan.json` or `pr-apply.json` falls back
 * to the single `<x>/<member>/<file>` below it, when chant wrote one
 * member's report. Two member reports there are an error: the scenario
 * would not know which to read.
 */
export function memberReports(bucket: BucketPort): BucketPort {
  return {
    ...bucket,
    get: async (key) => {
      const direct = await bucket.get(key);
      if (direct !== null) return direct;
      const m = /^(.*)\/(pr-(?:plan|apply)\.json)$/.exec(key);
      if (!m) return null;
      const under = (await bucket.list(`${m[1]}/`)).filter((k) => k.endsWith(`/${m[2]}`) && k.split("/").length === key.split("/").length + 1);
      if (under.length === 0) return null;
      if (under.length > 1) throw new Error(`${m[1]} holds ${under.length} member reports (${under.join(", ")}); a scenario step reads one`);
      return bucket.get(under[0]!);
    },
    put: (k, b, c) => bucket.put(k, b, c),
    list: (p) => bucket.list(p),
    delete: (k) => bucket.delete(k),
  };
}

// ── processes ───────────────────────────────────────────────────────────

/** Run a program on the host, resolving with stdout, rejecting with its last stderr lines. */
export function sh(file: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; redact?: string[] } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: o.cwd, env: o.env ?? process.env, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      let text = `${file} ${args[0] ?? ""} failed: ${String(stderr).trim().split("\n").slice(-3).join(" / ") || err.message}`;
      for (const s of o.redact ?? []) if (s) text = text.split(s).join("***");
      reject(new Error(text));
    });
  });
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface JobContainer {
  /** The job image the runner starts jobs in. */
  image: string;
  /** Who clones the repository inside. */
  person: Person;
  /** Environment beyond the job's own (jobEnv). */
  env?: Record<string, string>;
}

/**
 * The `docker run` argv for a command in a job container on the bench's
 * network: a fresh clone of main at /w, the program's packages installed,
 * then `script`. Every variable is named here, so nothing from the host
 * reaches it; PULUMI_BACKEND_URL and PULUMI_SKIP_UPDATE_CHECK are always set.
 */
export function jobArgv(h: Pick<HarnessModule, "RUNNER_JOB_ENV">, c: JobContainer, script: string): string[] {
  const env = { ...jobEnv(h), ...c.env };
  const remote = `http://${c.person.login}:${c.person.token}@${FORGEJO_NET.replace(/^http:\/\//, "")}/${ORG}/${REPO}.git`;
  const body = [
    "set -e",
    "mkdir -p /tmp/plywood-tutorial-gcloud-empty",
    `git clone -q ${quote(remote)} /w`,
    "cd /w",
    `git config user.name ${quote(c.person.login)}`,
    `git config user.email ${quote(`${c.person.login}@plywood-tutorial.local`)}`,
    // chant is plywood's own dependency in the image, not the program's.
    'export PATH="$PATH:/usr/local/lib/node_modules/@intentius/plywood/node_modules/.bin"',
    "npm ci --no-audit --no-fund >/dev/null",
    script,
  ].join("\n");
  return ["docker", "run", "--rm", "--network", PROJECT, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "--entrypoint", "sh", c.image, "-c", body];
}

/**
 * A command a person runs in a clone, with the forge's ledger under it: the
 * clone starts with the forge's chant/lifecycle, and when the command ends
 * (whatever its exit code) the records it wrote there are pushed back, so the
 * next clone and the harness's ForgeLedger see its gated run or its approval.
 * `plywood run <op>` and `plywood approve` write the ledger in the clone only
 * and push nothing (the first pw-adopt run on 2026-10-30 read 0 gated runs).
 * The command's own exit code is the script's.
 */
export function withForgeLedger(script: string): string {
  return [
    "git fetch -q origin chant/lifecycle:chant/lifecycle || true",
    "set +e",
    script,
    "code=$?",
    "set -e",
    "if git rev-parse -q --verify refs/heads/chant/lifecycle >/dev/null; then git push -q origin chant/lifecycle || echo 'plywood-e2e: the ledger push was refused' >&2; fi",
    "exit $code",
  ].join("\n");
}

// ── the ledger ──────────────────────────────────────────────────────────

/** The shop repository's ledger, fetched from the forge into a scratch repository. */
export class ForgeLedger {
  private dir?: string;

  constructor(
    private readonly o: { forgeUrl: string; reader: Person; scratch: string },
  ) {}

  private async fetch(): Promise<string> {
    if (!this.dir) {
      mkdirSync(this.o.scratch, { recursive: true });
      this.dir = mkdtempSync(join(this.o.scratch, "ledger-"));
      await sh("git", ["init", "-q", this.dir]);
    }
    const u = new URL(this.o.forgeUrl);
    u.username = this.o.reader.login;
    u.password = this.o.reader.token;
    u.pathname = `/${ORG}/${REPO}.git`;
    try {
      await sh("git", ["-C", this.dir, "fetch", "-q", "--force", u.toString(), "+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle"], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        redact: [this.o.reader.token],
      });
    } catch (err) {
      // No ledger branch yet is an empty ledger.
      if (!/couldn't find remote ref|not our ref/i.test(String(err))) throw err;
    }
    return this.dir;
  }

  async runs(env: string, op: string): Promise<LedgerRecord[]> {
    const cwd = await this.fetch();
    return (await readRunLedger(env, op, { cwd })).records as unknown as LedgerRecord[];
  }

  /** The newest pending gate of `op` recorded at or after `since`, with the plan it binds. */
  async pending(op: string, since: string): Promise<{ gate: string; planDigest?: string } | undefined> {
    const cwd = await this.fetch();
    const { pending } = await readGateLedger(op, { cwd });
    return pending.filter((p) => p.timestamp >= since).pop();
  }

  /** The override ledger's approvals and applied records, for pw-policy-override's record check. */
  async overrides(): Promise<{ resolutions: Array<{ gate: string; resolvedBy: string; note?: string; planDigest?: string }>; applied: Array<{ gate: string; planDigest: string }> }> {
    const cwd = await this.fetch();
    return readOverrideLedger({ cwd });
  }

  /** The gated requests of `op`, oldest first, for the harness's gated outcome (a gated request writes no op-run record). */
  async gatedRequests(op: string): Promise<GatedRequestRead[]> {
    const cwd = await this.fetch();
    return readGatedRequests(op, { cwd });
  }
}

// ── the lock observer ───────────────────────────────────────────────────

/**
 * The no-lock observer, ported from plunge's races (scripts/plunge-races
 * races.sh `same_record_race` and lib.sh `lockish_keys`): while an arm runs,
 * list plunge's record store every half second and keep every key that
 * looks like a lock. plunge takes no lock object, so a run on plunge leaves
 * the list empty.
 */
export class LockObserver {
  readonly seen = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  errors = 0;

  constructor(
    private readonly bucket: Pick<BucketPort, "list">,
    private readonly everyMs = 500,
  ) {}

  /** One look at the bucket. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const k of lockishKeys(await this.bucket.list(""))) this.seen.add(k);
    } catch {
      this.errors++;
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    this.stop();
    this.seen.clear();
    this.errors = 0;
    this.timer = setInterval(() => void this.tick(), this.everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The check: exit 0 when no lock-like key was seen. A listing that failed every time is not a pass. */
  result(): CheckResult {
    if (this.seen.size > 0) return { code: 1, line: `lock-like keys appeared in the record store: ${[...this.seen].sort().join(", ")}` };
    return { code: 0, line: `no lock-like key in the record store during the run (${this.errors} failed listings)` };
  }
}

// ── markers on floci ───────────────────────────────────────────────────

/** The tags of every SQS queue on floci (host URL), through SQS's query API, unsigned as floci takes it. */
export async function sqsQueueTags(floci: string, f: typeof fetch = fetch): Promise<Array<{ url: string; tags: Record<string, string> }>> {
  const call = async (params: Record<string, string>) => {
    const res = await f(`${floci.replace(/\/$/, "")}/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Version: "2012-11-05", ...params }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`floci answered ${res.status} to SQS ${params.Action}`);
    return res.text();
  };
  const list = await call({ Action: "ListQueues" });
  const urls = [...list.matchAll(/<QueueUrl>([^<]+)<\/QueueUrl>/g)].map((m) => m[1]!);
  const out: Array<{ url: string; tags: Record<string, string> }> = [];
  for (const url of urls) {
    const xml = await call({ Action: "ListQueueTags", QueueUrl: url });
    const tags: Record<string, string> = {};
    for (const m of xml.matchAll(/<Tag>\s*<Key>([^<]*)<\/Key>\s*<Value>([^<]*)<\/Value>\s*<\/Tag>/g)) tags[m[1]!] = m[2]!;
    out.push({ url, tags });
  }
  return out;
}

// ── the out-of-band commands ────────────────────────────────────────────

/** What the in-process commands need. */
export interface CommandContext {
  h: Pick<HarnessModule, "RUNNER_JOB_ENV">;
  clock: Clock;
  safe: Pick<SafeRunInstance, "run" | "log">;
  ledger: Pick<ForgeLedger, "runs" | "pending"> & Partial<Pick<ForgeLedger, "overrides">>;
  observer: Pick<LockObserver, "result">;
  /** The chant environment the scenario's runs are recorded under. */
  env: string;
  /** When the arm started, ISO-8601. */
  since(): string;
  /** The arm's environment, for `${NAME}` words. */
  armEnv(): Record<string, string>;
  floci: string;
  jobImage: string;
  author: Person;
  reviewer: Person;
  /** Seconds a wait may take. */
  waitLimit: number;
  /** Tags of floci's SQS queues. */
  queueTags?: () => Promise<Array<{ url: string; tags: Record<string, string> }>>;
  /** Who pushes main for `configure`. */
  admin?: Person;
  /** An overlay's files against the seeded repository: a step's (`pull`) or a base overlay (`base`). */
  overlay?(name: string, kind: "pull" | "base"): Record<string, string>;
  /** Push `files` over `branch` as the author, a commit on top of its head. */
  pushBranch?(branch: string, files: Record<string, string>, message: string): Promise<string>;
  /** Every comment of the newest pull request from `branch`, or undefined when there is none. */
  pullComments?(branch: string): Promise<string[] | undefined>;
  /** The shop repository's issues. */
  issues?(): Promise<IssueView[]>;
  /** The newest pull request from `branch`'s report of a stage at its head, or undefined while there is none. */
  pullReport?(branch: string, stage: "plan" | "apply"): Promise<unknown>;
  /** A key of the reports bucket, below its `shop/` prefix, or null. */
  report?(key: string): Promise<string | null>;
}

/** The arm's name for a branch a step named: the harness pushes `<branch>-break` in the BREAK arm. */
export const armBranch = (branch: string, env: Record<string, string>): string => (env.BREAK === "1" ? `${branch}-break` : branch);

/**
 * The backend of a stack that runs on stock Pulumi on the bench: the prod
 * stacks in the state bucket, staging in the store's bucket until pw-adopt
 * moves it. dev runs on plunge's store and is not one.
 */
export function stockBackend(stack: string): string {
  if (stack === "prod-us" || stack === "prod-eu") return s3BackendUrl(BUCKETS.state, FLOCI_NET);
  if (stack === "staging") return s3BackendUrl(BUCKETS.records, FLOCI_NET);
  throw new Error(`${stack} is not a stock Pulumi stack on the bench (prod-us, prod-eu or staging)`);
}

/** A node line that writes the files a base64 JSON variable holds, in the job's checkout. */
const WRITE_FILES = `node -e 'const fs=require("fs"),p=require("path");const f=JSON.parse(Buffer.from(process.env.PLYWOOD_E2E_FILES,"base64").toString("utf8"));for(const [k,v] of Object.entries(f)){fs.mkdirSync(p.dirname(k),{recursive:true});fs.writeFileSync(k,v)}'`;

/**
 * The script `configure` runs in a job container on a clone of main: lay
 * the base overlay's files, run `plywood init --forge forgejo --yes` on them
 * (the waves spec and the workflows written again, with plywood.yml's image
 * and engine lines), then `plywood ci --forge forgejo`, which also writes the
 * drift, review and agent workflows plywood.yml turns on with the same image
 * (plywood#48), and push main. The commit says [skip ci] so the push starts
 * no waves job of its own.
 */
export function configureScript(name: string): string {
  return [
    WRITE_FILES,
    `PULUMI_BACKEND_URL=${quote(s3BackendUrl(BUCKETS.state, FLOCI_NET))} plywood init --forge forgejo --yes`,
    // init writes the pull request and merge workflows; ci writes the rest plywood.yml turns on, such as the agents' workflows.
    `PULUMI_BACKEND_URL=${quote(s3BackendUrl(BUCKETS.state, FLOCI_NET))} plywood ci --forge forgejo`,
    "git add -A",
    `git commit -q -m ${quote(`e2e: plywood.yml from base overlay ${name}, and plywood init [skip ci]`)} || true`,
    "git push -q origin HEAD:main",
  ].join("\n");
}

/**
 * The script `sqs-retention` runs: the stack's events queue URL from its
 * outputs, then SQS SetQueueAttributes on floci, unsigned as floci takes it,
 * the hand change behind Pulumi's back the drift tutorial makes.
 */
export function retentionScript(stack: string, seconds: string): string {
  if (!/^\d+$/.test(seconds)) throw new Error(`sqs-retention takes seconds, not ${seconds}`);
  const set = `node -e 'fetch(process.argv[1]+"/",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({Action:"SetQueueAttributes",Version:"2012-11-05",QueueUrl:process.argv[2],"Attribute.1.Name":"MessageRetentionPeriod","Attribute.1.Value":process.argv[3]}).toString()}).then(async(r)=>{if(!r.ok){console.error("floci answered "+r.status+": "+(await r.text()));process.exit(1)}})' ${quote(FLOCI_NET)} "$url" ${quote(seconds)}`;
  return [`url=$(PULUMI_BACKEND_URL=${quote(stockBackend(stack))} pulumi stack output eventsQueueUrl --stack ${quote(stack)})`, 'test -n "$url"', set].join("\n");
}

/**
 * The script `drift-job` runs: what the scheduled drift job of `shop/<stack>`
 * runs (src/drift.ts driftOpSpec), the snapshots fetch, then `plywood drift
 * --op <name> --forge forgejo`, with the forge variables a Forgejo job has.
 */
export function driftJobScript(stack: string): string {
  return [
    "git fetch -q --no-tags origin '+refs/chant/snapshots:refs/chant/snapshots' || true",
    `plywood drift --op ${quote(driftOpName(`shop/${stack}`))} --forge forgejo`,
  ].join("\n");
}

/** The script `queue-retention` runs: the stack's events queue's retention on floci, read as floci takes SQS, compared with `seconds`. */
export function queueRetentionScript(stack: string, seconds: string): string {
  if (!/^\d+$/.test(seconds)) throw new Error(`queue-retention takes seconds, not ${seconds}`);
  const read = `node -e 'fetch(process.argv[1]+"/",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({Action:"GetQueueAttributes",Version:"2012-11-05",QueueUrl:process.argv[2],"AttributeName.1":"MessageRetentionPeriod"}).toString()}).then(async(r)=>{const t=await r.text();const m=/<Name>MessageRetentionPeriod<\\/Name>\\s*<Value>(\\d+)<\\/Value>/.exec(t);if(!r.ok||!m){console.error("floci answered "+r.status+": "+t);process.exit(1)}if(m[1]!==process.argv[3]){console.error("the queue keeps "+m[1]+"s, not "+process.argv[3]+"s");process.exit(1)}console.log("the queue keeps "+m[1]+"s")})' ${quote(FLOCI_NET)} "$url" ${quote(seconds)}`;
  return [`url=$(PULUMI_BACKEND_URL=${quote(stockBackend(stack))} pulumi stack output eventsQueueUrl --stack ${quote(stack)})`, 'test -n "$url"', read].join("\n");
}

/** When this arm last set main up: `audit` reads only what came after it, so a run from an earlier scenario cannot pass for this one. */
let configuredAt: string | undefined;

/** The script `audit` runs: `plywood audit <table> --json`, then a row that holds every path=value (./probes.ts ROWS_JS). */
export function auditScript(table: string, wants: readonly string[], since?: string): string {
  return [`plywood audit ${quote(table)}${since ? ` --since ${quote(since)}` : ""} --json > /tmp/plywood-e2e-audit.json`, `node -e ${quote(ROWS_JS)} /tmp/plywood-e2e-audit.json ${wants.map(quote).join(" ")}`].join("\n");
}

/** The script `mcp` runs in a clone of main: the stdio client over `plywood mcp`, with --propose for that tier. */
export function mcpScript(tier: string): string {
  if (tier !== "read-only" && tier !== "propose") throw new Error(`mcp takes read-only or propose, not ${tier}`);
  return `node -e ${quote(MCP_JS)} shop/prod-us plywood mcp${tier === "propose" ? " --propose" : ""}`;
}

/** The `docker` argv that puts a fresh receiver on the bench's network: the old one goes first, with what it held. */
export function receiverArgv(image: string): string[][] {
  return [
    ["docker", "rm", "-f", RECEIVER],
    ["docker", "run", "-d", "--rm", "--name", RECEIVER, "--network", PROJECT, "--entrypoint", "node", image, "-e", RECEIVER_JS, RECEIVED_FILE, String(RECEIVER_PORT)],
  ];
}

/** The `docker exec` argv of one read of the receiver (./probes.ts RECEIVED_JS). */
export function receivedArgv(args: readonly string[]): string[] {
  return ["docker", "exec", RECEIVER, "node", "-e", RECEIVED_JS, RECEIVED_FILE, ...args];
}

/**
 * The script `release` runs in a job container on a clone of main: tag HEAD
 * green the way `chant ci tick` would (an annotated, unsigned `ci/green/<sha>`),
 * cut the release `label` from it, and push the tags. The ledger's push is
 * withForgeLedger's. The cut is a release of the shop repository's
 * components, so it is what `plywood rollback --release` restores. Each line
 * runs only after the one before succeeds, so a refused cut is the step's exit.
 */
export function releaseScript(label: string, by: string): string {
  return [
    'sha="$(git rev-parse HEAD)"',
    'git rev-parse -q --verify "refs/tags/ci/green/$sha" >/dev/null || git tag -a "ci/green/$sha" -m "e2e: green"',
    `chant release cut ${quote(label)} --yes --actor ${quote(by)}`,
    "git push -q origin --tags",
  ].join(" &&\n");
}

/**
 * The release label a scenario names, as this arm cuts it: chant's ledger and
 * the release tags outlive each arm's reset, and a label names one commit, so
 * the arm's start (seconds since the epoch) goes into it. A version label
 * keeps its shape with that number as its major, so `chant release cut auto`
 * has a version to bump. `none` stays `none`.
 */
export function armLabel(label: string, since: string): string {
  if (label === "none") return label;
  const stamp = Math.floor(Date.parse(since) / 1000);
  const version = /^\d+\.(\d+)\.(\d+)$/.exec(label);
  return version ? `${stamp}.${version[1]}.${version[2]}` : `${label}-${stamp}`;
}

/** The script `revoke` runs: tag the commit release `label` was cut from `ci/revoked/<sha>` and push it, as `chant ci tick` revokes a commit that later fails. `none` revokes nothing. */
export function revokeScript(label: string): string {
  if (label === "none") return 'echo "plywood-e2e: no release revoked"';
  return [
    `tag="$(chant release tag ${quote(label)})"`,
    'test -n "$tag"',
    'sha="$(git rev-list -n 1 "$tag")"',
    'git tag -a "ci/revoked/$sha" -m "e2e: revoked"',
    'git push -q origin "refs/tags/ci/revoked/$sha"',
  ].join(" &&\n");
}

/** The script `deploy` runs: `chant run --components all --env <env> --release <label>` at HEAD, the commit the release was cut from, so the environment's ledger names the release. */
export function deployScript(env: string, label: string): string {
  return `chant run --components all --env ${quote(env)} --release ${quote(label)} --yes`;
}

/**
 * The script `rollback` runs: `plywood rollback <env> --release <label>` as
 * `by`. The release gate must wait (exit 3) and print the line that
 * approves it; `approver` approves that line, and the same command runs
 * again with --json, whose document must record the restore (./probes.ts
 * ROLLBACK_JS). Any other exit of the first call, such as chant's refusal of
 * a revoked release, is the script's own.
 */
export function rollbackScript(env: string, label: string, by: string, approver: string): string {
  const ask = `plywood rollback ${quote(env)} --release ${quote(label)} --actor ${quote(by)}`;
  return [
    "code=0",
    `out="$(${ask} 2>&1)" || code=$?`,
    `printf '%s\\n' "$out"`,
    'if [ "$code" != 3 ]; then exit "$code"; fi',
    // The line as chant prints it to a terminal carries colour codes; the words alone are the command.
    `line="$(printf '%s\\n' "$out" | grep -m1 -F 'plywood approve ' | sed "s/$(printf '\\033')\\[[0-9;]*m//g")"`,
    `test -n "$line" || { echo ${quote(`plywood rollback waited without the line that approves it`)} >&2; exit 1; }`,
    'set -- ${line#*plywood }',
    `plywood "$@" --approver ${quote(approver)} --yes`,
    `${ask} --json > /tmp/plywood-e2e-rollback.json`,
    `node -e ${quote(ROLLBACK_JS)} /tmp/plywood-e2e-rollback.json ${quote(env)}`,
  ].join("\n");
}

/** The relay key the bench's alert and agent jobs sign and check facts with. The bench's own, like its passphrase. */
export const ALERT_RELAY_KEY = "plywood-e2e-relay-key";
const ALERT_SECRET = "plywood-e2e-alert-secret";
const RELAY_PORT = 8787;

/** The script `agent-secrets` runs as the admin: the repository's Actions secrets the alert agent's workflow reads (a model key it never uses, and the relay key). */
export function agentSecretsScript(): string {
  const put = (name: string, value: string) =>
    `curl -fsS -X PUT -H "Authorization: token $FORGEJO_TOKEN" -H 'Content-Type: application/json' -d ${quote(JSON.stringify({ data: value }))} "$FORGEJO_SERVER_URL/api/v1/repos/$FORGEJO_REPOSITORY/actions/secrets/${name}"`;
  return ["set -e", put("ANTHROPIC_API_KEY", "unused"), put("CHANT_RELAY_KEY", ALERT_RELAY_KEY)].join("\n");
}

/**
 * The script `alert` runs in a job container on a clone of main: chant's
 * relay on loopback, one signed generic alert posted to it, and the fact the
 * relay recorded read back from chant/lifecycle (`_alerts/alert.jsonl`).
 * The relay has no dispatch token here, so the workflow is started by
 * `agent-run`, as the schedule would start it.
 */
export function alertScript(title: string): string {
  const body = JSON.stringify({ id: "e2e-alert-1", title, severity: "critical", url: "http://alerts.example/e2e-alert-1" });
  return [
    "set -e",
    `export CHANT_RELAY_KEY=${quote(ALERT_RELAY_KEY)} CHANT_ALERT_SECRET=${quote(ALERT_SECRET)}`,
    `chant notify relay --host 127.0.0.1 --port ${RELAY_PORT} > /tmp/plywood-e2e-relay.log 2>&1 &`,
    "relay=$!",
    `for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:${RELAY_PORT}/ && break; sleep 1; done`,
    `body=${quote(body)}`,
    'ts="$(date +%s)"',
    `sig="$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$CHANT_ALERT_SECRET" -hex | sed 's/^.* //')"`,
    `curl -fsS -X POST -H "X-Chant-Timestamp: $ts" -H "X-Chant-Signature: sha256=$sig" -H 'Content-Type: application/json' -d "$body" http://127.0.0.1:${RELAY_PORT}/alert/generic`,
    'kill "$relay" || true',
    "git fetch -q origin chant/lifecycle",
    `git show FETCH_HEAD:_alerts/alert.jsonl | grep -F ${quote(title)}`,
  ].join("\n");
}

/** The workspace member whose agent workflow chant writes as `<member>-<op>.yml`. */
const AGENT_MEMBER = "shop";

/**
 * The script `agent-run` runs as the author: start the alert agent's
 * workflow (`shop-<op>.yml`) on main through Forgejo's dispatch API, then wait up to five
 * minutes for its pull request from `plywood/agent/<op>-<member>`. A
 * repository whose plywood.yml leaves agent.alert off has no such workflow,
 * so the dispatch is refused and the script exits non-zero.
 */
export function agentRunScript(op: string): string {
  const api = '"$FORGEJO_SERVER_URL/api/v1/repos/$FORGEJO_REPOSITORY';
  return [
    "set -e",
    `curl -fsS -X POST -H "Authorization: token $FORGEJO_TOKEN" -H 'Content-Type: application/json' -d '{"ref":"main"}' ${api}/actions/workflows/${AGENT_MEMBER}-${op}.yml/dispatches"`,
    "for i in $(seq 1 60); do",
    `  if curl -fsS -H "Authorization: token $FORGEJO_TOKEN" ${api}/pulls?state=open" | grep -q ${quote(`plywood/agent/${op}`)}; then echo "plywood-e2e: the agent opened its pull request"; exit 0; fi`,
    "  sleep 5",
    "done",
    `echo ${quote(`no pull request from plywood/agent/${op} after five minutes`)} >&2`,
    "exit 1",
  ].join("\n");
}

/** The digest a waiting release gate names on its `release gate: change set <digest> for "<env>"` line, read from `$out`. */
const RELEASE_GATE_DIGEST = `digest="$(printf '%s\\n' "$out" | sed -n 's/.*release gate: change set \\([^ ]*\\) for .*/\\1/p' | head -n 1)"`;

/**
 * The script `deploy-gated` runs: `chant run --components all --env <env>
 * --release <label>` as `by`, as the merge's stand-in for the first
 * environment of promotion. Under a gate that asks, the run waits at the
 * project's component gate (exit 3); `approver` approves it with chant's own
 * line for component `shop`, and the same run goes again.
 */
export function deployGatedScript(env: string, label: string, by: string, approver: string): string {
  const run = `chant run --components all --env ${quote(env)} --release ${quote(label)} --yes --actor ${quote(by)}`;
  return [
    "code=0",
    `${run} || code=$?`,
    'if [ "$code" = 0 ]; then exit 0; fi',
    'if [ "$code" != 3 ]; then exit "$code"; fi',
    `chant approve shop ${RELEASE_GATE} --env ${quote(env)} --approver ${quote(approver)} --yes`,
    run,
  ].join("\n");
}

/**
 * The lines that approve whichever gate a promote waits at, from `$out`:
 * the stage's gate of the pipeline plywood writes under promotion (chant's
 * `chant approve <pipeline> <stage> ... --plan <digest>` line, or the
 * `plywood approve <stage> --plan <digest>` line plywood prints), else the
 * project's release gate (`release gate: change set <digest>`). Exits 1 when
 * the promote waited and named neither.
 */
function approveWaitingGate(what: string, approver: string): string[] {
  return [
    `line="$(printf '%s\\n' "$out" | grep -o 'chant approve [a-z0-9_-]* [a-z0-9_-]*[^\`]*--plan [a-z0-9-]*sha256:[0-9a-f]*' | head -n 1)"`,
    `own="$(printf '%s\\n' "$out" | grep -o 'plywood approve [a-z0-9_-]* --plan [a-z0-9-]*sha256:[0-9a-f]*' | head -n 1)"`,
    RELEASE_GATE_DIGEST,
    `if [ -n "$line" ]; then npx $line --approver ${quote(approver)} --yes;`,
    `elif [ -n "$own" ]; then plywood \${own#plywood } --approver ${quote(approver)} --yes;`,
    `elif [ -n "$digest" ]; then plywood approve ${RELEASE_GATE} --plan "$digest" --approver ${quote(approver)} --yes;`,
    `else echo ${quote(`${what} waited without naming the gate and digest it binds`)} >&2; exit 1; fi`,
  ];
}

/**
 * The script `promote` runs: `plywood promote --to <env> --release <label>
 * --from <from> --json` as `by`. Each time it waits (exit 3), `approver`
 * approves the gate it names: under promotion the pipeline's stage gate
 * first (plywood#156), then the project's release gate; the same command runs
 * again, at most three times. The last document must record the deploy in
 * <env> (./probes.ts PROMOTE_JS). Any other exit, such as chant's refusal of
 * a promote that skips an environment, is the script's own.
 */
export function promoteScript(env: string, label: string, from: string, by: string, approver: string): string {
  const ask = `plywood promote --to ${quote(env)} --release ${quote(label)} --from ${quote(from)} --actor ${quote(by)} --json`;
  return [
    "code=3",
    "round=0",
    'while [ "$code" = 3 ] && [ "$round" -lt 3 ]; do',
    "  round=$((round + 1))",
    "  code=0",
    `  ${ask} > /tmp/plywood-e2e-promote.json 2> /tmp/plywood-e2e-promote.err || code=$?`,
    "  cat /tmp/plywood-e2e-promote.err >&2",
    '  if [ "$code" != 3 ]; then break; fi',
    '  out="$(cat /tmp/plywood-e2e-promote.json /tmp/plywood-e2e-promote.err)"',
    ...approveWaitingGate("plywood promote", approver).map((l) => `  ${l}`),
    "done",
    'if [ "$code" != 0 ]; then exit "$code"; fi',
    `node -e ${quote(PROMOTE_JS)} /tmp/plywood-e2e-promote.json ${quote(env)}`,
  ].join("\n");
}

/**
 * The script `promote-held` runs (plywood#156): `plywood promote --to <env>
 * --release <label> --from <from>` as `by`, approving the gates it waits at
 * as `promote` does, until a soak holds it: the promote must exit 3 with
 * chant's `pipeline-soak-waiting` refusal, and nothing deploys to <env>. A promote that goes
 * through, or stops for another reason, fails the step.
 */
export function promoteHeldScript(env: string, label: string, from: string, by: string, approver: string): string {
  const ask = `plywood promote --to ${quote(env)} --release ${quote(label)} --from ${quote(from)} --actor ${quote(by)}`;
  return [
    "round=0",
    'while [ "$round" -lt 3 ]; do',
    "  round=$((round + 1))",
    "  code=0",
    `  out="$(${ask} 2>&1)" || code=$?`,
    `  printf '%s\\n' "$out"`,
    '  if [ "$code" != 3 ]; then echo "plywood promote exited $code, and a soak holds a promote with 3" >&2; exit 1; fi',
    // chant's refusal code for a promote a soak holds; a line that only reports a finished soak is not one.
    `  if printf '%s\\n' "$out" | grep -q 'pipeline-soak-waiting'; then echo ${quote(`a soak holds the promote into ${env}`)}; exit 0; fi`,
    ...approveWaitingGate("plywood promote", approver).map((l) => `  ${l}`),
    "done",
    `echo ${quote(`plywood promote into ${env} waited at its gates and no soak held it`)} >&2`,
    "exit 1",
  ].join("\n");
}

/**
 * The script `stage-status` runs (plywood#156): `chant workspace status
 * <env> --json` on the forge's ledger, and the stage <env>'s <field> in the
 * member's pipeline must be set (./probes.ts STAGE_JS): `soak`, `risk`,
 * `rollback`, `release`, or `canaryHolds` holding; a value stamped before
 * the arm started is an earlier arm's.
 */
export function stageStatusScript(env: string, field: string, since?: string): string {
  return [`chant workspace status ${quote(env)} --json > /tmp/plywood-e2e-status.json`, `node -e ${quote(STAGE_JS)} /tmp/plywood-e2e-status.json ${quote(env)} ${quote(field)}${since ? ` ${quote(since)}` : ""}`].join("\n");
}

/**
 * The script `pipeline-canary` runs (plywood#156): `plywood pipeline spec
 * --stage <stage>`, the stage's op-waves spec folded from the committed
 * .chant/pipeline.ts, whose first wave must be marked `canary`
 * (./probes.ts CANARY_JS).
 */
export function pipelineCanaryScript(stage: string): string {
  return [`plywood pipeline spec --stage ${quote(stage)} > /tmp/plywood-e2e-stage.json`, `node -e ${quote(CANARY_JS)} /tmp/plywood-e2e-stage.json`].join("\n");
}

/** The commands `plywood-e2e` takes, with their arguments. */
export const COMMANDS: Record<string, string> = {
  "wait-runs": "<op> <count> [<stack>]: wait until the ledger holds <count> wave jobs of <op> since the arm started, only those that targeted <stack> when given",
  disjoint: "<op> <stack> <first> <second>: two jobs wrote one resource each and overlapped (./checks.ts disjointTogether)",
  moved: "<op> <stack>: the newest job refused with chant's moved code (./checks.ts movedNotGated)",
  applied: "<op> <stack>: the newest job applied <stack> with exit 0",
  "locks-seen": ": the lock observer saw no lock-like key in the record store",
  markers: "<stack> <name>: a queue on floci carries plunge's markers for <name>",
  job: "<word>...: the words as a command in a job container on a clone of main",
  "plunge-up": "<stack> <key=value>...: plunge up of <stack> on its store with config set, in a job container; up=false previews instead and writes no record",
  action: "<stack> <name>: plywood action shop/<stack> <name> as the author on the stack's backend, in a job container; a call that waits must print the approve line",
  "approve-pending": "<op>: the reviewer approves the newest pending gate of <op> with the plan it binds",
  configure: "<base overlay>: lay it over main, run plywood init and plywood ci, and push main, in a job container as the admin",
  push: "<branch> <overlay>: push the overlay as one more commit on the arm's pull request branch",
  note: "<branch> <once> <text>...: one comment on the branch's pull request holds <once> and every <text>, and <once> appears once (./checks.ts oneNote)",
  "wait-stacks": "<op> <stack>...: wait until a wave job of <op> since the arm started settled each stack, or one stopped",
  canary: "<op> <first> <then>: <first> updated in an earlier wave, ended before <then> started (./checks.ts canaryFirst)",
  waits: "<op> <stack>: no job applied <stack>, one waits at a wave's own gate (./checks.ts waitsAtGate)",
  "sqs-retention": "<stack> <seconds>: set the stack's events queue's retention on floci by hand, in a job container",
  "drift-job": "<stack>: the scheduled drift job's command for shop/<stack>, in a job container with Forgejo's job variables",
  "drift-issue": "<stack> <name> <attribute>: one open drift issue for shop/<stack> with a row for <name> naming <attribute> (./checks.ts driftIssueHolds)",
  report: "<branch> <plan|apply> <path=value>...: the branch's pull request's report at its head holds each value; an apply report is waited for, since a later /plywood up writes over it (./checks.ts reportHolds)",
  "queue-retention": "<stack> <seconds>: the stack's events queue keeps <seconds> on floci, read in a job container",
  override: "<branch> <reviewer|author> <rule> <reason>...: plywood override of the branch's pull request's op as that person, in a job container",
  overridden: "<branch> <login>: the ledger holds <login>'s reasoned override of the branch's pull request, spent (./checks.ts overrideRecorded)",
  audit: "<approvals|updates|runs|review-stacks> <path=value>...: a row of plywood audit --json in a job container holds each value (./probes.ts ROWS_JS)",
  "job-ledger": "<word>...: as job, with the forge's ledger under the command",
  dora: "<min>: dora.json under the report URL counts <min> deployments or more, and estate.html is there (./checks.ts doraCounts)",
  receiver: ": a fresh receiver on the bench's network (./probes.ts RECEIVER_JS)",
  received: "<trace <service> <stack>|metric <name>|signed <event> <source> <target> <key>>: the receiver holds it, read until it does or a minute passes (./probes.ts RECEIVED_JS)",
  "notify-drift-job": "<stack> <signing key>: the drift-job command with notify's webhook at the receiver, signed with <key>",
  release: "<label>: cut release <label> from main's tip, tagged green first, in a job container as the author",
  revoke: "<label|none>: tag the commit <label> was cut from ci/revoked and push it; none revokes nothing",
  deploy: "<env> <label>: chant run --components all --env <env> --release <label> at main's tip, in a job container, with the forge's ledger under it",
  "deploy-gated": "<env> <label>: chant run --components all --env <env> --release <label> as the author, its component gate approved by the reviewer with chant's own line",
  promote: "<env> <label> <from>: plywood promote --to <env> --release <label> --from <from> as the author, each gate it waits at approved by the reviewer, and the deploy recorded (./probes.ts PROMOTE_JS)",
  "promote-held": "<env> <label> <from>: plywood promote --to <env> as the author, its gates approved by the reviewer, until a soak holds it with exit 3",
  "stage-status": "<env> <field>: chant workspace status <env> --json, and stage <env>'s <field> set in the member's pipeline (./probes.ts STAGE_JS)",
  "pipeline-canary": "<stage>: plywood pipeline spec --stage <stage>, whose first wave is the canary (./probes.ts CANARY_JS)",
  rollback: "<env> <label>: plywood rollback <env> --release <label> as the author, the release gate approved by the reviewer, and the restore recorded (./probes.ts ROLLBACK_JS)",
  "agent-secrets": ": the repository's Actions secrets the alert agent's workflow reads, set as the admin",
  alert: "<title>: chant's relay on loopback in a job container takes one signed generic alert, and its fact is on chant/lifecycle (./ports.ts alertScript)",
  "agent-run": "<op>: start the workflow of agent Op <op> on main and wait for its pull request from plywood/agent/<op> (./ports.ts agentRunScript)",
  mcp: "<read-only|propose>: a stdio client over plywood mcp in a job container: the tools listed, none that writes, and plywood:stacks called (./probes.ts MCP_JS)",
};

const say = (c: CommandContext, r: CheckResult): number => {
  c.safe.log(`plywood-e2e: ${r.code === 0 ? "held" : "did not hold"}: ${r.line}`);
  return r.code;
};

/** Run one `plywood-e2e` command. Resolves with its exit code. */
export async function runCommand(c: CommandContext, words: string[]): Promise<number> {
  const [name, ...a] = words;
  const need = (n: number) => {
    if (a.length < n) throw new Error(`plywood-e2e ${name} takes ${COMMANDS[name ?? ""] ?? "nothing it knows"}`);
  };
  switch (name) {
    case "wait-runs": {
      need(2);
      const want = Number(a[1]);
      // plywood#22 finding 10: with a stack, only the wave jobs that targeted it count.
      const stack = a[2];
      const of = stack ? ` on ${stack}` : "";
      const deadline = c.clock.now() + Math.max(c.waitLimit - 30, 30) * 1000;
      for (;;) {
        const n = finishedRuns(await c.ledger.runs(c.env, a[0]!), a[0]!, c.since(), true, stack);
        if (n >= want) return say(c, { code: 0, line: `${n} ${a[0]} wave jobs${of} on the ledger` });
        // Inside the step's own limit, so a wait that gives up breaks the arm and does not stall it.
        if (c.clock.now() >= deadline) return say(c, { code: 124, line: `${n} of ${want} ${a[0]} wave jobs${of} after ${c.waitLimit}s` });
        await c.clock.sleep(5000);
      }
    }
    case "disjoint":
      need(4);
      return say(c, disjointTogether(await c.ledger.runs(c.env, a[0]!), { op: a[0]!, since: c.since(), stack: a[1]!, first: a[2]!, second: a[3]! }));
    case "moved":
      need(2);
      return say(c, movedNotGated(await c.ledger.runs(c.env, a[0]!), { op: a[0]!, since: c.since(), stack: a[1]! }));
    case "applied": {
      need(2);
      const runs = waveRuns(await c.ledger.runs(c.env, a[0]!), a[0]!, c.since()).filter((r) => stackTarget(r, a[1]!));
      const last = runs[runs.length - 1];
      if (!last) return say(c, { code: 1, line: `no ${a[0]} job on ${a[1]} since the arm started` });
      const applied = last.wave!.exitCode === EXIT.done && last.wave!.applied.some((t) => targetIsStack(t, a[1]!));
      return say(c, { code: applied ? 0 : 1, line: `the newest ${a[0]} job on ${a[1]} exited ${last.wave!.exitCode}${applied ? " and applied it" : ""}` });
    }
    case "locks-seen":
      return say(c, c.observer.result());
    case "markers": {
      need(2);
      const queues = await (c.queueTags ?? (() => sqsQueueTags(c.floci)))();
      const hit = queues.find((q) => hasMarkers(q.tags, a[1]!, a[0]!));
      return say(c, hit ? { code: 0, line: `${hit.url} carries plunge-stack and plunge-urn for ${a[1]}` } : { code: 1, line: `no queue on floci carries plunge's markers for ${a[1]} in ${a[0]}` });
    }
    case "job":
      need(1);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author }, withForgeLedger(a.map(quote).join(" "))));
    case "plunge-up": {
      need(1);
      const [stack, ...all] = a;
      // `up=false` makes the update a preview, which writes no record: a BREAK arm's "another update" that moves nothing.
      const sets = all.filter((kv) => kv !== "up=true" && kv !== "up=false");
      const writes = !all.includes("up=false");
      const config = sets.map((kv) => {
        const i = kv.indexOf("=");
        if (i < 1) throw new Error(`plunge-up takes key=value, not ${kv}`);
        return `plunge config set --stack ${quote(stack!)} ${quote(kv.slice(0, i))} ${quote(kv.slice(i + 1))}`;
      });
      const script = [...config, writes ? `plunge up --yes --non-interactive --stack ${quote(stack!)}` : `plunge preview --non-interactive --stack ${quote(stack!)}`].join("\n");
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author, env: { PULUMI_BACKEND_URL: plungeStoreUrl(BUCKETS.records, FLOCI_NET) } }, script));
    }
    case "action": {
      need(2);
      const env = { PULUMI_BACKEND_URL: stockBackend(a[0]!) };
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author, env }, withForgeLedger(actionScript(a[0]!, a[1]!, c.author.login))));
    }
    case "release":
      need(1);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author }, withForgeLedger(releaseScript(armLabel(a[0]!, c.since()), c.author.login))));
    case "revoke":
      need(1);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author }, withForgeLedger(revokeScript(armLabel(a[0]!, c.since())))));
    case "deploy":
      need(2);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author, env: { PULUMI_BACKEND_URL: stockBackend("prod-us") } }, withForgeLedger(deployScript(a[0]!, armLabel(a[1]!, c.since())))));
    case "deploy-gated":
      need(2);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author, env: { PULUMI_BACKEND_URL: stockBackend("prod-us") } }, withForgeLedger(deployGatedScript(a[0]!, armLabel(a[1]!, c.since()), c.author.login, c.reviewer.login))));
    case "promote":
      need(3);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author, env: { PULUMI_BACKEND_URL: stockBackend("prod-us") } }, withForgeLedger(promoteScript(a[0]!, armLabel(a[1]!, c.since()), a[2]!, c.author.login, c.reviewer.login))));
    case "promote-held":
      need(3);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author, env: { PULUMI_BACKEND_URL: stockBackend("prod-us") } }, withForgeLedger(promoteHeldScript(a[0]!, armLabel(a[1]!, c.since()), a[2]!, c.author.login, c.reviewer.login))));
    case "stage-status":
      need(2);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author }, withForgeLedger(stageStatusScript(a[0]!, a[1]!, c.since()))));
    case "pipeline-canary":
      need(1);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author }, pipelineCanaryScript(a[0]!)));
    case "rollback":
      need(2);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author, env: { PULUMI_BACKEND_URL: stockBackend("prod-us") } }, withForgeLedger(rollbackScript(a[0]!, armLabel(a[1]!, c.since()), c.author.login, c.reviewer.login))));
    case "approve-pending": {
      need(1);
      const p = await c.ledger.pending(a[0]!, c.since());
      if (!p) return say(c, { code: 1, line: `no pending gate of ${a[0]} since the arm started` });
      if (!p.planDigest) return say(c, { code: 1, line: `${a[0]}'s gate ${p.gate} binds no plan to approve` });
      const script = `plywood approve ${quote(p.gate)} --op ${quote(a[0]!)} --plan ${quote(p.planDigest)} --approver ${quote(c.reviewer.login)} --yes`;
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.reviewer }, withForgeLedger(script)));
    }
    case "configure": {
      need(1);
      if (!c.overlay || !c.admin) throw new Error("plywood-e2e configure needs the admin and the overlays");
      const files = Buffer.from(JSON.stringify(c.overlay(a[0]!, "base")), "utf8").toString("base64");
      configuredAt = new Date(c.clock.now()).toISOString();
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.admin, env: { PLYWOOD_E2E_FILES: files } }, configureScript(a[0]!)));
    }
    case "push": {
      need(2);
      if (!c.overlay || !c.pushBranch) throw new Error("plywood-e2e push needs the overlays and the forge");
      const branch = armBranch(a[0]!, c.armEnv());
      const sha = await c.pushBranch(branch, c.overlay(a[1]!, "pull"), `e2e: ${a[1]} on ${branch}`);
      return say(c, { code: 0, line: `pushed ${a[1]} on ${branch} at ${sha.slice(0, 10)}` });
    }
    case "note": {
      need(3);
      if (!c.pullComments) throw new Error("plywood-e2e note needs the forge's comments");
      const branch = armBranch(a[0]!, c.armEnv());
      const deadline = c.clock.now() + Math.max(c.waitLimit - 30, 30) * 1000;
      for (;;) {
        const bodies = (await c.pullComments(branch)) ?? [];
        const r = oneNote(bodies, { once: a[1]!, holds: a.slice(2) });
        if (r.code === 0 || c.clock.now() >= deadline) return say(c, r);
        await c.clock.sleep(5000);
      }
    }
    case "wait-stacks": {
      need(2);
      const [op, ...stacks] = a;
      const deadline = c.clock.now() + Math.max(c.waitLimit - 30, 30) * 1000;
      for (;;) {
        const runs = waveRuns(await c.ledger.runs(c.env, op!), op!, c.since());
        const settled = (s: string) => runs.some((r) => stackTarget(r, s) || [...r.wave!.applied, ...r.wave!.failed, ...r.wave!.moved].some((t) => targetIsStack(t, s)));
        const stopped = runs.find((r) => r.status !== "ok");
        if (stacks.every(settled)) return say(c, { code: 0, line: `${stacks.join(", ")} settled by ${runs.length} ${op} wave jobs` });
        if (stopped) return say(c, { code: 0, line: `wave ${stopped.wave!.number} of ${op} stopped ${stopped.status} (exit ${stopped.wave!.exitCode}); the next check reads why` });
        if (c.clock.now() >= deadline) return say(c, { code: 124, line: `${stacks.filter((s) => !settled(s)).join(", ")} not settled after ${c.waitLimit}s` });
        await c.clock.sleep(5000);
      }
    }
    case "canary":
      need(3);
      return say(c, canaryFirst(await c.ledger.runs(c.env, a[0]!), { op: a[0]!, since: c.since(), first: a[1]!, then: a[2]! }));
    case "waits":
      need(2);
      return say(c, waitsAtGate(await c.ledger.runs(c.env, a[0]!), { op: a[0]!, since: c.since(), stack: a[1]! }, await c.ledger.pending(a[0]!, c.since())));
    case "sqs-retention":
      need(2);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author }, retentionScript(a[0]!, a[1]!)));
    case "drift-job": {
      need(1);
      const env = { FORGEJO_SERVER_URL: FORGEJO_NET, FORGEJO_REPOSITORY: `${ORG}/${REPO}`, FORGEJO_TOKEN: c.author.token };
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author, env }, driftJobScript(a[0]!)));
    }
    case "drift-issue": {
      need(3);
      if (!c.issues) throw new Error("plywood-e2e drift-issue needs the forge's issues");
      return say(c, driftIssueHolds(await c.issues(), { title: driftIssueTitle(`shop/${a[0]}`), name: a[1]!, attribute: a[2]! }));
    }
    case "report": {
      need(3);
      if (!c.pullReport) throw new Error("plywood-e2e report needs the reports");
      const [, stage, ...wants] = a;
      if (stage !== "plan" && stage !== "apply") throw new Error(`report takes plan or apply, not ${stage}`);
      const branch = armBranch(a[0]!, c.armEnv());
      const deadline = c.clock.now() + Math.max(c.waitLimit - 30, 30) * 1000;
      for (;;) {
        const report = await c.pullReport(branch, stage);
        const r: CheckResult = report === undefined ? { code: 1, line: `no pr-${stage}.json at the head of ${branch}` } : reportHolds(report, wants);
        // A plan report stands once the driver read it; an apply report is written over by the next /plywood up.
        if (r.code === 0 || stage === "plan" || c.clock.now() >= deadline) return say(c, r);
        await c.clock.sleep(5000);
      }
    }
    case "queue-retention":
      need(2);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author }, queueRetentionScript(a[0]!, a[1]!)));
    case "override": {
      need(4);
      if (!c.pullReport) throw new Error("plywood-e2e override needs the reports");
      const [, who, rule, ...reason] = a;
      if (who !== "reviewer" && who !== "author") throw new Error(`override takes reviewer or author, not ${who}`);
      const plan = (await c.pullReport(armBranch(a[0]!, c.armEnv()), "plan")) as { op?: string } | undefined;
      if (!plan?.op) return say(c, { code: 1, line: `no plan report names ${a[0]}'s op` });
      const person = c[who];
      const line = `plywood override ${quote(plan.op)} --rule ${quote(rule!)} --reason ${quote(reason.join(" "))} --approver ${quote(person.login)}`;
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person }, withForgeLedger(line)));
    }
    case "overridden": {
      need(2);
      if (!c.pullReport || !c.ledger.overrides) throw new Error("plywood-e2e overridden needs the reports and the ledger");
      const plan = (await c.pullReport(armBranch(a[0]!, c.armEnv()), "plan")) as { op?: string } | undefined;
      if (!plan?.op) return say(c, { code: 1, line: `no plan report names ${a[0]}'s op` });
      return say(c, overrideRecorded(await c.ledger.overrides(), { subject: plan.op, by: a[1]! }));
    }
    case "audit":
      need(2);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author }, withForgeLedger(auditScript(a[0]!, a.slice(1), configuredAt))));
    case "job-ledger":
      need(1);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author }, withForgeLedger(a.map(quote).join(" "))));
    case "dora": {
      need(1);
      if (!c.report) throw new Error("plywood-e2e dora needs the reports");
      const text = await c.report("estate/dora.json");
      return say(c, doraCounts(text === null ? null : (JSON.parse(text) as Parameters<typeof doraCounts>[0]), await c.report("estate/estate.html"), Number(a[0])));
    }
    case "receiver": {
      const [gone, start] = receiverArgv(c.jobImage);
      await c.safe.run(gone!);
      return c.safe.run(start!);
    }
    case "received": {
      need(2);
      // A wave job records its run before it sends its trace (op-waves-run.ts closeOpWaveEvents).
      const deadline = c.clock.now() + 60_000;
      for (;;) {
        const code = await c.safe.run(receivedArgv(a));
        if (code === 0 || c.clock.now() >= deadline) return code;
        await c.clock.sleep(5000);
      }
    }
    case "notify-drift-job": {
      need(2);
      const env = { FORGEJO_SERVER_URL: FORGEJO_NET, FORGEJO_REPOSITORY: `${ORG}/${REPO}`, FORGEJO_TOKEN: c.author.token, PLYWOOD_E2E_HOOK_URL: `${RECEIVER_URL}/hook`, PLYWOOD_E2E_HOOK_KEY: a[1]! };
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author, env }, driftJobScript(a[0]!)));
    }
    case "agent-secrets": {
      if (!c.admin) throw new Error("plywood-e2e agent-secrets needs the admin");
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.admin, env: { FORGEJO_SERVER_URL: FORGEJO_NET, FORGEJO_REPOSITORY: `${ORG}/${REPO}`, FORGEJO_TOKEN: c.admin.token } }, agentSecretsScript()));
    }
    case "alert":
      need(1);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author }, withForgeLedger(alertScript(a.join(" ")))));
    case "agent-run": {
      need(1);
      const env = { FORGEJO_SERVER_URL: FORGEJO_NET, FORGEJO_REPOSITORY: `${ORG}/${REPO}`, FORGEJO_TOKEN: c.author.token };
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author, env }, agentRunScript(a[0]!)));
    }
    case "mcp":
      need(1);
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author }, mcpScript(a[0]!)));
    default:
      throw new Error(`plywood-e2e has no command ${name ?? "(none)"}; it takes ${Object.keys(COMMANDS).join(", ")}`);
  }
}

/** The out-of-band port: `plywood-e2e` words in process, the rest through SafeRun, `${NAME}` expanded from the arm. */
export function outOfBand(c: CommandContext): { run(command: string[]): Promise<number> } {
  return {
    run: (command) => {
      const words = command.map((w) => expandWord(w, c.armEnv()));
      c.safe.log(`plywood-e2e: out of band: ${words.join(" ")}`);
      return words[0] === "plywood-e2e" ? runCommand(c, words.slice(1)) : c.safe.run(words);
    },
  };
}

// ── chant ───────────────────────────────────────────────────────────────

/** `plywood approve` as the reviewer, in a job container, for the driver's approve step. */
export function reviewerChant(c: Pick<CommandContext, "h" | "safe" | "jobImage" | "reviewer">): { approve(input: ApproveInput): Promise<void> } {
  return {
    async approve(i) {
      const script = `plywood approve ${quote(i.gate)} --op ${quote(i.op)} --plan ${quote(i.digest)} --approver ${quote(i.approver)} --yes`;
      const code = await c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.reviewer, env: { PR_NUMBER: String(i.pull) } }, script));
      if (code !== 0) throw new Error(`plywood approve ${i.gate} --op ${i.op} exited ${code}`);
    },
  };
}

// ── main as the admin ───────────────────────────────────────────────────

/** Commit `files` over main as the admin and push it: a base overlay for a BREAK arm. Returns the new sha. */
export function pushOverMain(o: { forgeUrl: string; admin: Person; scratch: string; files: Record<string, string>; message: string }): Promise<string> {
  return pushOverBranch({ forgeUrl: o.forgeUrl, person: o.admin, scratch: o.scratch, branch: "main", files: o.files, message: o.message });
}

/** Commit `files` over `branch` as `person` and push it. Returns the new sha. */
export async function pushOverBranch(o: { forgeUrl: string; person: Person; scratch: string; branch: string; files: Record<string, string>; message: string }): Promise<string> {
  mkdirSync(o.scratch, { recursive: true });
  const dir = mkdtempSync(join(o.scratch, "push-"));
  const u = new URL(o.forgeUrl);
  u.username = o.person.login;
  u.password = o.person.token;
  u.pathname = `/${ORG}/${REPO}.git`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const redact = [o.person.token];
  await sh("git", ["clone", "-q", "--branch", o.branch, u.toString(), dir], { env, redact });
  for (const [path, content] of Object.entries(o.files)) {
    const to = join(dir, ...path.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, content);
  }
  await sh("git", ["-C", dir, "add", "-A"], { env });
  await sh("git", ["-C", dir, "-c", `user.name=${o.person.login}`, "-c", `user.email=${o.person.login}@plywood-tutorial.local`, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", o.message], { env });
  await sh("git", ["-C", dir, "push", "-q", "origin", `HEAD:refs/heads/${o.branch}`], { env, redact });
  return (await sh("git", ["-C", dir, "rev-parse", "HEAD"], { env })).trim();
}

/** The arm port: the arm's environment, a base overlay on main, and the lock observer. */
export function armPort(o: {
  baseOverlays: string;
  repoDir: string;
  observer: Pick<LockObserver, "start">;
  setArm(arm: Arm, env: Record<string, string>): void;
  push(files: Record<string, string>, message: string): Promise<string>;
}): (arm: Arm, env: Record<string, string>) => Promise<void> {
  return async (arm, env) => {
    o.setArm(arm, env);
    const name = env.PLYWOOD_E2E_BASE_OVERLAY;
    if (name) await o.push(overlayFiles(readOverlay(o.baseOverlays, name), o.repoDir), `e2e ${arm} arm: base overlay ${name}`);
    o.observer.start();
  };
}
