#!/usr/bin/env node
// plywood's release steps (AGENTS.md, Releasing). Modelled on terragucci's
// scripts/release.ts and release-preflight.sh and sql-yodeler's
// scripts/release.sh.
//
//   node scripts/release.mjs bump <version>
//       sets packages/plywood/package.json and package-lock.json to <version>
//       and renders the two Dockerfiles again (their version label follows
//       it). It writes files and commits nothing; merge the result to main.
//
//   node scripts/release.mjs tag <version> [--dry-run] [--commit <sha>] [--branch <b>] [--skip-green]
//       checks, each on its own line:
//         the version is X.Y.Z
//         the commit: --commit, or else the newest green commit on origin/<b>
//           (`chant ci last-green`, from the ci/green tags chant-ci-green.yml
//           pushes), or with --skip-green origin/<b> itself
//         the commit is on origin/<b> (main by default)
//         its packages/plywood/package.json is at <version>
//         it has ci/green/<sha> and no ci/revoked/<sha> (unless --skip-green)
//         tag v<version> exists neither here nor on origin
//         npm has no @intentius/plywood@<version>, and <version> is above npm's latest
//         the changes page has a section for <version>
//         this checkout is that commit, clean, and its packed tarball passes:
//           npm run build, bundle-check, npm pack, npm publish --dry-run of the tarball
//       then tags the commit v<version> (annotated) and pushes only that tag;
//       the publish workflow runs on it. --dry-run (-n) runs every check,
//       keeps going past a failure, says what it would do, and creates,
//       changes and pushes nothing. PLYWOOD_RELEASE_SKIP_GREEN=1 is --skip-green.
//
//   node scripts/release.mjs digests [--run <images run id>]
//       reads the digest GHCR serves for each image this version names
//       (build-images.mjs --tags) and writes packages/plywood/src/image-digests.json
//       with them, in place of the earlier release's. With --run, each must
//       be the digest that publish run's images job printed.
//
// Nothing here runs npm publish without --dry-run, or pushes an image.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const PKG_DIR = join(root, "packages/plywood");
const PKG = join(PKG_DIR, "package.json");
const LOCK = join(root, "package-lock.json");
const DIGESTS = join(PKG_DIR, "src/image-digests.json");
const CHANGES = join(root, "site/src/content/docs/reference/whats-new.md");
const PACK_DIR = join(root, "node_modules/.cache/plywood/release");
const NAME = "@intentius/plywood";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** Runs a command and returns its trimmed stdout, or undefined when it fails. */
function out(bin, argv, opts = {}) {
  const r = spawnSync(bin, argv, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0) return undefined;
  return r.stdout.trim();
}
const git = (...argv) => out("git", argv);

/** a is a higher X.Y.Z than b. */
function newer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

function usage() {
  console.error(
    "usage: node scripts/release.mjs bump <version>\n" +
      "       node scripts/release.mjs tag <version> [--dry-run] [--commit <sha>] [--branch <b>] [--skip-green]\n" +
      "       node scripts/release.mjs digests [--run <images run id>]",
  );
  process.exit(2);
}

// ── bump ────────────────────────────────────────────────────────────────────

function bump(version) {
  if (!VERSION.test(version)) {
    console.error(`release: ${version} is not a version: give it as MAJOR.MINOR.PATCH, with no v`);
    process.exit(2);
  }
  const pkg = readJson(PKG);
  if (pkg.version === version) {
    console.error(`release: packages/plywood is already at ${version}`);
    process.exit(2);
  }
  if (!newer(version, pkg.version)) {
    console.error(`release: ${version} is not above packages/plywood's ${pkg.version}`);
    process.exit(2);
  }
  pkg.version = version;
  writeJson(PKG, pkg);
  const lock = readJson(LOCK);
  lock.packages["packages/plywood"].version = version;
  writeJson(LOCK, lock);
  // The Dockerfiles carry the version label; bundle-check fails until they match.
  execFileSync("npm", ["run", "images", "-w", NAME], { cwd: root, stdio: "inherit" });
  const changes = readFileSync(CHANGES, "utf8");
  const section = changes.includes(`## In ${version}`) ? "" : ` Add a "## In ${version}" section to site/src/content/docs/reference/whats-new.md in the same pull request.`;
  console.log(`\npackages/plywood is at ${version}. Merge this to main; then \`just release ${version} --dry-run\` once CI has tagged it green.${section}`);
}

