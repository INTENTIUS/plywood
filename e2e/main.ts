/**
 * The plywood bench on chant's e2e harness (plywood#25, plywood#22's claims).
 *
 *   just e2e lint               lint every scenario: plywood's rules, and the
 *                               harness's lintScenario when chant has it
 *   just e2e dry-run <id>       print a scenario's plain and BREAK arms step
 *                               by step; starts and changes nothing
 *   just e2e image <plunge>     build the job image (bench.ts JOB_IMAGE) from
 *                               plywood's images and a linux plunge binary
 *   just e2e up                 start the harness's stack and seed it
 *   just e2e claim <id>         the plain run and the BREAK run, the scan, and
 *                               on a CLEAN scan the row on the bench's claims
 *                               ledger and site/src/data/claims.json
 *   just e2e render             claims.json again from the ledger
 *   just e2e down               stop the stack and remove its volumes
 *
 * Everything but lint, dry-run and image needs chant's harness
 * (`E2E_HARNESS_FLOOR`). On a chant without it they refuse with the floor
 * and point at plywood's own bench, `just tutorial-up`. Every process the
 * bench starts on the host goes through the harness's SafeRun (no cloud
 * credential, a file:// Pulumi backend, no update check) and its log is
 * scanned before a row is recorded.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FLOCI_NET, JOB_IMAGE, ORG, PROJECT, REPO, REPORT_URL, BUCKETS, benchStack, engineEnv, hostUrls, jobImageDockerfile, stateDir } from "./bench";
import { NeedsChantHarness, harness, requireHarness, type Arm, type HarnessModule, type Scenario } from "./harness";
import { ForgeLedger, LockObserver, armPort, memberReports, outOfBand, pushOverBranch, pushOverMain, reviewerChant, sh, type CommandContext } from "./ports";
import { recordAndRender, renderFromLedger } from "./claims";
import { BASE_OVERLAYS_DIR, OVERLAYS_DIR, SCENARIOS_DIR, lintPlywoodScenario, readScenario, scenarioFiles } from "./scenarios";
import { overlayFiles, readOverlay } from "./overlays";
import { expandWord } from "./checks";
import { compose, down, readBenchState, resetCloud, shopDir, up, type SeedContext } from "./seed";

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
export async function lint(h: HarnessModule | undefined, out: (s: string) => void = console.log): Promise<number> {
  let findings = 0;
  for (const [id, file] of Object.entries(scenarioFiles())) {
    const data = JSON.parse(readFileSync(file, "utf8")) as Scenario;
    const own = lintPlywoodScenario(file, data);
    const theirs = h ? h.lintScenario(data).map((f) => `${file}: ${f.at}: ${f.message}`) : [];
    for (const f of [...own, ...theirs]) out(f);
    findings += own.length + theirs.length;
    if (own.length + theirs.length === 0) out(`${id}: clean${h ? "" : " (plywood's rules; the harness's lint needs chant's e2e harness)"}`);
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
  if (!plungeBin || !existsSync(plungeBin)) {
    console.error("usage: just e2e image <path to a linux plunge binary built from plunge main>");
    return 2;
  }
  const images = readFileSync(join(ROOT, "packages", "plywood", "src", "images.ts"), "utf8");
  const pin = (engine: string) => new RegExp(`^  ${engine}: "([^"]+)"`, "m").exec(images)?.[1];
  const version = (JSON.parse(readFileSync(join(ROOT, "packages", "plywood", "package.json"), "utf8")) as { version: string }).version;
  const [pulumi, plunge] = [pin("pulumi"), pin("plunge")];
  if (!pulumi || !plunge) throw new Error("packages/plywood/src/images.ts names no pulumi or plunge release");
  const ctx = join(stateDir(ROOT), "job-image");
  mkdirSync(ctx, { recursive: true });
  copyFileSync(plungeBin, join(ctx, "plunge"));
  writeFileSync(
    join(ctx, "Dockerfile"),
    jobImageDockerfile({
      plungeImage: `ghcr.io/intentius/plywood-plunge:${version}-plunge${plunge}`,
      pulumiImage: `ghcr.io/intentius/plywood-pulumi:${version}-pulumi${pulumi}`,
      pulumiVersion: pulumi,
    }),
  );
  log(`building ${JOB_IMAGE} in ${ctx} (run 'just images' first; nothing is pushed)`);
  await sh("docker", ["build", "-t", JOB_IMAGE, ctx]);
  return 0;
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
    pushBranch: (branch, files, message) => pushOverBranch({ forgeUrl: urls.forgejo, person: st.author, scratch: join(state, "scratch"), branch, files, message }),
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
  log(`${id}: recorded ${row.claim} (plain ${row.plain}, break ${row.break}) and rendered site/src/data/claims.json`);
  return row.plain === "pass" && row.break === "caught" ? 0 : 1;
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
    case "up":
    case "claim":
    case "render": {
      const h = await requireHarness(installedChant());
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
      console.error(`usage: just e2e lint | dry-run <id> | image <plunge> | up | claim <id> | render | down   (report URL ${REPORT_URL}, floci ${FLOCI_NET} in the network)`);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof NeedsChantHarness ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exitCode = err instanceof NeedsChantHarness ? 2 : 1;
    },
  );
}
