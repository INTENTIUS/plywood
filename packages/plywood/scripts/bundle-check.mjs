// Holds @intentius/plywood to its shape: one runtime dependency,
// @intentius/chant at the root's exact pin; a bundle that imports only Node's
// own modules; and a packed tarball under 2048 KB.
//   node scripts/bundle-check.mjs     (after the build; just bundle-check)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CEILING_BYTES = 2048 * 1024;
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkgDir, "../..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const problems = [];

const deps = Object.keys(pkg.dependencies ?? {});
if (deps.length !== 1 || deps[0] !== "@intentius/chant") {
  problems.push(`runtime dependencies are ${deps.join(", ") || "none"}; plywood has one, @intentius/chant`);
}
const pin = pkg.dependencies?.["@intentius/chant"];
if (!/^\d+\.\d+\.\d+$/.test(pin ?? "")) problems.push(`@intentius/chant is '${pin}', not an exact version`);
const rootPin = rootPkg.devDependencies?.["@intentius/chant"];
if (pin !== rootPin) problems.push(`@intentius/chant is ${pin} here and ${rootPin} at the root`);
for (const [name, v] of Object.entries(pkg.devDependencies ?? {})) {
  if (name.startsWith("@intentius/chant") && v !== pin) problems.push(`${name} is ${v}, not the chant pin ${pin}`);
}

const bundle = readFileSync(join(pkgDir, "dist/plywood.mjs"), "utf8");
const node = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
for (const m of bundle.matchAll(/(?:^|[\s;])(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm)) {
  const spec = m[1] ?? m[2];
  if (!node.has(spec)) problems.push(`dist/plywood.mjs imports '${spec}'`);
}

const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: pkgDir, stdio: ["ignore", "pipe", "inherit"] }).toString(),
);
if (packed.size > CEILING_BYTES) problems.push(`the tarball is ${(packed.size / 1024).toFixed(0)} KB, over ${CEILING_BYTES / 1024} KB`);

if (problems.length) {
  console.error("bundle-check:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`  bundle-check: tarball ${(packed.size / 1024).toFixed(1)} KB, ${packed.entryCount} files, chant ${pin}`);