// ── tag ─────────────────────────────────────────────────────────────────────

function tag(args) {
  let version;
  let commit;
  let branch = "main";
  let dry = false;
  let skipGreen = !["", "0", "false"].includes(process.env.PLYWOOD_RELEASE_SKIP_GREEN ?? "");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run" || a === "-n") dry = true;
    else if (a === "--skip-green") skipGreen = true;
    else if (a === "--commit" || a === "--branch") {
      const v = args[++i];
      if (v === undefined || v.startsWith("-")) usage();
      if (a === "--commit") commit = v;
      else branch = v;
    } else if (a.startsWith("-")) {
      console.error(`release: unknown flag ${a}`);
      usage();
    } else if (version === undefined) version = a.replace(/^v/, "");
    else {
      console.error(`release: two versions given (${version}, ${a})`);
      usage();
    }
  }
  if (version === undefined) usage();

  const failures = [];
  const pass = (msg) => console.log(`  ok    ${msg}`);
  const note = (msg) => console.log(`  note  ${msg}`);
  const fail = (msg) => {
    console.log(`  FAIL  ${msg}`);
    failures.push(msg);
    // A real run stops at the first failure; a dry run reports them all.
    if (!dry) finish();
  };
  const finish = () => {
    if (failures.length) {
      console.log(`\nrelease: ${failures.length} check${failures.length === 1 ? "" : "s"} failed; nothing tagged${dry ? " (dry run)" : ""}.`);
      process.exit(1);
    }
  };

  console.log(`release ${NAME}@${version}${dry ? " (dry run: nothing is created, changed or pushed)" : ""}`);
  if (VERSION.test(version)) pass(`${version} is X.Y.Z`);
  else fail(`"${version}" is not a version of the form X.Y.Z`);
  const tagName = `v${version}`;

  if (git("fetch", "--quiet", "origin", branch, "+refs/tags/ci/*:refs/tags/ci/*") === undefined) note(`could not fetch ${branch} and the ci/ tags from origin; reading the local ones`);
  const tip = git("rev-parse", "--verify", "--quiet", `origin/${branch}^{commit}`);
  if (!tip) fail(`origin/${branch} is not a branch here`);

  // The commit: named, else chant's newest green, else (with --skip-green) the branch tip.
  let sha;
  if (commit !== undefined) {
    sha = git("rev-parse", "--verify", "--quiet", `${commit}^{commit}`);
    if (!sha) fail(`"${commit}" is not a commit here`);
  } else {
    const lg = out("npx", ["--no-install", "chant", "ci", "last-green", "--json", "--branch", branch]);
    let doc;
    try {
      doc = lg === undefined ? undefined : JSON.parse(lg);
    } catch {
      doc = undefined;
    }
    if (doc?.commit?.sha) {
      sha = doc.commit.sha;
      pass(`chant ci last-green names ${sha.slice(0, 12)} on ${branch}`);
    } else if (skipGreen && tip) {
      sha = tip;
      note(`no green commit (${doc?.error?.message ?? "chant ci last-green named none"}); --skip-green takes origin/${branch}, ${tip.slice(0, 12)}`);
    } else {
      fail(`no commit on ${branch} has a ci/green tag (${doc?.error?.message ?? "chant ci last-green named none"}); wait for chant-ci-green.yml to tag one, or pass --skip-green to release origin/${branch}`);
      sha = tip;
      if (sha) note(`the checks below read origin/${branch}, ${sha.slice(0, 12)}`);
    }
  }

  if (sha) {
    const short = sha.slice(0, 12);
    if (tip && spawnSync("git", ["merge-base", "--is-ancestor", sha, tip], { cwd: root }).status === 0) pass(`${short} is on origin/${branch}`);
    else fail(`${short} is not on origin/${branch}`);

    const at = (() => {
      const text = git("show", `${sha}:packages/plywood/package.json`);
      return text ? JSON.parse(text).version : undefined;
    })();
    if (at === version) pass(`${short} has packages/plywood/package.json at ${version}`);
    else fail(`${short} has packages/plywood/package.json at ${at ?? "nothing"}, not ${version}; run \`just release-bump ${version}\`, merge it, and release from a green commit after it`);

    const has = (kind) => git("rev-parse", "--verify", "--quiet", `refs/tags/ci/${kind}/${sha}`) !== undefined;
    if (has("revoked")) fail(`${short} passed CI and then failed a re-run (ci/revoked/${sha})`);
    else if (has("green")) pass(`${short} is green (ci/green/${sha})`);
    else if (skipGreen) note(`${short} has no ci/green tag; --skip-green releases it without one`);
    else fail(`${short} has no ci/green tag (CI may still be running); release from \`chant ci last-green\`, or pass --skip-green`);
  }

  const localTag = git("rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`);
  const remoteTag = git("ls-remote", "--tags", "origin", `refs/tags/${tagName}`);
  if (remoteTag === undefined) fail(`could not list origin's tags`);
  else if (localTag || remoteTag) fail(`${tagName} already exists${localTag ? " here" : ""}${remoteTag ? " on origin" : ""}`);
  else pass(`${tagName} exists neither here nor on origin`);

  const view = spawnSync("npm", ["view", NAME, "versions", "--json"], { cwd: root, encoding: "utf8" });
  if (view.status === 0) {
    let versions = JSON.parse(view.stdout || "[]");
    if (!Array.isArray(versions)) versions = [versions];
    const latest = versions.filter((v) => VERSION.test(v)).reduce((a, v) => (a === undefined || newer(v, a) ? v : a), undefined);
    if (versions.includes(version)) fail(`${NAME}@${version} is already on npm`);
    else if (latest && !newer(version, latest)) fail(`${version} is not above npm's latest, ${latest}`);
    else pass(`npm has no ${NAME}@${version}${latest ? ` (latest ${latest})` : ""}`);
  } else if (/E404/.test(view.stderr + view.stdout)) {
    note(`npm has no ${NAME} at all: the maintainer publishes it by hand once (npm publish --access public in packages/plywood) and sets up its trusted publisher before the workflow can publish`);
    pass(`npm has no ${NAME}@${version}`);
  } else fail(`npm view ${NAME} failed: ${(view.stderr || view.stdout).trim().split("\n")[0]}`);

  if (readFileSync(CHANGES, "utf8").includes(`## In ${version}`)) pass(`the changes page has "## In ${version}"`);
  else note(`the changes page (site/src/content/docs/reference/whats-new.md) has no "## In ${version}" section`);

  // The tarball this checkout packs: the release commit's when the checkout is that commit.
  const head = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  if (sha && head === sha && dirty === "") pass(`this checkout is ${sha.slice(0, 12)}, clean`);
  else if (dry) note(`this checkout is ${head?.slice(0, 12)}${dirty ? " with changes" : ""}, not ${sha?.slice(0, 12) ?? "the release commit"}: the tarball below is this checkout's`);
  else fail(`this checkout is ${head?.slice(0, 12)}${dirty ? " with changes" : ""}; check out ${sha?.slice(0, 12)} clean so the tarball checked is the one tagged`);
  tarball(version, pass, fail);

  if (sha) console.log(`\nwould run: git tag -a ${tagName} -m ${tagName} ${sha} && git push origin refs/tags/${tagName}`);
  if (dry) {
    finish();
    console.log("Dry run: every check passed; no tag made or pushed.");
    return;
  }
  finish();
  execFileSync("git", ["tag", "-a", tagName, "-m", tagName, sha], { cwd: root, stdio: "inherit" });
  const push = spawnSync("git", ["push", "--quiet", "origin", `refs/tags/${tagName}`], { cwd: root, stdio: "inherit" });
  if (push.status !== 0) {
    spawnSync("git", ["tag", "-d", tagName], { cwd: root, stdio: "ignore" });
    console.error(`release: pushing ${tagName} failed; the local tag is deleted`);
    process.exit(1);
  }
  console.log(
    `Pushed ${tagName}. The publish workflow pushes the images and then refuses to publish until their digests are recorded:\n` +
      `  just record-digests <run id>   (gh run list --workflow publish.yml --branch ${tagName}), merged to main\n` +
      `  then the publish workflow on main publishes ${NAME}@${version}.`,
  );
}

