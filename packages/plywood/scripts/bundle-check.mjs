// Holds @intentius/plywood to its shape: two runtime dependencies,
// @intentius/chant at the root's exact pin and @intentius/chant-lexicon-pulumi
// at the same version (plywood#9 ruling A1: init's workspace members and
// pulumi-up steps need the lexicon installed); a bundle that imports only
// Node's own modules and those two, each import one that the installed
// package's exports map serves as compiled JS (chant#4591); and a packed
// tarball under 2048 KB.
//   node scripts/bundle-check.mjs     (after the build; just bundle-check)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

const RUNTIME = ["@intentius/chant", "@intentius/chant-lexicon-pulumi"];
const deps = Object.keys(pkg.dependencies ?? {}).sort();
if (deps.join(",") !== RUNTIME.join(",")) {
  problems.push(`runtime dependencies are ${deps.join(", ") || "none"}; plywood has two, ${RUNTIME.join(" and ")}`);
}
const pin = pkg.dependencies?.["@intentius/chant"];
const lexiconPin = pkg.dependencies?.["@intentius/chant-lexicon-pulumi"];
if (lexiconPin !== pin) problems.push(`@intentius/chant-lexicon-pulumi is '${lexiconPin}', not the chant pin ${pin}`);
if (!/^\d+\.\d+\.\d+$/.test(pin ?? "")) problems.push(`@intentius/chant is '${pin}', not an exact version`);
const rootPin = rootPkg.devDependencies?.["@intentius/chant"];
if (pin !== rootPin) problems.push(`@intentius/chant is ${pin} here and ${rootPin} at the root`);
for (const [name, v] of Object.entries(pkg.devDependencies ?? {})) {
  if (name.startsWith("@intentius/chant") && v !== pin) problems.push(`${name} is ${v}, not the chant pin ${pin}`);
}

const bundle = readFileSync(join(pkgDir, "dist/plywood.mjs"), "utf8");
const node = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const chantImports = new Set();
for (const m of bundle.matchAll(/(?:^|[\s;])(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm)) {
  const spec = m[1] ?? m[2];
  if (node.has(spec)) continue;
  if (!/^@intentius\/chant(?:-lexicon-pulumi)?(?:\/|$)/.test(spec)) {
    problems.push(`dist/plywood.mjs imports '${spec}', which is neither a Node module nor ${RUNTIME.join(" or ")}`);
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
const lexicon = JSON.parse(readFileSync(join(root, "node_modules/@intentius/chant-lexicon-pulumi/package.json"), "utf8"));
if (!lexicon.chantLocal && !installed.chantLocal && lexicon.version !== pin) problems.push(`the installed chant-lexicon-pulumi is ${lexicon.version}, not the pin ${pin}; run npm ci`);

const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: pkgDir, stdio: ["ignore", "pipe", "inherit"] }).toString(),
);
if (packed.size > CEILING_BYTES) problems.push(`the tarball is ${(packed.size / 1024).toFixed(0)} KB, over ${CEILING_BYTES / 1024} KB`);

if (problems.length) {
  console.error("bundle-check:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`  bundle-check: tarball ${(packed.size / 1024).toFixed(1)} KB, ${packed.entryCount} files, chant and chant-lexicon-pulumi ${pin}; ${chantImports.size} chant imports resolve against ${checkedAgainst}`);
