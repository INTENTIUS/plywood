/**
 * The adopt previews `plywood init` prints for each stack on a `plunge+`
 * backend, and the adopt Op it writes for the step after (chant#4562).
 *
 * plunge refuses a stock checkpoint with no records, so a stack moves onto
 * plunge by `plunge stack adopt`. init runs only the preview form, `plunge
 * stack adopt --json --stack <s>`, which classifies every resource and
 * writes nothing. It runs through chant's pulumi lexicon (`runAllowedPlunge`
 * and its allowlist in lexicons/pulumi/src/run.ts) with PULUMI_BACKEND_URL
 * set to the stack's plunge URL for that run, and plywood runs no plunge
 * process of its own. A refused preview, or plunge missing from PATH, is
 * printed and init still exits 0, as for the bucket check.
 *
 * The adoption itself is `plywood.adopt.op.ts`, chant's `PulumiAdoptOp`:
 * the bucket check, the stock export kept as the back-out copy, then per
 * stack the preview, a gate on the workspace ledger bound to the preview's
 * digest, and `plunge stack adopt --json --yes`. `chant run plywood-adopt`
 * stops at each gate and `chant approve plywood-adopt <gate>` opens it.
 *
 * Both are reached through a feature-detect: a pulumi lexicon older than the pinned
 * 0.124.58 may have no adopt argv, adopt document parser or Op. Then init
 * prints the preview command for each stack and skips the Op file.
 */
import type { PlungeStack } from "./engine";
import { slug } from "./detect";

/** The adopt Op init writes, and its file. */
export const ADOPT_OP = "plywood-adopt";
export const ADOPT_OP_FILE = "plywood.adopt.op.ts";

/** The parts of plunge's adopt document (chant `PlungeAdoptView`) init prints. */
export interface AdoptView {
  stack: string;
  status: "would-adopt" | "adopted" | "already-adopted" | "refused";
  checkpoint: { source?: string; digest?: string };
  resources: Array<{ urn: string; type: string; id: string; fate: string }>;
  refusals: Array<{ code: string; urn?: string; reason: string }>;
}

/** One stack's preview as init reports it. */
export interface AdoptPreview {
  key: string;
  backend: string;
  /** The command, for the person to run by hand. */
  command: string;
  view?: AdoptView;
  /** Why there is no document: plunge missing, a failed run, no adopt support in the installed lexicon. */
  error?: string;
}

/** What plywood calls from chant's pulumi lexicon. */
export interface ChantAdopt {
  /** `plunge stack adopt --json --stack <stack>` in `dir` with PULUMI_BACKEND_URL=`backend`, through chant's allowlist. */
  preview(input: { dir: string; stack: string; backend: string }): Promise<AdoptView>;
  /** True when the lexicon exports `PulumiAdoptOp`. */
  hasOp: boolean;
}

type Runner = (args: string[], opts: { cwd: string; env?: Record<string, string> }) => Promise<{ stdout: string }>;

let cached: Promise<ChantAdopt | undefined> | undefined;

/** chant's adopt pieces, or undefined when the installed pulumi lexicon lacks them. */
export function chantAdopt(): Promise<ChantAdopt | undefined> {
  cached ??= (async () => {
    try {
      // @ts-ignore: plungeAdoptArgs and runAllowedPlunge's env are missing from older lexicons (chant#4562).
      const run: Record<string, unknown> = await import("@intentius/chant-lexicon-pulumi/run");
      // @ts-ignore: parsePlungeAdoptView and PulumiAdoptOp are missing from older lexicons (chant#4562).
      const lexicon: Record<string, unknown> = await import("@intentius/chant-lexicon-pulumi");
      const args = run.plungeAdoptArgs as ((o: { stack: string }) => string[]) | undefined;
      const allowed = run.runAllowedPlunge as ((r: Runner, a: string[], cwd: string, env?: Record<string, string>) => Promise<{ stdout: string }>) | undefined;
      const runner = run.defaultPlungeRunner as Runner | undefined;
      const parse = lexicon.parsePlungeAdoptView as ((t: string | undefined) => AdoptView | undefined) | undefined;
      const failure = run.pulumiRunFailure as ((e: unknown) => { stdout?: string; stderr?: string; message: string; missingBinary?: boolean }) | undefined;
      if (typeof args !== "function" || typeof allowed !== "function" || typeof runner !== "function" || typeof parse !== "function") return undefined;
      return {
        hasOp: typeof lexicon.PulumiAdoptOp === "function",
        async preview({ dir, stack, backend }) {
          try {
            const { stdout } = await allowed(runner, args({ stack }), dir, { PULUMI_BACKEND_URL: backend });
            const view = parse(stdout);
            if (!view) throw new Error("plunge printed no adopt document");
            return view;
          } catch (err) {
            const f = failure ? failure(err) : { message: (err as Error).message };
            const view = parse(f.stdout);
            if (view) return view;
            if (f.missingBinary) throw new Error("the plunge binary was not found on PATH");
            throw new Error((f.stderr?.trim() || f.message).split("\n").slice(-3).join("\n"));
          }
        },
      };
    } catch {
      return undefined;
    }
  })();
  return cached;
}

/** Tests stand in a fake (or none). `reset` goes back to the real import. */
export function setChantAdoptForTests(fake: ChantAdopt | undefined | "reset"): void {
  cached = fake === "reset" ? undefined : Promise.resolve(fake);
}

/** The preview command for one stack, as the person would type it. */
export function adoptCommand(s: Pick<PlungeStack, "dir" | "stack">, backend: string): string {
  const cd = s.dir === "." ? "" : `cd ${s.dir} && `;
  return `${cd}PULUMI_BACKEND_URL='${backend}' plunge stack adopt --json --stack ${s.stack}`;
}