/** Builds, runs bundle-check, packs the tarball and dry-runs its publish. */
function tarball(version, pass, fail) {
  const step = (label, bin, argv, cwd = root) => {
    const r = spawnSync(bin, argv, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status === 0) return r;
    fail(`${label} failed (exit ${r.status}):\n${(r.stderr || r.stdout).trim().split("\n").slice(-8).map((l) => `          ${l}`).join("\n")}`);
    return undefined;
  };
  if (!step("npm run build", "npm", ["run", "build"])) return;
  const check = step("bundle-check", "npm", ["run", "bundle-check", "-w", NAME]);
  if (!check) return;
  pass(`${check.stdout.trim().split("\n").filter((l) => l.trim()).slice(-1)[0].trim()}`);
  mkdirSync(PACK_DIR, { recursive: true });
  const packed = step("npm pack", "npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", PACK_DIR], PKG_DIR);
  if (!packed) return;
  const [info] = JSON.parse(packed.stdout);
  const file = join(PACK_DIR, info.filename);
  if (info.version === version) pass(`packed ${info.filename}, ${(info.size / 1024).toFixed(1)} KB, ${info.entryCount} files`);
  else fail(`packed ${info.filename} is at ${info.version}, not ${version}`);
  const files = info.files.map((f) => f.path);
  for (const want of ["dist/plywood.mjs", "plywood.schema.json", "LICENSE", "package.json"]) {
    if (!files.includes(want)) fail(`the tarball has no ${want}`);
  }
  if (!existsSync(file)) return fail(`npm pack wrote no ${file}`);
  // A tarball publish never runs the package's scripts, so this checks the file the workflow's publish would send.
  const pub = step("npm publish --dry-run of the tarball", "npm", ["publish", file, "--dry-run", "--access", "public", "--ignore-scripts"]);
  if (pub) pass(`npm publish --dry-run of ${info.filename} succeeds`);
}

