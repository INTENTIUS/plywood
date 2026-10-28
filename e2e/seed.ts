/**
 * The bench's seed on chant's harness (plywood#25): what plywood keeps of
 * its own bench, ruling F. The harness brings floci, Forgejo and the runner;
 * the seed brings plywood's repository and people:
 *
 *   buckets    plunge's record store, set up the way plunge#34 requires
 *              (./secure-bucket.ts), the stock state bucket, the reports
 *              bucket and a bare bucket for pw-adopt's BREAK arm
 *   people     an admin, the author tutor and a reviewer, each with a token
 *   runner     forgejo-runner registered the harness's way, every job in
 *              the job image (bench.ts JOB_IMAGE) with the bench's job env
 *   tutor/shop the plunge corpus's aws-ts program, built by
 *              stack/seed-repo.sh (the repo setup of stack/seed.sh), with
 *              e2e/scenarios/base/plywood.yml, then in a job container:
 *              dev created and deployed on plunge's store, staging deployed
 *              on stock Pulumi for pw-adopt, prod-us and prod-eu created,
 *              and `plywood init --forge forgejo --yes`, which writes the
 *              pull request workflow wired to plywood's verbs
 *
 * aws-ts teardown is refused on the pinned floci (SSM tags, lex00/floci#263),
 * so a reset never destroys: it restarts floci, which keeps nothing, and
 * runs the cloud part of the seed again.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUCKETS,
  EMAIL_DOMAIN,
  FLOCI_NET,
  JOB_IMAGE,
  ORG,
  PEOPLE,
  PLUNGE_REF,
  PROJECT,
  REPO,
  RUNNER_NAME,
  benchStack,
  composeDoc,
  hostUrls,
  jobEnv,
  plungeStoreUrl,
  s3BackendUrl,
} from "./bench";
import type { HarnessModule, Person } from "./harness";
import { jobArgv, sh } from "./ports";
import { makeBucket } from "./secure-bucket";

export interface BenchState {
  admin: Person;
  author: Person;
  reviewer: Person;
  /** main after the seed: what every arm resets to. */
  baseSha: string;
}

export interface SeedContext {
  h: HarnessModule;
  /** The plywood checkout. */
  root: string;
  /** The bench's state directory (bench.ts stateDir). */
  state: string;
  log(line: string): void;
  /** Runs a command through the harness's SafeRun, so its output is scanned. */
  run(command: string[]): Promise<number>;
}

export const composeFile = (state: string): string => join(state, "compose.json");
export const shopDir = (state: string): string => join(state, REPO);
const stateFile = (state: string): string => join(state, "bench.json");

export function readBenchState(state: string): BenchState {
  const f = stateFile(state);
  if (!existsSync(f)) throw new Error(`no bench in ${state}; run 'just e2e up' first`);
  return JSON.parse(readFileSync(f, "utf8")) as BenchState;
}

/** `docker compose` on the bench's file and project. */
export function compose(state: string, args: string[], input?: string): Promise<string> {
  const argv = ["compose", "-p", PROJECT, "-f", composeFile(state), ...args];
  if (input === undefined) return sh("docker", argv);
  return new Promise((resolve, reject) => {
    const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += String(b)));
    child.stderr.on("data", (b: Buffer) => (err += String(b)));
    child.on("close", (code: number | null) => (code === 0 ? resolve(out) : reject(new Error(`docker compose ${args[0]} exited ${code}: ${err.trim().split("\n").pop()}`))));
    child.stdin.end(input);
  });
}

async function waitHttp(url: string, label: string, tries: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status > 0) return;
    } catch {
      // not up yet
    }
    await sleep(2000);
  }
  throw new Error(`${label} did not answer on ${url}`);
}

/** The buckets on floci. */
export async function seedBuckets(floci: string): Promise<void> {
  await makeBucket(floci, BUCKETS.records, { secure: true });
  await makeBucket(floci, BUCKETS.state, { secure: true });
  await makeBucket(floci, BUCKETS.reports, { secure: false });
  await makeBucket(floci, BUCKETS.bare, { secure: false });
}

/** A user's token, minted by basic auth. */
async function token(h: HarnessModule, forge: string, login: string, password: string): Promise<string> {
  await h.forgejoApi(forge, "", "DELETE", `/users/${login}/tokens/plywood-e2e`, undefined, { missingOk: true, basic: { login, password } }).catch(() => null);
  const t = await h.forgejoApi<{ sha1?: string }>(forge, "", "POST", `/users/${login}/tokens`, { name: "plywood-e2e", scopes: ["all"] }, { basic: { login, password } });
  if (!t?.sha1) throw new Error(`no token for ${login}`);
  return t.sha1;
}

