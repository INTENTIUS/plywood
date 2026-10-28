// Prose lint for the site, on the `sentences` trope ruleset (adapted from
// plunge's site/scripts/lint-prose.mjs). It reads every page under
// src/content/docs (body, title and description), the string literals of
// src/data/rooms.ts and src/data/sidebar.mjs, the home page's own text and the
// repo README.md.
//
// There is no baseline: any finding, at any severity, fails. Fix the prose.
//
//   node scripts/lint-prose.mjs             # gate (CI)
//   node scripts/lint-prose.mjs --verbose   # every finding, file:line
//
// On top of the ruleset it fails on the house rules:
//   - no sentence, heading or link built on a "what" clause: the word is banned;
//   - the site describes the product, so status and hedges stay out of prose:
//     "not yet", "until", "pending", "so far", "experimental";
//   - no em dashes, unicode arrows or curly quotes.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "sentences/lint/registry";
import { runRules } from "sentences/lint/engine";
import { buildDocAnalysis } from "sentences/lint/build-doc";
import { extractProse } from "sentences/lint/markdown-prose";

const here = dirname(fileURLToPath(import.meta.url));
const SITE = join(here, "..");
const REPO = join(SITE, "..");
const DOCS_ROOT = join(SITE, "src", "content", "docs");
const LITERAL_FILES = [join(SITE, "src", "data", "rooms.ts"), join(SITE, "src", "data", "sidebar.mjs")];
const COMPONENT_TEXT = ["Landing.astro", "WithPlunge.astro", "Limits.astro"].map((f) => join(SITE, "src", "components", f));
const README = join(REPO, "README.md");

const verbose = process.argv.includes("--verbose");

function docFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...docFiles(p));
    else if (/\.(md|mdx)$/.test(entry)) out.push(p);
  }
  return out.sort();
}

const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`]*)`/g;

// A source file's string literals as prose: each distinct literal with a
// space in it becomes one bullet, since the site shows them as list items,
// labels and links. lines[i] is the source line of prose line i+1.
function literalProse(src) {
  const code = src
    .split("\n")
    .map((l) => (l.trim().startsWith("//") || l.trim().startsWith("*") || l.trim().startsWith("/*") ? "" : l))
    .join("\n");
  const seen = new Set();
  const parts = [];
  const lines = [];
  for (const m of code.matchAll(LITERAL)) {
    const lit = ((m[1] ?? "") + (m[2] ?? "") + (m[3] ?? "")).replace(/\\'/g, "'").replace(/\s*\n\s*/g, " ");
    if (!lit.trim().includes(" ") || seen.has(lit)) continue;
    seen.add(lit);
    lines.push(code.slice(0, m.index).split("\n").length);
    parts.push(`- ${lit}`);
  }
  return { prose: parts.join("\n"), lines };
}

// A component's visible text: the template after the frontmatter, tags,
// expressions, styles and scripts removed.
function componentProse(src) {
  const body = src.replace(/^---[\s\S]*?\n---/, "").replace(/<(style|script)[\s\S]*?<\/\1>/g, "");
  return body.replace(/\{[^}]*\}/g, " ").replace(/<[^>]+>/g, " ").split("\n").map((l) => l.trim()).join("\n");
}

function frontmatterProse(src) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(src)?.[1] ?? "";
  const out = [];
  for (const key of ["title", "description"]) {
    const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm);
    if (m) out.push("- " + m[1].replace(/^['"]|['"]$/g, ""));
  }
  // Title and description are labels shown apart (page title, tagline), so
  // they lint as list items, as the string literals above do.
  return out.join("\n");
}

// A page's raw text for the house rules, which also cover tables and component
// props (the ruleset's prose extraction drops both): frontmatter, code, import
// lines and link targets blanked, line numbers kept.
function rawText(src) {
  const blank = (t) => t.replace(/[^\n]/g, " ");
  return src
    .replace(/^---\n[\s\S]*?\n---/, blank)
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/^import .*$/gm, blank)
    .replace(/\]\([^)\s]*\)/g, blank)
    .replace(/https?:\/\/\S+/g, blank);
}

// MDX as the reader sees it: import lines and component tags blanked (line
// numbers kept), and a <WithPlunge feature="..."/> aside as the sentence it
// renders.
function mdxProse(src) {
  const blank = (t) => t.replace(/[^\n]/g, " ");
  return src
    .replace(/^import .*$/gm, blank)
    .replace(/<WithPlunge feature="([^"]*)" \/>/g, (_, f) => `With plunge, the pipeline also gets ${f}.`)
    .replace(/^[ \t]*<\/?[A-Z][^>]*>[ \t]*$/gm, blank);
}