// ── digests ─────────────────────────────────────────────────────────────────

/** The `<engine> <ref>` lines build-images.mjs --tags prints, for this version. */
function imageTags() {
  const text = execFileSync("node", [join(PKG_DIR, "scripts/build-images.mjs"), "--tags"], { cwd: root, encoding: "utf8" });
  return text
    .trim()
    .split("\n")
    .map((l) => {
      const [engine, ref] = l.trim().split(/\s+/);
      return { engine, ref };
    });
}

/** The digest GHCR serves for a public ref: the multi-platform index the publish workflow pushed. */
async function ghcrDigest(ref) {
  const m = /^ghcr\.io\/([^:]+):(.+)$/.exec(ref);
  if (!m) throw new Error(`${ref} is not a ghcr.io reference`);
  const [, repo, t] = m;
  const tok = await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull`);
  if (!tok.ok) throw new Error(`GHCR gave no pull token for ${repo}: HTTP ${tok.status}`);
  const { token } = await tok.json();
  const res = await fetch(`https://ghcr.io/v2/${repo}/manifests/${t}`, {
    method: "HEAD",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].join(", "),
    },
  });
  const digest = res.headers.get("docker-content-digest") ?? "";
  if (!res.ok || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`GHCR has no ${ref} (HTTP ${res.status}); has the publish workflow's images job pushed it?`);
  return digest;
}

/** The "<ref> <digest>" lines the images job prints, from one run's log. */
function runDigests(id) {
  const log = execFileSync("gh", ["run", "view", id, "--log"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const found = new Map();
  for (const m of log.matchAll(/(ghcr\.io\/\S+:\S+) (sha256:[0-9a-f]{64})\s*$/gm)) found.set(m[1], m[2]);
  return found;
}

async function digests(runId) {
  const version = readJson(PKG).version;
  const fromRun = runId ? runDigests(runId) : undefined;
  const table = {};
  let failed = false;
  for (const { engine, ref } of imageTags()) {
    let digest;
    try {
      digest = await ghcrDigest(ref);
    } catch (e) {
      console.error(`${engine}: ${e.message}`);
      failed = true;
      continue;
    }
    if (fromRun && fromRun.get(ref) !== digest) {
      console.error(`${engine}: run ${runId} printed ${fromRun.get(ref) ?? "no digest"} for ${ref}, and GHCR serves ${digest}`);
      failed = true;
      continue;
    }
    console.log(`${engine} ${ref}@${digest}`);
    table[ref] = digest;
  }
  if (failed) process.exit(1);
  writeJson(DIGESTS, table);
  console.log(`\nimage-digests.json holds the ${version} images; the bundle pins them by digest. Merge it to main and run the publish workflow there.`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "bump" && rest.length === 1) bump(rest[0]);
else if (cmd === "tag") tag(rest);
else if (cmd === "digests" && (rest.length === 0 || (rest.length === 2 && rest[0] === "--run"))) await digests(rest[1]);
else usage();
