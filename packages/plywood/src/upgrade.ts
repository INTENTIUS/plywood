/**
 * `plywood upgrade [<version>] [--chant <version>] [--no-install] [--dry-run]`
 * (plywood#23): moves a repository to another plywood release in one change
 * for one pull request.
 *
 * It reads the release from npm (the latest when no version is given) and the
 * chant that release pins, then:
 *
 *   package.json          @intentius/plywood to the release, and every
 *                         @intentius/chant and @intentius/chant-lexicon-*
 *                         dependency to its chant, keeping a ^ or ~ in front
 *   chant.workspace.json  each @intentius/chant* entry of `pins` to that chant
 *   npm install           so the lock file and node_modules hold both
 *   plywood ci            run from the new install, so the workflow names the
 *                         new release's image and the jobs its commands
 *
 * It writes no commit, branch or pull request: the person opens one pull
 * request with the files it lists. `--no-install` stops after the two files
 * and prints the commands left to run; `--dry-run` prints the moves and
 * writes and runs nothing but `npm view`.
 *
 * No step runs pulumi, plunge or git. npm and the new plywood run as child
 * processes through `UpgradeIo.exec`, which the tests replace.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { findConfig, loadConfig } from "./config/index";
import type { ExitTable } from "./exit-codes";
import { REGISTRY } from "./images";
import { takeFlag, type StageIo } from "./stages";
import { PRODUCT } from "./words";

export const PLYWOOD_PACKAGE = "@intentius/plywood";
export const CHANT_PACKAGE = "@intentius/chant";
const CHANT_FAMILY = /^@intentius\/chant(?:-lexicon-[a-z0-9-]+)?$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<ExecResult>;

export interface UpgradeIo extends StageIo {
  exec?: Exec;
}

/** One pin moved, as the summary and the JSON list it. */
export interface PinMove {
  file: string;
  name: string;
  from: string;
  to: string;
}

/** The release `npm view` describes: its version and the chant it pins. */
export interface ReleaseManifest {
  version: string;
  chant: string;
}

export interface UpgradeOptions {
  version?: string;
  chant?: string;
  install: boolean;
  dryRun: boolean;
  forge?: string;
  env?: string;
}

/** Parses upgrade's flags. A bad flag is a message. */
export function parseUpgradeArgs(args: string[]): UpgradeOptions | { error: string } {
  const chant = takeFlag(args, "--chant");
  const forge = takeFlag(chant.rest, "--forge");
  const env = takeFlag(forge.rest, "--env");
  if (chant.missing || forge.missing || env.missing) return { error: "--chant, --forge and --env each take a value" };
  const flags = new Set(["--no-install", "--dry-run"]);
  const unknown = env.rest.filter((a) => a.startsWith("-") && !flags.has(a));
  if (unknown.length) return { error: `upgrade does not take ${unknown.join(" ")}` };
  const words = env.rest.filter((a) => !a.startsWith("-"));
  if (words.length > 1) return { error: `upgrade takes one version, not ${words.join(" ")}` };
  const version = words[0]?.replace(/^v/, "");
  if (version !== undefined && !VERSION.test(version)) return { error: `${words[0]} is not a version: give it as MAJOR.MINOR.PATCH` };
  if (chant.value !== undefined && !VERSION.test(chant.value)) return { error: `--chant ${chant.value} is not a version: give it as MAJOR.MINOR.PATCH` };
  return {
    ...(version ? { version } : {}),
    ...(chant.value ? { chant: chant.value } : {}),
    ...(forge.value ? { forge: forge.value } : {}),
    ...(env.value ? { env: env.value } : {}),
    install: !env.rest.includes("--no-install"),
    dryRun: env.rest.includes("--dry-run"),
  };
}

/** The nearest package.json at or above `dir` that depends on plywood. */
export function findPlywoodPackage(dir: string): string | undefined {
  let cur = resolve(dir);
  for (let depth = 0; depth < 32; depth++) {
    const file = join(cur, "package.json");
    if (existsSync(file)) {
      try {
        const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        if (DEP_FIELDS.some((f) => isObject(pkg[f]) && typeof (pkg[f] as Record<string, unknown>)[PLYWOOD_PACKAGE] === "string")) return file;
      } catch {
        // A package.json that is not JSON is not the one; keep looking up.
      }
    }
    const up = dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
  return undefined;
}

/** A range with its ^ or ~ kept, moved to `version`. A tag, path or URL is left to the person. */
export function movedRange(range: string, version: string): string | undefined {
  const m = /^([~^]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(range.trim());
  if (!m) return undefined;
  return `${m[1]}${version}`;
}

/** package.json with plywood and the chant family moved; the moves, and the ranges it left alone. */
export function movePackagePins(text: string, file: string, plywood: string, chant: string): { text: string; moves: PinMove[]; left: string[] } {
  const pkg = JSON.parse(text) as Record<string, unknown>;
  const moves: PinMove[] = [];
  const left: string[] = [];
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!isObject(deps)) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== "string") continue;
      const target = name === PLYWOOD_PACKAGE ? plywood : CHANT_FAMILY.test(name) ? chant : undefined;
      if (target === undefined) continue;
      const next = movedRange(range, target);
      if (next === undefined) {
        left.push(`${field}.${name} is '${range}'; move it to ${target} by hand`);
        continue;
      }
      if (next === range) continue;
      deps[name] = next;
      moves.push({ file, name, from: range, to: next });
    }
  }
  return { text: moves.length ? jsonText(pkg, text) : text, moves, left };
}

