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
import { actionScript } from "./action";
import { BUCKETS, FLOCI_NET, FORGEJO_NET, ORG, PROJECT, REPO, jobEnv, plungeStoreUrl, s3BackendUrl } from "./bench";
import {
  canaryFirst,
  disjointTogether,
  driftIssueHolds,
  expandWord,
  finishedRuns,
  hasMarkers,
  lockishKeys,
  movedNotGated,
  oneNote,
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
    "npm ci --no-audit --no-fund >/dev/null",
    script,
  ].join("\n");
  return ["docker", "run", "--rm", "--network", PROJECT, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "--entrypoint", "sh", c.image, "-c", body];
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
  ledger: Pick<ForgeLedger, "runs" | "pending">;
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
 * the base overlay's files, run `plywood ci` as a person would after editing
 * plywood.yml (the waves spec, the workflow and any drift jobs written
 * again), and push main. The commit says [skip ci] so the push starts no
 * waves job of its own.
 */
export function configureScript(name: string): string {
  return [
    WRITE_FILES,
    `PULUMI_BACKEND_URL=${quote(s3BackendUrl(BUCKETS.state, FLOCI_NET))} plywood ci --forge forgejo`,
    "git add -A",
    `git commit -q -m ${quote(`e2e: plywood.yml from base overlay ${name}, and plywood ci [skip ci]`)} || true`,
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

/** The commands `plywood-e2e` takes, with their arguments. */
export const COMMANDS: Record<string, string> = {
  "wait-runs": "<op> <count> [<stack>]: wait until the ledger holds <count> wave jobs of <op> since the arm started, only those that targeted <stack> when given",
  disjoint: "<op> <stack> <first> <second>: two jobs wrote one resource each and overlapped (./checks.ts disjointTogether)",
  moved: "<op> <stack>: the newest job refused with chant's moved code (./checks.ts movedNotGated)",
  applied: "<op> <stack>: the newest job applied <stack> with exit 0",
  "locks-seen": ": the lock observer saw no lock-like key in the record store",
  markers: "<stack> <name>: a queue on floci carries plunge's markers for <name>",
  job: "<word>...: the words as a command in a job container on a clone of main",
  "plunge-up": "<stack> <key=value>...: plunge up of <stack> on its store with config set, in a job container",
  action: "<stack> <name>: plywood action shop/<stack> <name> as the author on the stack's backend, in a job container; a call that waits must print the approve line",
  "approve-pending": "<op>: the reviewer approves the newest pending gate of <op> with the plan it binds",
  configure: "<base overlay>: lay it over main, run plywood ci and push main, in a job container as the admin",
  push: "<branch> <overlay>: push the overlay as one more commit on the arm's pull request branch",
  note: "<branch> <once> <text>...: one comment on the branch's pull request holds <once> and every <text>, and <once> appears once (./checks.ts oneNote)",
  "wait-stacks": "<op> <stack>...: wait until a wave job of <op> since the arm started settled each stack, or one stopped",
  canary: "<op> <first> <then>: <first> updated in an earlier wave, ended before <then> started (./checks.ts canaryFirst)",
  waits: "<op> <stack>: no job applied <stack>, one waits at a wave's own gate (./checks.ts waitsAtGate)",
  "sqs-retention": "<stack> <seconds>: set the stack's events queue's retention on floci by hand, in a job container",
  "drift-job": "<stack>: the scheduled drift job's command for shop/<stack>, in a job container with Forgejo's job variables",
  "drift-issue": "<stack> <name> <attribute>: one open drift issue for shop/<stack> with a row for <name> naming <attribute> (./checks.ts driftIssueHolds)",
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
      const deadline = c.clock.now() + c.waitLimit * 1000;
      for (;;) {
        const n = finishedRuns(await c.ledger.runs(c.env, a[0]!), a[0]!, c.since(), true, stack);
        if (n >= want) return say(c, { code: 0, line: `${n} ${a[0]} wave jobs${of} on the ledger` });
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
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author }, a.map(quote).join(" ")));
    case "plunge-up": {
      need(1);
      const [stack, ...sets] = a;
      const config = sets.map((kv) => {
        const i = kv.indexOf("=");
        if (i < 1) throw new Error(`plunge-up takes key=value, not ${kv}`);
        return `plunge config set --stack ${quote(stack!)} ${quote(kv.slice(0, i))} ${quote(kv.slice(i + 1))}`;
      });
      const script = [...config, `plunge up --yes --non-interactive --stack ${quote(stack!)}`].join("\n");
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author, env: { PULUMI_BACKEND_URL: plungeStoreUrl(BUCKETS.records, FLOCI_NET) } }, script));
    }
    case "action": {
      need(2);
      const env = { PULUMI_BACKEND_URL: stockBackend(a[0]!) };
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.author, env }, actionScript(a[0]!, a[1]!, c.author.login)));
    }
    case "approve-pending": {
      need(1);
      const p = await c.ledger.pending(a[0]!, c.since());
      if (!p) return say(c, { code: 1, line: `no pending gate of ${a[0]} since the arm started` });
      if (!p.planDigest) return say(c, { code: 1, line: `${a[0]}'s gate ${p.gate} binds no plan to approve` });
      const script = `plywood approve ${quote(p.gate)} --op ${quote(a[0]!)} --plan ${quote(p.planDigest)} --approver ${quote(c.reviewer.login)} --yes`;
      return c.safe.run(jobArgv(c.h, { image: c.jobImage, person: c.reviewer }, script));
    }
    case "configure": {
      need(1);
      if (!c.overlay || !c.admin) throw new Error("plywood-e2e configure needs the admin and the overlays");
      const files = Buffer.from(JSON.stringify(c.overlay(a[0]!, "base")), "utf8").toString("base64");
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
  await sh("git", ["-C", dir, "-c", `user.name=${o.person.login}`, "-c", `user.email=${o.person.login}@plywood-tutorial.local`, "-c", "commit.gpgsign=false", "commit", "-q", "-m", o.message], { env });
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