async function seedPeople(c: SeedContext, forge: string): Promise<Pick<BenchState, "admin" | "author" | "reviewer">> {
  const a = PEOPLE.admin;
  const exists = await fetch(`${forge}/api/v1/user`, { headers: { authorization: `Basic ${Buffer.from(`${a.login}:${a.password}`).toString("base64")}` } }).then((r) => r.ok, () => false);
  if (!exists) {
    await compose(c.state, ["exec", "-T", "-u", "git", "forgejo", "forgejo", "admin", "user", "create", "--admin", "--username", a.login, "--password", a.password, "--email", `${a.login}@${EMAIL_DOMAIN}`, "--must-change-password=false"]);
  }
  const admin = { login: a.login, token: await token(c.h, forge, a.login, a.password) };
  for (const p of [PEOPLE.author, PEOPLE.reviewer]) {
    const user = await c.h.forgejoApi(forge, admin.token, "GET", `/users/${p.login}`, undefined, { missingOk: true });
    if (!user) {
      await c.h.forgejoApi(forge, admin.token, "POST", "/admin/users", { username: p.login, password: p.password, email: `${p.login}@${EMAIL_DOMAIN}`, must_change_password: false });
    }
  }
  return {
    admin,
    author: { login: PEOPLE.author.login, token: await token(c.h, forge, PEOPLE.author.login, PEOPLE.author.password) },
    reviewer: { login: PEOPLE.reviewer.login, token: await token(c.h, forge, PEOPLE.reviewer.login, PEOPLE.reviewer.password) },
  };
}

/**
 * The cloud half of the seed, run in a job container on a clone of main:
 * each stack created in its backend, dev deployed on plunge and staging on
 * stock Pulumi. Every pulumi and plunge line names its backend and skips
 * the update check. With `commit`, it also runs `plywood init` and pushes
 * the stack files and the workflow to main.
 */
export function cloudScript(commit: boolean): string {
  const store = plungeStoreUrl(BUCKETS.records, FLOCI_NET);
  const stockInStore = s3BackendUrl(BUCKETS.records, FLOCI_NET);
  const state = s3BackendUrl(BUCKETS.state, FLOCI_NET);
  const env = (backend: string) => `PULUMI_BACKEND_URL='${backend}' PULUMI_SKIP_UPDATE_CHECK=true`;
  const init = (engine: string, backend: string, s: string) =>
    `${env(backend)} ${engine} stack select ${s} >/dev/null 2>&1 || ${env(backend)} ${engine} stack init ${s} --secrets-provider passphrase --non-interactive`;
  return [
    init("plunge", store, "dev"),
    `${env(store)} plunge up --yes --non-interactive --stack dev`,
    // staging stays a stock stack, in the store's bucket where plunge's adopt reads it (pw-adopt).
    init("pulumi", stockInStore, "staging"),
    `${env(stockInStore)} pulumi up --yes --non-interactive --stack staging`,
    init("pulumi", state, "prod-us"),
    init("pulumi", state, "prod-eu"),
    ...(commit
      ? [
          `${env(state)} plywood init --forge forgejo --yes`,
          "git add -A",
          "git commit -q -m 'plywood init, and the stacks created on the bench' || true",
          "git push -q origin HEAD:main",
        ]
      : []),
  ].join("\n");
}