/** chant.workspace.json with each @intentius/chant* pin moved to `chant`. */
export function moveDeclarationPins(text: string, file: string, chant: string): { text: string; moves: PinMove[] } {
  const doc = JSON.parse(text) as Record<string, unknown>;
  const moves: PinMove[] = [];
  const pins = Array.isArray(doc.pins) ? (doc.pins as Array<Record<string, unknown>>) : [];
  for (const pin of pins) {
    if (typeof pin.package !== "string" || !CHANT_FAMILY.test(pin.package) || typeof pin.version !== "string") continue;
    if (pin.version === chant) continue;
    moves.push({ file, name: pin.package, from: pin.version, to: chant });
    pin.version = chant;
  }
  return { text: moves.length ? jsonText(doc, text) : text, moves };
}

/** plywood.yml's `image` when it names one of plywood's own images: the release that image carries is not moved here. */
export function imageNote(doc: Record<string, unknown>, version: string): string | undefined {
  const image = doc.image;
  const name = typeof image === "string" ? image : isObject(image) && typeof image.name === "string" ? image.name : undefined;
  if (name === undefined) return undefined;
  const m = new RegExp(`^${REGISTRY.replace(/[.]/g, "\\.")}/plywood-(pulumi|plunge):([^@]+)`).exec(name);
  if (m && m[2].startsWith(`${version}-`)) return undefined;
  if (m) return `plywood.yml's image is plywood's ${m[1]} image at ${m[2]}; name the ${version} image in it (its tag starts ${version}-), or drop the key to take the release's own`;
  return `plywood.yml's image is your own (${name}); rebuild it FROM plywood's ${version} image and name the new digest in it`;
}