/** The message when the installed pulumi lexicon has no adopt support. */
export const NEEDS_ADOPT_MESSAGE =
  "the adopt previews and the adopt Op need @intentius/chant-lexicon-pulumi >= the release after 0.124.54 (chant#4562); run each preview by hand:";

/** Each stack's adopt preview. Runs nothing when `chant` is undefined. */
export async function adoptPreviews(
  stacks: ReadonlyArray<Pick<PlungeStack, "key" | "dir" | "stack"> & { url: string }>,
  chant: ChantAdopt | undefined,
  root: string,
): Promise<AdoptPreview[]> {
  const out: AdoptPreview[] = [];
  for (const s of stacks) {
    const command = adoptCommand(s, s.url);
    if (!chant) {
      out.push({ key: s.key, backend: s.url, command, error: "not run" });
      continue;
    }
    try {
      const view = await chant.preview({ dir: s.dir === "." ? root : `${root}/${s.dir}`, stack: s.stack, backend: s.url });
      out.push({ key: s.key, backend: s.url, command, view });
    } catch (e) {
      out.push({ key: s.key, backend: s.url, command, error: (e as Error).message });
    }
  }
  return out;
}

/** Counts by fate, as `record 10, marker 2`. */
function fates(view: AdoptView): string {
  const n: Record<string, number> = {};
  for (const r of view.resources) n[r.fate] = (n[r.fate] ?? 0) + 1;
  return Object.entries(n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([f, c]) => `${f} ${c}`)
    .join(", ");
}

/** The lines init prints for the previews. */
export function adoptLines(previews: readonly AdoptPreview[], chant: ChantAdopt | undefined): string[] {
  if (previews.length === 0) return [];
  if (!chant) return [NEEDS_ADOPT_MESSAGE, ...previews.map((p) => `  ${p.key}: ${p.command}`)];
  const out = ["Adopt previews (plunge stack adopt --json, which writes nothing):"];
  for (const p of previews) {
    const v = p.view;
    if (!v) {
      out.push(`  ${p.key}: not previewed; ${p.error}. Run it by hand: ${p.command}`);
      continue;
    }
    const count = `${v.resources.length} resource${v.resources.length === 1 ? "" : "s"}`;
    if (v.status === "refused") {
      out.push(`  ${p.key}: plunge refuses to adopt it, so the adopt Op leaves it out:`);
      for (const r of v.refusals) out.push(`    ${r.code}: ${r.reason}${r.urn ? ` (${r.urn})` : ""}`);
    } else if (v.status === "already-adopted") {
      out.push(`  ${p.key}: already on plunge's records (${count})`);
    } else if (v.status === "adopted") {
      out.push(`  ${p.key}: adopted (${count})`);
    } else {
      out.push(`  ${p.key}: would adopt ${count}${v.resources.length ? ` (${fates(v)})` : ""}`);
    }
  }
  return out;
}

/**
 * The stacks the Op adopts: those with a plunge URL whose preview neither said
 * they are adopted already nor was refused. A refused stack would fail the
 * Op's own preview step before the stacks after it ran; init's notes list it
 * with plunge's refusals instead (plywood#22).
 */
export function stacksToAdopt<T extends { key: string }>(stacks: readonly T[], previews: readonly AdoptPreview[]): T[] {
  return stacks.filter((s) => {
    const status = previews.find((p) => p.key === s.key)?.view?.status;
    return status !== "already-adopted" && status !== "refused";
  });
}

/** The gate chant's PulumiAdoptOp names for a stack (`approve-<op>`, or `approve-<op>-<member>-<stack>` with several). */
export function adoptGate(member: string, stack: string, single: boolean): string {
  return single ? `approve-${ADOPT_OP}` : `approve-${ADOPT_OP}-${member}-${stack}`;
}

/** `plywood.adopt.op.ts`: chant's PulumiAdoptOp over the stacks, each with its plunge URL. */
export function adoptOpFile(stacks: ReadonlyArray<{ member: string; dir: string; stack: string; url: string }>): string {
  const rows = stacks.map(
    (s) => `    { member: ${JSON.stringify(s.member)}, dir: ${JSON.stringify(s.dir)}, stack: ${JSON.stringify(s.stack)}, backend: ${JSON.stringify(s.url)} },`,
  );
  return [
    'import { PulumiAdoptOp } from "@intentius/chant-lexicon-pulumi";',
    "",
    "/**",
    " * Written by plywood init --engine plunge. Adopts each stack onto plunge's",
    " * per-resource records: the bucket check, the stock export kept as the",
    " * back-out copy, then per stack the adopt preview, a gate bound to it, and",
    " * plunge stack adopt --yes.",
    " *",
    ` *   npx chant run ${ADOPT_OP}             stops at each stack's gate`,
    ` *   npx chant approve ${ADOPT_OP} <gate>  after reading that stack's preview`,
    ` *   npx chant run ${ADOPT_OP}             adopts the approved stacks`,
    " *",
    " * Delete this file once every stack is adopted.",
    " */",
    "export const { op } = PulumiAdoptOp({",
    `  name: ${JSON.stringify(ADOPT_OP)},`,
    "  stacks: [",
    ...rows,
    "  ],",
    "});",
    "",
  ].join("\n");
}

/** The todo lines for running the Op. */
export function adoptTodo(stacks: ReadonlyArray<{ member: string; stack: string }>): string[] {
  const single = stacks.length === 1;
  const gates = stacks.map((s) => adoptGate(slug(s.member), slug(s.stack), single));
  return [
    `Adopt the stacks onto plunge before their first plunge update: npx chant run ${ADOPT_OP}, then npx chant approve ${ADOPT_OP} <gate> for each of ${gates.join(", ")} after reading its preview, then npx chant run ${ADOPT_OP} again`,
  ];
}
