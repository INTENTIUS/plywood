// Holds @intentius/plywood to its shape: its runtime dependencies are exactly
// the @intentius packages it loads at run time, each at the root's exact chant
// pin; a bundle that imports only Node's own modules and those packages, each
// import one that the installed package's exports map serves as compiled JS
// (chant#4591); and a packed tarball under 2048 KB.
//
// The packages plywood loads at run time are the ones dist/plywood.mjs
// imports by name, @intentius/chant-lexicon-pulumi (init's workspace members
// and pulumi-up steps; plywood#9 ruling A1), and the forge lexicon of each
// forge in src/config/routing.ts's FORGES, which chant's generator loads by
// name when `plywood init` and `plywood ci` write a workflow (plywood#22). A
// dev-only one is missing from an `npm install --omit=dev`, as in the images.
//   node scripts/bundle-check.mjs     (after the build; just bundle-check)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chantRuntimeTarget } from "./chant-exports.mjs";

const CEILING_BYTES = 2048 * 1024;
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkgDir, "../..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const problems = [];

const routing = readFileSync(join(pkgDir, "src/config/routing.ts"), "utf8");
const forges = /export const FORGES = \[([^\]]*)\]/.exec(routing)?.[1].match(/[a-z0-9-]+/g) ?? [];
if (forges.length === 0) problems.push("src/config/routing.ts has no FORGES list to check the forge lexicons against");
const bundle = readFileSync(join(pkgDir, "dist/plywood.mjs"), "utf8");
const node = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const specs = [];
for (const m of bundle.matchAll(/(?:^|[\s;])(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm)) {
  const spec = m[1] ?? m[2];
  if (!node.has(spec)) specs.push(spec);
}
const packageOf = (spec) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

// Every @intentius package plywood loads at run time, and why.
const runtime = new Map([
  ["@intentius/chant", "the chant plywood runs"],
  ["@intentius/chant-lexicon-pulumi", "init's workspace members and pulumi-up steps"],
  ...forges.map((f) => [`@intentius/chant-lexicon-${f}`, `chant's generator loads it for --forge ${f}`]),
]);
for (const spec of specs) {
  if (spec.startsWith("@intentius/") && !runtime.has(packageOf(spec))) runtime.set(packageOf(spec), `dist/plywood.mjs imports ${spec}`);
}
const deps = pkg.dependencies ?? {};
const pin = deps["@intentius/chant"];
for (const [name, why] of runtime) {
  if (!(name in deps)) problems.push(`${name} is loaded at run time (${why}) but is not in dependencies${name in (pkg.devDependencies ?? {}) ? " (it is a devDependency, which npm install --omit=dev leaves out)" : ""}`);
}
for (const [name, v] of Object.entries(deps)) {
  if (!runtime.has(name)) problems.push(`${name} is a runtime dependency that plywood does not load`);
  if (name.startsWith("@intentius/chant") && v !== pin) problems.push(`${name} is '${v}', not the chant pin ${pin}`);
}
if (!/^\d+\.\d+\.\d+$/.test(pin ?? "")) problems.push(`@intentius/chant is '${pin}', not an exact version`);
const rootPin = rootPkg.devDependencies?.["@intentius/chant"];
if (pin !== rootPin) problems.push(`@intentius/chant is ${pin} here and ${rootPin} at the root`);
for (const [name, v] of Object.entries(pkg.devDependencies ?? {})) {
  if (name.startsWith("@intentius/chant") && v !== pin) problems.push(`${name} is ${v}, not the chant pin ${pin}`);
}

const chantImports = new Set();
for (const spec of specs) {
  if (!(packageOf(spec) in deps)) {
    problems.push(`dist/plywood.mjs imports '${spec}', which is neither a Node module nor a runtime dependency`);
    continue;
  }
  chantImports.add(spec);
  if (!chantRuntimeTarget(spec)) {
    problems.push(`dist/plywood.mjs imports '${spec}', which the installed package's exports do not serve as compiled JS under the import condition`);
  }
}
const installed = JSON.parse(readFileSync(join(root, "node_modules/@intentius/chant/package.json"), "utf8"));
const checkedAgainst = installed.chantLocal ? `local chant ${installed.version} (${String(installed.chantLocal.commit).slice(0, 10)})` : `chant ${installed.version}`;
if (!installed.chantLocal && installed.version !== pin) problems.push(`the installed chant is ${installed.version}, not the pin ${pin}; run npm ci`);
for (const name of Object.keys(deps).filter((n) => n.startsWith("@intentius/chant-"))) {
  const f = join(root, "node_modules", name, "package.json");
  if (!existsSync(f)) {
    problems.push(`${name} is not installed; run npm ci`);
    continue;
  }
  const lexicon = JSON.parse(readFileSync(f, "utf8"));
  if (!lexicon.chantLocal && !installed.chantLocal && lexicon.version !== pin) problems.push(`the installed ${name} is ${lexicon.version}, not the pin ${pin}; run npm ci`);
}

const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: pkgDir, stdio: ["ignore", "pipe", "inherit"] }).toString(),
);
if (packed.size > CEILING_BYTES) problems.push(`the tarball is ${(packed.size / 1024).toFixed(0)} KB, over ${CEILING_BYTES / 1024} KB`);

if (problems.length) {
  console.error("bundle-check:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`  bundle-check: tarball ${(packed.size / 1024).toFixed(1)} KB, ${packed.entryCount} files, ${Object.keys(deps).length} runtime dependencies at chant ${pin}; ${chantImports.size} chant imports resolve against ${checkedAgainst}`);