function lineOf(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

// Anaphora fires on markup: consecutive bullets, link lists and headings
// "open" with "-", "[", "###" or ",". An opening with no letter in it is not
// a word, so those findings are dropped.
// Two rules misread the product's own nouns. rare-lemma counts a word's share
// of the text, and a page about Pulumi stacks says "stack" often; it skips
// these words and no others. excess-vocabulary flags "Insights", which here is
// Pulumi Insights, a product name.
const DOMAIN_LEMMAS = new Set(["stack", "preview", "pulumi", "plunge", "plywood", "wave", "approval", "resource", "update"]);
function domainNoun(f) {
  if (f.ruleId === "dead-metaphor/rare-lemma") {
    const m = /\u201c([^\u201d/]*)/.exec(f.message);
    return m !== null && DOMAIN_LEMMAS.has(m[1].toLowerCase());
  }
  if (f.ruleId === "excess-vocabulary") return /\u201cInsights\u201d/.test(f.message);
  return false;
}

function markupAnaphora(f) {
  if (f.ruleId !== "anaphora/repeated-opening") return false;
  const m = /\u201c([^\u201d]*)\u201d/.exec(f.message);
  return m !== null && !/\p{L}/u.test(m[1]);
}

const sources = [];
for (const file of docFiles(DOCS_ROOT)) {
  const src = readFileSync(file, "utf8");
  const prose = extractProse(file.endsWith(".mdx") ? mdxProse(src) : src);
  sources.push({ rel: relative(REPO, file), prose, line: (o) => lineOf(prose, o) });
  const raw = rawText(src);
  sources.push({ rel: relative(REPO, file), prose: raw, line: (o) => lineOf(raw, o), houseOnly: true });
  const fm = frontmatterProse(src);
  if (fm) sources.push({ rel: `${relative(REPO, file)} (frontmatter)`, prose: fm, line: () => 1 });
}
for (const file of LITERAL_FILES) {
  const { prose, lines } = literalProse(readFileSync(file, "utf8"));
  sources.push({ rel: relative(REPO, file), prose, line: (o) => lines[lineOf(prose, o) - 1] });
}
for (const file of COMPONENT_TEXT) {
  const prose = componentProse(readFileSync(file, "utf8"));
  sources.push({ rel: relative(REPO, file), prose, line: (o) => lineOf(prose, o) });
}
{
  const prose = extractProse(readFileSync(README, "utf8"));
  sources.push({ rel: "README.md", prose, line: (o) => lineOf(prose, o) });
}

const BANNED = [
  [/\bwhat\b/gi, 'a "what" clause; name the thing'],
  [/\bnot yet\b/gi, 'status talk; the site describes the product'],
  [/\buntil\b/gi, 'status or hedge; say the behaviour plainly'],
  [/\bpending\b/gi, 'status talk; the site describes the product'],
  [/\bso far\b/gi, 'status talk; the site describes the product'],
  [/\bexperimental\b/gi, 'status talk; the site describes the product'],
  [/\u2014|\u2013/g, "an em or en dash; use a comma, a full stop or parentheses"],
  [/[\u2190-\u21ff\u27f5-\u27ff]/g, "a unicode arrow; use words"],
  [/[\u2018\u2019\u201c\u201d]/g, "a curly quote; use a straight one"],
];

let total = 0;
const out = [];
for (const { rel, prose, line, houseOnly } of sources) {
  const { findings, errors } = houseOnly ? { findings: [], errors: [] } : runRules(RULES, buildDocAnalysis(prose));
  for (const e of errors) out.push(`${rel}: rule ${e.ruleId} errored: ${e.message}`);
  for (const f of findings) {
    if (markupAnaphora(f) || domainNoun(f)) continue;
    total++;
    out.push(`${rel}:${line(f.span.start)} [${f.severity}] ${f.ruleId}: ${f.message}`);
  }
  if (houseOnly === undefined && rel.startsWith("site/src/content/docs/") && !rel.endsWith("(frontmatter)")) continue;
  for (const [re, why] of BANNED) {
    for (const m of prose.matchAll(re)) {
      total++;
      out.push(`${rel}:${line(m.index)} [house] "${m[0]}": ${why}`);
    }
  }
}

if (total > 0) {
  for (const l of verbose ? out : out.slice(0, 60)) console.error(l);
  if (!verbose && out.length > 60) console.error(`... and ${out.length - 60} more (--verbose)`);
  console.error(`prose lint: ${total} finding(s) in ${sources.length} sources; fix the prose`);
  process.exit(1);
}
console.log(`prose lint: 0 findings in ${sources.length} sources`);
