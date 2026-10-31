/**
 * The plywood bench on chant's e2e harness (plywood#25, plywood#22's claims).
 *
 *   just e2e lint               lint every scenario: plywood's rules, and the
 *                               harness's lintScenario when chant has it
 *   just e2e dry-run <id>       print a scenario's plain and BREAK arms step
 *                               by step; starts and changes nothing
 *   just e2e image [<plunge>]   build the job image (bench.ts JOB_IMAGE) from
 *                               plywood's images; with a linux plunge binary
 *                               it runs that, else the plunge the image carries
 *   just e2e up                 start the harness's stack and seed it
 *   just e2e claim <id>         the plain run and the BREAK run, the scan, and
 *                               on a CLEAN scan the row on the bench's claims
 *                               ledger and EVIDENCE.md
 *   just e2e render             EVIDENCE.md again from the ledger
 *   just e2e down               stop the stack and remove its volumes
 *
 * Everything but lint, dry-run and image needs chant's harness
 * (`E2E_HARNESS_FLOOR`). On a chant without it they refuse with the floor
 * and point at plywood's own bench, `just tutorial-up`. Every process the
 * bench starts on the host goes through the harness's SafeRun (no cloud
 * credential, a file:// Pulumi backend, no update check) and its log is
 * scanned before a row is recorded.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FLOCI_NET, JOB_IMAGE, ORG, PROJECT, REPO, REPORT_URL, BUCKETS, benchStack, engineEnv, hostUrls, jobImageDockerfile, stateDir } from "./bench";
import { harness, type Arm, type HarnessModule, type Scenario } from "./harness";
import { ForgeLedger, LockObserver, armPort, memberReports, outOfBand, pushOverBranch, pushOverMain, reviewerChant, sh, type CommandContext } from "./ports";
import { recordAndRender, renderFromLedger } from "./claims";
import { BASE_OVERLAYS_DIR, OVERLAYS_DIR, SCENARIOS_DIR, lintPlywoodScenario, readScenario, scenarioFiles } from "./scenarios";
import { overlayFiles, readOverlay } from "./overlays";
import { busyTasks, expandWord, type ForgeTask } from "./checks";
import { compose, composeFile, down, readBenchState, resetCloud, shopDir, up, type SeedContext } from "./seed";

const ROOT = join(import.meta.dirname, "..");
const log = (line: string) => console.error(`[e2e] ${line}`);

function installedChant(): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(ROOT, "node_modules", "@intentius", "chant", "package.json"), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** Lint every scenario. Exit 1 on any finding. */
export async function lint(h: HarnessModule, out: (s: string) => void = console.log): Promise<number> {
  let findings = 0;
  for (const [id, file] of Object.entries(scenarioFiles())) {
    const data = JSON.parse(readFileSync(file, "utf8")) as Scenario;
    const own = lintPlywoodScenario(file, data);
    const theirs = h.lintScenario(data).map((f) => `${file}: ${f.at}: ${f.message}`);
    for (const f of [...own, ...theirs]) out(f);
    findings += own.length + theirs.length;
    if (own.length + theirs.length === 0) out(`${id}: clean`);
  }
  return findings === 0 ? 0 : 1;
}