/** Start the stack and seed it. Re-running keeps what is there. */
export async function up(c: SeedContext): Promise<BenchState> {
  const s = benchStack(c.h);
  mkdirSync(c.state, { recursive: true });
  writeFileSync(composeFile(c.state), `${JSON.stringify(composeDoc(s), null, 2)}\n`);
  c.log(`starting floci, Forgejo and the runner (compose project ${PROJECT})`);
  await compose(c.state, ["up", "-d", "floci", "forgejo", "forgejoRunner"]);
  const urls = hostUrls(s);
  await waitHttp(`${urls.floci}/`, "floci", 60, c.h.realClock.sleep);
  await waitHttp(`${urls.forgejo}/api/v1/version`, "Forgejo", 90, c.h.realClock.sleep);

  c.log("buckets on floci: the record store set up for plunge, the state, reports and bare buckets");
  await seedBuckets(urls.floci);
  const people = await seedPeople(c, urls.forgejo);

  c.log("registering the runner");
  await c.h.registerForgejoRunner({
    url: urls.forgejo,
    adminToken: people.admin.token,
    name: RUNNER_NAME,
    network: PROJECT,
    jobImage: JOB_IMAGE,
    envs: jobEnv(c.h),
    writeConfig: async (text) => void (await compose(c.state, ["exec", "-T", "forgejoRunner", "sh", "-c", "cat > /data/config.yml.new && mv /data/config.yml.new /data/config.yml"], text)),
    restart: async () => void (await compose(c.state, ["restart", "forgejoRunner"])),
  });

  const repo = `/repos/${ORG}/${REPO}`;
  const shop = shopDir(c.state);
  const existing = await c.h.forgejoApi<{ empty?: boolean }>(urls.forgejo, people.author.token, "GET", repo, undefined, { missingOk: true });
  if (!existing) {
    await c.h.forgejoApi(urls.forgejo, people.author.token, "POST", "/user/repos", { name: REPO, private: false, auto_init: false, default_branch: "main" });
  }
  await c.h.forgejoApi(urls.forgejo, people.admin.token, "PATCH", repo, { has_actions: true });
  await c.h.forgejoApi(urls.forgejo, people.author.token, "PUT", `${repo}/collaborators/${people.reviewer.login}`, { permission: "write" });

  const remote = (p: Person) => {
    const u = new URL(urls.forgejo);
    u.username = p.login;
    u.password = p.token;
    u.pathname = `/${ORG}/${REPO}.git`;
    return u.toString();
  };
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!existing || existing.empty) {
    c.log("building tutor/shop from the plunge corpus's aws-ts program");
    const build = join(c.state, "shop-build");
    await sh("bash", [join(c.root, "stack", "seed-repo.sh"), build], { env: { ...process.env, PLYWOOD_TUTORIAL_PLUNGE_REF: PLUNGE_REF } });
    writeFileSync(join(build, "plywood.yml"), readFileSync(join(c.root, "e2e", "scenarios", "base", "plywood.yml"), "utf8"));
    await sh("git", ["-C", build, "init", "-q", "-b", "main"], { env: gitEnv });
    await sh("git", ["-C", build, "add", "-A"], { env: gitEnv });
    await sh("git", ["-C", build, "-c", `user.name=${people.author.login}`, "-c", `user.email=${people.author.login}@${EMAIL_DOMAIN}`, "commit", "-q", "-m", "The aws-ts program from plunge's corpus, with plywood.yml"], { env: gitEnv });
    await sh("git", ["-C", build, "push", "-q", remote(people.author), "main"], { env: gitEnv, redact: [people.author.token] });

    c.log("creating the stacks, deploying dev on plunge and staging on stock Pulumi, and running plywood init");
    const code = await c.run(jobArgv(c.h, { image: JOB_IMAGE, person: people.author }, cloudScript(true)));
    if (code !== 0) throw new Error(`the seed's job container exited ${code}; the safe-run log has its output`);
  }

  if (!existsSync(join(shop, ".git"))) await sh("git", ["clone", "-q", remote(people.author), shop], { env: gitEnv, redact: [people.author.token] });
  else await sh("git", ["-C", shop, "pull", "-q", "--ff-only"], { env: gitEnv });
  const baseSha = (await sh("git", ["-C", shop, "rev-parse", "HEAD"], { env: gitEnv })).trim();
  const st: BenchState = { ...people, baseSha };
  writeFileSync(stateFile(c.state), `${JSON.stringify(st, null, 2)}\n`);
  c.log(`ready: Forgejo at ${urls.forgejo} (${ORG}/${REPO}), floci at ${urls.floci}, base ${baseSha.slice(0, 10)}`);
  return st;
}

/** Put floci and the stacks back to the seed: restart floci, then the cloud half of the seed again. */
export async function resetCloud(c: SeedContext, st: BenchState): Promise<void> {
  const urls = hostUrls(benchStack(c.h));
  await compose(c.state, ["restart", "floci"]);
  await waitHttp(`${urls.floci}/`, "floci", 60, c.h.realClock.sleep);
  await seedBuckets(urls.floci);
  const code = await c.run(jobArgv(c.h, { image: JOB_IMAGE, person: st.author }, cloudScript(false)));
  if (code !== 0) throw new Error(`the reset's job container exited ${code}`);
}

/** Stop the stack and remove its volumes. The state directory stays. */
export async function down(c: Pick<SeedContext, "state" | "log">): Promise<void> {
  await compose(c.state, ["down", "--volumes", "--remove-orphans"]);
  c.log(`down; files under ${c.state} are kept`);
}
