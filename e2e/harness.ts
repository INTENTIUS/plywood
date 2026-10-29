/**
 * chant's e2e harness (`@intentius/chant/e2e-harness`, chant#4587), as the
 * plywood bench reaches it. It is imported on first use, so commands that
 * never touch the harness do not load it.
 *
 * The types below are the part of the harness the bench calls. They follow
 * packages/core/src/e2e-harness/ at chant 88cd947616.
 */

/** A compose service as the harness's `harnessStack` returns it. */
export interface HarnessServiceSpec {
  image: string;
  container_name: string;
  profiles?: string[];
  user?: string;
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  working_dir?: string;
  command?: string[];
  depends_on?: Record<string, { condition: "service_started" | "service_healthy" }>;
  networks: Record<string, { aliases: string[] }>;
  healthcheck?: { test: string[]; interval: string; timeout: string; retries: number };
  restart?: string;
}

export interface HarnessStackShape {
  project: string;
  network: { name: string };
  networkKey: string;
  volumes: { forgejoData: { name: string }; runnerData: { name: string } };
  services: Record<"floci" | "forgejo" | "forgejoRunner" | "clickhouse" | "postgres", HarnessServiceSpec>;
  portVars: Record<"floci" | "forgejo" | "clickhouse" | "postgres", string>;
}

export interface HarnessStackOptions {
  project: string;
  envPrefix?: string;
  ports?: Partial<Record<"floci" | "forgejo" | "clickhouse" | "postgres", number>>;
  bind?: string | null;
  forgejoActions?: boolean;
}

/** A run record on chant's ledger, the fields the bench reads (chant `OpRunRecord`). */
export interface LedgerRecord {
  id: string;
  op: string;
  env: string;
  started: string;
  ended: string;
  status: "ok" | "fail" | "gated" | "waiting";
  labels?: Record<string, string>;
  outcomes?: Record<string, unknown>;
  gitSha?: string;
  gate?: { name: string; since: string; op?: string };
  wave?: {
    spec: string;
    number: number;
    name: string;
    job: string;
    digest?: string;
    exitCode: number;
    outcome?: "held" | "stood-down";
    applied: string[];
    failed: string[];
    moved: string[];
    targets?: Record<string, { startedAt: string; durationMs: number; attributes?: Record<string, string | number | boolean>; spans?: TimedSpan[] }>;
  };
}

/** A trace span chant keeps on a run target (chant `CapabilityTraceSpan`). */
export interface TimedSpan {
  name: string;
  startedAt: string;
  durationMs: number;
  attributes?: Record<string, string | number | boolean>;
  failed?: boolean;
  children?: TimedSpan[];
}

export type ScenarioOutcome =
  | { report: { status?: string; components?: Record<string, string>; only?: boolean } }
  | { ledger: { op: string; status?: "ok" | "fail" | "gated" | "waiting"; count?: number } }
  | { comment: string }
  | { issue: { title: string; open?: boolean } }
  | { exit: number };

interface StepBase {
  id: string;
  label?: string;
  expect?: ScenarioOutcome[];
}

export type ScenarioStep =
  | (StepBase & { do: "open" | "open-concurrent"; branch: string; overlay: string; title: string; body?: string })
  | (StepBase & { do: "plan" | "approve" | "merge"; pull: string })
  | (StepBase & { do: "apply"; merge: string })
  | (StepBase & { do: "out-of-band"; command: string[] })
  | (StepBase & { do: "kill-job"; match?: string });

/** e2e-scenario/v1. */
export interface Scenario {
  $schema: string;
  contract: 1;
  id: string;
  product: string;
  claim: string;
  title?: string;
  tree: { base: string; overlays?: string };
  env?: string;
  reportUrl: string;
  limits?: Record<string, number>;
  steps: ScenarioStep[];
  break: { env: { BREAK: "1" } & Record<string, string>; overlay?: string; note?: string };
}

export type Arm = "plain" | "break";

export interface ArmRun {
  scenario: string;
  arm: Arm;
  outcome: "held" | "broke" | "stalled";
  reason?: string;
  started: string;
  ended: string;
  steps: Array<{ id: string; do: string; pull?: number; commit?: string; stopped?: { outcome: "broke" | "stalled"; reason: string } }>;
}

export interface ClaimRun {
  plain: ArmRun;
  break: ArmRun;
  verdicts: { plain: "pass" | "fail"; break: "caught" | "missed" | "stalled" };
}

export interface ClaimRow {
  $schema: string;
  contract: 1;
  product: string;
  productCommit: string;
  scenario: string;
  claim: string;
  engine: { binary: string; version: string };
  floci: string;
  chant?: string;
  date: string;
  plain: "pass" | "fail";
  break: "caught" | "missed" | "stalled";
  safeRun: "CLEAN";
  runUrl?: string;
}

export interface ClaimsDoc {
  $schema: string;
  contract: 1;
  product: string;
  rows: ClaimRow[];
}