/** A scenario's arms as lines, for --dry-run. */
export function dryRun(s: Scenario): string[] {
  const lines = [`${s.id} records ${s.claim} (${s.title ?? ""})`, `  report URL ${s.reportUrl}`];
  for (const arm of ["plain", "break"] as Arm[]) {
    const env: Record<string, string> = arm === "break" ? s.break.env : {};
    lines.push(`${arm} arm${arm === "break" ? ` (${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")})` : ""}:`);
    lines.push("  reset: close open pull requests and issues, main back to the seed's commit, floci restarted and the stacks deployed again");
    if (env.PLYWOOD_E2E_BASE_OVERLAY) lines.push(`  base: lay ${env.PLYWOOD_E2E_BASE_OVERLAY} over main`);
    for (const step of s.steps) {
      const what =
        step.do === "open" || step.do === "open-concurrent"
          ? `${step.do} ${arm === "break" ? `${step.branch}-break` : step.branch} with ${step.overlay}${arm === "break" && s.break.overlay ? ` and ${s.break.overlay}` : ""}`
          : step.do === "apply"
            ? `apply of ${step.merge}`
            : step.do === "out-of-band"
              ? `run ${step.command.map((w) => expandWord(w, env)).join(" ")}`
              : step.do === "kill-job"
                ? `kill a job${step.match ? ` matching ${step.match}` : ""}`
                : `${step.do} ${"pull" in step ? step.pull : ""}`;
      const expect = (step.expect ?? []).map((e) => JSON.stringify(e)).join(", ");
      lines.push(`  ${step.id}: ${what}${expect ? `; expect ${expect}` : ""}`);
    }
  }
  if (s.break.note) lines.push(`break: ${s.break.note}`);
  return lines;
}

async function buildImage(plungeBin: string | undefined): Promise<number> {
  if (plungeBin && !existsSync(plungeBin)) {
    console.error(`just e2e image: no plunge binary at ${plungeBin}; name a linux build, or none to run the plunge in plywood's image`);
    return 2;
  }
  const images = readFileSync(join(ROOT, "packages", "plywood", "src", "images.ts"), "utf8");
  const pin = (engine: string) => new RegExp(`^  ${engine}: "([^"]+)"`, "m").exec(images)?.[1];
  const version = (JSON.parse(readFileSync(join(ROOT, "packages", "plywood", "package.json"), "utf8")) as { version: string }).version;
  const [pulumi, plunge] = [pin("pulumi"), pin("plunge")];
  if (!pulumi || !plunge) throw new Error("packages/plywood/src/images.ts names no pulumi or plunge release");
  const ctx = join(stateDir(ROOT), "job-image");
  mkdirSync(ctx, { recursive: true });
  if (plungeBin) copyFileSync(plungeBin, join(ctx, "plunge"));
  // With `just chant-local` installed, the jobs get the same local chant as the host.
  const chantTarballs = localChantTarballs();
  if (chantTarballs.length) {
    mkdirSync(join(ctx, "chant-local"), { recursive: true });
    for (const t of chantTarballs) copyFileSync(join(ROOT, ".chant-local", t), join(ctx, "chant-local", t));
    log(`the job image takes the local chant (${readFileSync(join(ROOT, ".chant-local", "commit"), "utf8").trim()}): ${chantTarballs.join(", ")}`);
  }
  writeFileSync(
    join(ctx, "Dockerfile"),
    jobImageDockerfile({
      plungeImage: `ghcr.io/intentius/plywood-plunge:${version}-plunge${plunge}`,
      pulumiImage: `ghcr.io/intentius/plywood-pulumi:${version}-pulumi${pulumi}`,
      pulumiVersion: pulumi,
      plungeVersion: plunge,
      chantTarballs,
      localPlunge: plungeBin !== undefined,
    }),
  );
  log(`building ${JOB_IMAGE} in ${ctx} (run 'just images' first; nothing is pushed)`);
  await sh("docker", ["build", "-t", JOB_IMAGE, ctx]);
  return 0;
}

/** The tarballs `just chant-local` packed, when node_modules holds that build (its chantLocal mark); none on the pin. */
function localChantTarballs(): string[] {
  const dir = join(ROOT, ".chant-local");
  const core = join(ROOT, "node_modules", "@intentius", "chant", "package.json");
  if (!existsSync(join(dir, "commit")) || !existsSync(core)) return [];
  if (!(JSON.parse(readFileSync(core, "utf8")) as { chantLocal?: string }).chantLocal) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".tgz")).sort();
}

function seedContext(h: HarnessModule, safe: InstanceType<HarnessModule["SafeRun"]>): SeedContext {
  return { h, root: ROOT, state: stateDir(ROOT), log, run: (command) => safe.run(command, engineEnv(join(stateDir(ROOT), "file-backend"))) };
}

function newSafeRun(h: HarnessModule, name: string) {
  const scratch = join(stateDir(ROOT), "safe-run", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(scratch, { recursive: true });
  return new h.SafeRun({ scratch, extra: engineEnv(join(stateDir(ROOT), "file-backend")) });
}

/** The newest pull request (open or closed) whose head is `branch`. */
async function newestPull(h: HarnessModule, forgeUrl: string, token: string, branch: string): Promise<number | undefined> {
  const list = (await h.forgejoApi<Array<{ number: number; head?: { ref?: string } }>>(forgeUrl, token, "GET", `/repos/${ORG}/${REPO}/pulls?state=all&limit=50`)) ?? [];
  return list.filter((p) => p.head?.ref === branch).reduce<number | undefined>((n, p) => (n === undefined || p.number > n ? p.number : n), undefined);
}

/**
 * Wait until Forgejo lists no running, waiting or blocked task for
 * tutor/shop (plywood#22 finding 10), up to `limit` seconds, so an arm's
 * reset never races a job the arm before started. Throws at the limit,
 * naming the tasks still busy.
 */
async function drainTasks(h: HarnessModule, forgeUrl: string, token: string, clock: HarnessModule["realClock"], limit: number): Promise<void> {
  const deadline = clock.now() + limit * 1000;
  for (;;) {
    const page = await h.forgejoApi<{ workflow_runs?: ForgeTask[] }>(forgeUrl, token, "GET", `/repos/${ORG}/${REPO}/actions/tasks?limit=200`);
    const busy = busyTasks(page?.workflow_runs ?? []);
    if (busy.length === 0) return;
    if (clock.now() >= deadline) throw new Error(`Forgejo still lists ${busy.map((t) => `task ${t.id} (${t.name ?? "?"}, ${t.status})`).join(", ")} after ${limit}s, so the reset would race them`);
    log(`waiting for ${busy.length} Forgejo task${busy.length === 1 ? "" : "s"} to finish before the reset: ${busy.map((t) => `${t.id} ${t.status}`).join(", ")}`);
    await clock.sleep(5000);
  }
}

async function forgeTasks(h: HarnessModule, forgeUrl: string, token: string): Promise<ForgeTask[]> {
  const page = await h.forgejoApi<{ workflow_runs?: ForgeTask[] }>(forgeUrl, token, "GET", `/repos/${ORG}/${REPO}/actions/tasks?limit=200`);
  return page?.workflow_runs ?? [];
}

/**
 * After a push to a pull request's branch: wait until its record-plans job
 * (a task newer than `after`) has finished and no task is busy. A merged wave
 * compares its plans with the ones recorded at the pull request's head
 * (approvals.preview), and a merge before that job ends finds none.
 */
async function settlePlans(h: HarnessModule, forgeUrl: string, token: string, clock: HarnessModule["realClock"], after: number, limit: number): Promise<void> {
  const deadline = clock.now() + limit * 1000;
  for (;;) {
    const tasks = await forgeTasks(h, forgeUrl, token);
    const recorded = tasks.some((t) => t.id > after && t.name === "record-plans" && t.status === "success");
    if (recorded && busyTasks(tasks).length === 0) return;
    if (clock.now() >= deadline) throw new Error(`the push's record-plans job did not finish within ${limit}s`);
    await clock.sleep(5000);
  }
}

async function claim(h: HarnessModule, id: string): Promise<number> {
  const scenario = h.loadScenario(join(SCENARIOS_DIR, `${id}.json`));
  const own = lintPlywoodScenario(join(SCENARIOS_DIR, `${id}.json`), scenario);
  if (own.length) throw new Error(own.join("\n"));
  const state = stateDir(ROOT);
  const st = readBenchState(state);
  const safe = newSafeRun(h, id);
  const sc = seedContext(h, safe);
  const urls = hostUrls(benchStack(h));
  const clock = h.realClock;
  const forge = new h.ForgejoForge({ url: urls.forgejo, repo: "tutor/shop", admin: st.admin, author: st.author, reviewer: st.reviewer, baseTree: shopDir(state), clock, checkout: ROOT, emailDomain: "plywood-tutorial.local" });
  const reports = memberReports(new h.FlociBucket(urls.floci, BUCKETS.reports));
  const ledger = new ForgeLedger({ forgeUrl: urls.forgejo, reader: st.admin, scratch: join(state, "scratch") });
  const observer = new LockObserver(new h.FlociBucket(urls.floci, BUCKETS.records));
  let armEnv: Record<string, string> = {};
  let since = new Date().toISOString();
  const ctx: CommandContext = {
    h,
    clock,
    safe,
    ledger,
    observer,
    env: scenario.env ?? "local",
    since: () => since,
    armEnv: () => armEnv,
    floci: urls.floci,
    jobImage: JOB_IMAGE,
    author: st.author,
    reviewer: st.reviewer,
    waitLimit: scenario.limits?.["out-of-band"] ?? 600,
    admin: st.admin,
    overlay: (name, kind) => overlayFiles(readOverlay(kind === "base" ? BASE_OVERLAYS_DIR : OVERLAYS_DIR, name), shopDir(state)),
    pushBranch: async (branch, files, message) => {
      const before = await forgeTasks(h, urls.forgejo, st.admin.token);
      const sha = await pushOverBranch({ forgeUrl: urls.forgejo, person: st.author, scratch: join(state, "scratch"), branch, files, message });
      await settlePlans(h, urls.forgejo, st.admin.token, clock, Math.max(...before.map((t) => t.id), 0), scenario.limits?.["out-of-band"] ?? 600);
      return sha;
    },
    pullComments: async (branch) => {
      const pull = await newestPull(h, urls.forgejo, st.admin.token, branch);
      return pull === undefined ? undefined : forge.comments(pull);
    },
    issues: () => forge.issues(),
  };
  const result = await h.runClaim(
    scenario,
    {
      forge,
      bucket: reports,
      chant: reviewerChant(ctx),
      clock,
      overlay: (name) => overlayFiles(readOverlay(OVERLAYS_DIR, name), shopDir(state)),
      ledger,
      jobs: h.dockerJobs(PROJECT),
      outOfBand: outOfBand(ctx),
      reset: async () => {
        observer.stop();
        // plywood#22 finding 10: no reset restarts floci under a job the arm before left running or queued.
        await drainTasks(h, urls.forgejo, st.admin.token, clock, ctx.waitLimit);
        for (const pull of await forge.openPulls()) await forge.closePull(pull);
        // A drift issue from the arm before would answer this arm's issue checks.
        for (const issue of await forge.issues()) if (issue.open) await h.forgejoApi(urls.forgejo, st.admin.token, "PATCH", `/repos/${ORG}/${REPO}/issues/${issue.number}`, { state: "closed" });
        for (const b of await forge.branches()) if (b !== "main" && !b.startsWith("chant/")) await forge.deleteBranch(b);
        await forge.forceMain(st.baseSha);
        await resetCloud(sc, st);
        since = new Date().toISOString();
      },
      arm: armPort({
        baseOverlays: BASE_OVERLAYS_DIR,
        repoDir: shopDir(state),
        observer,
        setArm: (_arm, env) => {
          armEnv = env;
        },
        push: (files, message) => pushOverMain({ forgeUrl: urls.forgejo, admin: st.admin, scratch: join(state, "scratch"), files, message }),
      }),
      log: (line) => {
        log(line);
        safe.log(line);
      },
    },
    { approver: `forgejo@forgejo:3000:${st.reviewer.login}` },
  );
  observer.stop();
  safe.log(await compose(state, ["logs", "--no-color", "forgejoRunner", "floci"]).catch((e: unknown) => `compose logs failed: ${String(e)}`));
  log(`${id}: plain ${result.verdicts.plain}, break ${result.verdicts.break}`);

  const version = (await sh("docker", ["run", "--rm", "-e", "PULUMI_BACKEND_URL=file:///tmp/plywood-tutorial-backend", "-e", "PULUMI_SKIP_UPDATE_CHECK=true", "--entrypoint", "plunge", JOB_IMAGE, "version"])).trim().split("\n")[0]!.trim();
  const productCommit = (await sh("git", ["-C", ROOT, "rev-parse", "HEAD"])).trim();
  const { row } = await recordAndRender({ h, root: ROOT, state, scenario, run: result, safe, engine: { binary: "plunge", version }, productCommit, chant: installedChant() ?? "unknown" });
  log(`${id}: recorded ${row.claim} (plain ${row.plain}, break ${row.break}) and rendered EVIDENCE.md`);
  return row.plain === "pass" && row.break === "caught" ? 0 : 1;
}

/** Where Forgejo keeps tutor/shop's job logs in its container. */
export const FORGEJO_JOB_LOG_DIR = `/data/gitea/actions_log/${ORG}/${REPO}`;

/**
 * Each job log under {@link FORGEJO_JOB_LOG_DIR} and where its copy goes,
 * `<dir>/task<id>.log` (plywood#22): Forgejo compresses a finished task's
 * log to `<id>.log.zst` and keeps a running or just-finished one as
 * `<id>.log`, so the scan reads both.
 */
export function jobLogCopies(files: readonly string[], dir: string): Array<{ from: string; to: string; zst: boolean }> {
  const out: Array<{ from: string; to: string; zst: boolean }> = [];
  for (const from of files) {
    const m = /(?:^|\/)([^/]+?)\.log(\.zst)?$/.exec(from.trim());
    if (!m) continue;
    out.push({ from: from.trim(), to: join(dir, `task${m[1]}.log`), zst: m[2] === ".zst" });
  }
  return out.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

/** Copy every job log of tutor/shop out of Forgejo into `dir`, the compressed ones decompressed, for `chant e2e safe-run --scan`. */
function copyJobLogs(dir: string): number {
  const state = stateDir(ROOT);
  const exec = (args: string[]) => execFileSync("docker", ["compose", "-p", PROJECT, "-f", composeFile(state), "exec", "-T", "forgejo", ...args], { maxBuffer: 512 * 1024 * 1024 });
  const listed = String(exec(["find", FORGEJO_JOB_LOG_DIR, "-type", "f", "(", "-name", "*.log.zst", "-o", "-name", "*.log", ")"])).split("\n").filter(Boolean);
  mkdirSync(dir, { recursive: true });
  let copied = 0;
  for (const c of jobLogCopies(listed, dir)) {
    const raw = exec(["cat", c.from]);
    if (c.zst) {
      const plain = spawnSync("zstd", ["-dqc"], { input: raw, maxBuffer: 512 * 1024 * 1024 });
      if (plain.status !== 0) {
        writeFileSync(`${c.to}.zst`, raw);
        log(`${c.from}: zstd could not decompress it (${plain.error?.message ?? `exit ${plain.status}`}); kept as ${c.to}.zst`);
        continue;
      }
      writeFileSync(c.to, plain.stdout);
    } else {
      writeFileSync(c.to, raw);
    }
    copied++;
  }
  log(`copied ${copied} of ${listed.length} job logs into ${dir}`);
  return copied === listed.length ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "lint":
      return lint(await harness());
    case "dry-run": {
      if (!rest[0]) {
        console.error(`usage: just e2e dry-run <${Object.keys(scenarioFiles()).join("|")}>`);
        return 2;
      }
      for (const line of dryRun(readScenario(rest[0]))) console.log(line);
      return 0;
    }
    case "image":
      return buildImage(rest[0]);
    case "down":
      await down({ state: stateDir(ROOT), log });
      return 0;
    case "job-logs":
      if (!rest[0]) {
        console.error("usage: just e2e job-logs <dir>");
        return 2;
      }
      return copyJobLogs(rest[0]);
    case "up":
    case "claim":
    case "render": {
      const h = await harness();
      if (cmd === "render") {
        await renderFromLedger(h, ROOT, stateDir(ROOT));
        return 0;
      }
      if (cmd === "up") {
        const safe = newSafeRun(h, "up");
        await up(seedContext(h, safe));
        const scan = safe.scan();
        if (scan.verdict !== "CLEAN") {
          log(`the seed's log shows a real cloud answering:\n${scan.hits.join("\n")}`);
          return 3;
        }
        return 0;
      }
      if (!rest[0]) {
        console.error(`usage: just e2e claim <${Object.keys(scenarioFiles()).join("|")}>`);
        return 2;
      }
      return claim(h, rest[0]);
    }
    default:
      console.error(`usage: just e2e lint | dry-run <id> | image <plunge> | up | claim <id> | render | job-logs <dir> | down   (report URL ${REPORT_URL}, floci ${FLOCI_NET} in the network)`);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exitCode = 1;
    },
  );
}