/** Reads a release, or the latest, from npm. */
export async function viewRelease(exec: Exec, cwd: string, env: NodeJS.ProcessEnv, version?: string): Promise<ReleaseManifest | { error: string }> {
  const spec = `${PLYWOOD_PACKAGE}@${version ?? "latest"}`;
  const r = await exec("npm", ["view", spec, "version", "dependencies", "--json"], { cwd, env });
  if (r.code !== 0) {
    const notFound = /E404/.test(r.stderr + r.stdout);
    return { error: notFound ? `npm has no ${spec}` : `npm view ${spec} failed: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { error: `npm view ${spec} printed no JSON` };
  }
  const doc = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  if (!isObject(doc) || typeof doc.version !== "string") return { error: `npm view ${spec} named no version` };
  const deps = isObject(doc.dependencies) ? doc.dependencies : {};
  const chant = deps[CHANT_PACKAGE];
  if (typeof chant !== "string" || !VERSION.test(chant)) return { error: `${PLYWOOD_PACKAGE}@${doc.version} pins no exact ${CHANT_PACKAGE}` };
  return { version: doc.version, chant };
}

/** `plywood upgrade`. */
export async function upgrade(args: string[], json: boolean, table: ExitTable, io: UpgradeIo): Promise<number> {
  const opts = parseUpgradeArgs(args);
  const fail = (message: string): number => {
    if (json) io.out(JSON.stringify({ command: "upgrade", ok: false, exitCode: table.failed, error: message }));
    else io.err(`${PRODUCT}: ${message}`);
    return table.failed;
  };
  if ("error" in opts) return fail(opts.error);
  const exec = io.exec ?? execChild;

  const pkgFile = findPlywoodPackage(io.cwd);
  if (!pkgFile) return fail(`no package.json in ${io.cwd} or above it depends on ${PLYWOOD_PACKAGE}; install it with 'npm i -D ${PLYWOOD_PACKAGE}', then run '${PRODUCT} init'`);
  const pkgDir = dirname(pkgFile);
  const configFile = findConfig(io.cwd);
  const configDir = configFile ? dirname(configFile) : pkgDir;
  const rel = (f: string): string => relative(io.cwd, f) || f;

  const release = await viewRelease(exec, pkgDir, io.env, opts.version);
  if ("error" in release) return fail(release.error);
  const chant = opts.chant ?? release.chant;

  const pkgText = readFileSync(pkgFile, "utf8");
  const pkgMove = movePackagePins(pkgText, rel(pkgFile), release.version, chant);
  const declFile = join(configDir, "chant.workspace.json");
  const declText = existsSync(declFile) ? readFileSync(declFile, "utf8") : undefined;
  let declMove: { text: string; moves: PinMove[] } | undefined;
  if (declText !== undefined) {
    try {
      declMove = moveDeclarationPins(declText, rel(declFile), chant);
    } catch (e) {
      return fail(`${rel(declFile)} is not JSON upgrade can move pins in (${(e as Error).message})`);
    }
  }
  const notes = [...pkgMove.left];
  if (existsSync(join(configDir, "chant.workspace.jsonc"))) notes.push(`chant.workspace.jsonc is yours: move its @intentius/chant* pins to ${chant} by hand`);
  if (configFile) {
    try {
      const note = imageNote(loadConfig(configFile).doc as Record<string, unknown>, release.version);
      if (note) notes.push(note);
    } catch {
      // plywood ci reports a plywood.yml it cannot read.
    }
  } else {
    notes.push(`no plywood.yml, so there is no workflow to write again; run '${PRODUCT} init' after the install`);
  }
  const moves = [...pkgMove.moves, ...(declMove?.moves ?? [])];
  const ciArgs = ["--no-install", PRODUCT, "ci", ...(opts.forge ? ["--forge", opts.forge] : []), ...(opts.env ? ["--env", opts.env] : [])];
  const steps = {
    install: { cwd: rel(pkgDir) || ".", command: "npm install --no-audit --no-fund" },
    ci: { cwd: rel(configDir) || ".", command: `npx ${ciArgs.join(" ")}` },
  };
  const envelope = { command: "upgrade", plywood: release.version, chant, moves, notes, dryRun: opts.dryRun };
  const say = (line: string): void => {
    if (!json) io.err(line);
  };

  say(`${PRODUCT} upgrade: ${PLYWOOD_PACKAGE} ${release.version}, ${CHANT_PACKAGE} ${chant}`);
  for (const m of moves) say(`  ${m.file}  ${m.name}  ${m.from} -> ${m.to}`);
  if (moves.length === 0) say("  every pin is already there");

  if (opts.dryRun) {
    say(`  then: ${steps.install.command} (in ${steps.install.cwd}), then ${steps.ci.command} (in ${steps.ci.cwd})`);
    for (const n of notes) say(`  note: ${n}`);
    if (json) io.out(JSON.stringify({ ...envelope, ok: true, exitCode: table.done, steps }));
    return table.done;
  }

  if (pkgMove.text !== pkgText) writeFileSync(pkgFile, pkgMove.text);
  if (declMove && declText !== undefined && declMove.text !== declText) writeFileSync(declFile, declMove.text);
  const files = [...new Set(moves.map((m) => m.file))];

  if (!opts.install) {
    say(`  left to run: ${steps.install.command} (in ${steps.install.cwd}), then ${steps.ci.command} (in ${steps.ci.cwd})`);
    for (const n of notes) say(`  note: ${n}`);
    if (json) io.out(JSON.stringify({ ...envelope, ok: true, exitCode: table.done, files, steps }));
    return table.done;
  }

  say(`  $ ${steps.install.command}`);
  const installed = await exec("npm", ["install", "--no-audit", "--no-fund"], { cwd: pkgDir, env: io.env });
  if (installed.code !== 0) {
    for (const n of notes) say(`  note: ${n}`);
    return fail(`npm install failed (exit ${installed.code}); package.json is moved, so fix the install and run '${steps.ci.command}'\n${installed.stderr.trim()}`);
  }
  // The re-render runs the plywood npm just installed, so the workflow is the new release's.
  const got = installedVersion(pkgDir);
  if (got !== undefined && got !== release.version) notes.push(`node_modules holds ${PLYWOOD_PACKAGE} ${got}, not ${release.version}; check the install`);
  let ci: ExecResult | undefined;
  if (configFile) {
    say(`  $ ${steps.ci.command}`);
    ci = await exec("npx", ciArgs, { cwd: configDir, env: io.env });
    if (!json && ci.stderr.trim()) io.err(ci.stderr.trimEnd());
  }
  for (const n of notes) say(`  note: ${n}`);
  const ok = ci === undefined || ci.code === 0;
  const lockFile = join(pkgDir, "package-lock.json");
  const changed = [...files, ...(existsSync(lockFile) ? [rel(lockFile)] : [])];
  if (ok) say(`  Open one pull request with ${changed.join(", ")} and the files ${PRODUCT} ci wrote.`);
  else say(`  ${PRODUCT} ci failed (exit ${ci?.code}); the pins are moved and installed, so fix plywood.yml and run '${steps.ci.command}'`);
  const code = ok ? table.done : (ci?.code ?? table.failed);
  if (json) io.out(JSON.stringify({ ...envelope, ok, exitCode: code, files: changed, ...(ci ? { ci: { exitCode: ci.code } } : {}) }));
  return code;
}

/** The version of plywood under `dir`'s node_modules, when there is one. */
function installedVersion(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "node_modules", PLYWOOD_PACKAGE, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** JSON as the file had it: its indent (two spaces when it has none) and a trailing newline. */
function jsonText(value: unknown, original: string): string {
  const indent = /^[{[]\r?\n([ \t]+)/.exec(original)?.[1] ?? "  ";
  return `${JSON.stringify(value, null, indent)}\n`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Runs a child with its output captured; npm's progress goes nowhere. */
const execChild: Exec = (bin, args, opts) =>
  new Promise((done) => {
    execFile(bin, args, { cwd: opts.cwd, env: opts.env, maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