/** The harness's bucket port, keys below the bucket's root. */
export interface BucketPort {
  get(key: string): Promise<string | null>;
  put(key: string, body: string, contentType: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface PullForgePort {
  pushBranch(branch: string, files: Record<string, string>, message: string): Promise<string>;
  openPull(branch: string, title: string, body: string): Promise<number>;
  approvePull(pull: number, body: string): Promise<void>;
  mergePull(pull: number): Promise<string>;
  openPulls(): Promise<number[]>;
  closePull(pull: number): Promise<void>;
  forceMain(sha: string): Promise<void>;
  branches(): Promise<string[]>;
  deleteBranch(name: string): Promise<void>;
  comments?(pull: number): Promise<string[]>;
  issues?(): Promise<Array<{ number: number; title: string; body: string; open: boolean }>>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ApproveInput {
  pull: number;
  op: string;
  gate: string;
  digest: string;
  approver: string;
}

/** The ports `runClaim` takes (chant `DriverPorts`). */
export interface DriverPorts {
  forge: PullForgePort;
  bucket: BucketPort;
  chant: { approve(input: ApproveInput): Promise<void> };
  clock: Clock;
  overlay(name: string): Record<string, string>;
  ledger?: { runs(env: string, op: string): Promise<LedgerRecord[]> };
  jobs?: { kill(match?: string): Promise<boolean> };
  outOfBand?: { run(command: string[]): Promise<number> };
  reset?(): Promise<void>;
  arm?(arm: Arm, env: Record<string, string>): Promise<void>;
  log?: (line: string) => void;
}

export interface Person {
  login: string;
  token: string;
}

export interface SafeRunInstance {
  readonly env: Record<string, string>;
  readonly logFile: string;
  log(line: string): void;
  run(command: string[], extra?: Record<string, string>): Promise<number>;
  scan(extraDirs?: string[]): { verdict: "CLEAN" } | { verdict: "REAL-CLOUD"; hits: string[] };
}

/** The part of `@intentius/chant/e2e-harness` the plywood bench calls. */
export interface HarnessModule {
  E2E_HARNESS_FLOOR: string;
  FLOCI_DIGEST: string;
  FLOCI_IMAGE: string;
  E2E_CLAIMS_SCHEMA: string;
  CLAIM_OP: string;
  HARNESS_HOSTS: { floci: string; forgejo: string };
  RUNNER_JOB_ENV: Record<string, string>;
  harnessStack(o: HarnessStackOptions): HarnessStackShape;
  harnessUrls(s: Pick<HarnessStackShape, "portVars">, env?: Record<string, string | undefined>, defaults?: Record<string, number>): Record<"floci" | "forgejo" | "clickhouse" | "postgres", string>;
  lintScenario(data: unknown): Array<{ at: string; message: string }>;
  loadScenario(path: string): Scenario;
  runClaim(s: Scenario, p: DriverPorts, opts: { approver: string; pollMs?: number }): Promise<ClaimRun>;
  claimRow(i: {
    scenario: Pick<Scenario, "id" | "product" | "claim">;
    productCommit: string;
    engine: { binary: string; version: string };
    verdicts: ClaimRun["verdicts"];
    at: Date;
    floci?: string;
    chant?: string;
    runUrl?: string;
  }): ClaimRow;
  claimRowsOf(records: readonly LedgerRecord[]): ClaimRow[];
  renderClaims(product: string, rows: readonly ClaimRow[]): ClaimsDoc;
  recordClaimRow(i: {
    row: ClaimRow;
    run: ClaimRun;
    verdict: ReturnType<SafeRunInstance["scan"]>;
    append(input: unknown): Promise<void>;
    env?: string;
    gitSha?: string;
  }): Promise<unknown>;
  validateClaims(data: unknown): { ok: true; value: ClaimsDoc } | { ok: false; errors: string[] };
  SafeRun: new (o: { scratch: string; extra?: Record<string, string>; logFile?: string; scan?: string[] }) => SafeRunInstance;
  FlociBucket: new (endpoint: string, bucket: string) => BucketPort & { create(): Promise<void> };
  ForgejoForge: new (o: {
    url: string;
    repo: string;
    admin: Person;
    author: Person;
    reviewer: Person;
    baseTree: string;
    clock: Clock;
    checkout?: string;
    emailDomain?: string;
  }) => PullForgePort & { comments(pull: number): Promise<string[]>; issues(): Promise<Array<{ number: number; title: string; body: string; open: boolean }>> };
  forgejoApi<T = unknown>(
    url: string,
    token: string,
    method: string,
    path: string,
    body?: unknown,
    opts?: { missingOk?: boolean; basic?: { login: string; password: string } },
  ): Promise<T | null>;
  registerForgejoRunner(o: {
    url: string;
    adminToken: string;
    name: string;
    network: string;
    jobImage: string;
    capacity?: number;
    envs?: Record<string, string>;
    writeConfig(text: string): Promise<void>;
    restart(): Promise<void>;
  }): Promise<{ uuid: string }>;
  dockerJobs(network: string): { kill(match?: string): Promise<boolean> };
  realClock: Clock;
}

let loaded: Promise<HarnessModule> | undefined;

/** chant's e2e harness, loaded on first use. */
export function harness(): Promise<HarnessModule> {
  loaded ??= import("@intentius/chant/e2e-harness").then((m) => m as unknown as HarnessModule);
  return loaded;
}

/** Tests stand in a harness; `reset` goes back to the real import. */
export function setHarnessForTests(fake: HarnessModule | "reset"): void {
  loaded = fake === "reset" ? undefined : Promise.resolve(fake);
}
