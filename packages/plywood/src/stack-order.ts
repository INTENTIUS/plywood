/**
 * The order stacks update in on merge (plywood#18). Two things order them:
 *
 *   StackReferences  read by chant's pulumi lexicon (chant#4547) from each
 *                    stack's last export: the one the pulumi-up step kept in
 *                    the index store, else a checked-in stack-export.json.
 *                    The pull request's previews already follow them, since
 *                    chant turns each reference into a read between the
 *                    stacks' components; this module gives the merge's
 *                    waves the same order.
 *   waves.after      plywood.yml's hand-written order, for a reference chant
 *                    cannot see yet (a stack's first update, outputs that are
 *                    all secret). It also becomes the components' dependsOn.
 *
 * `waves.canary` puts its stacks in a first wave of their own. Each wave is
 * then cut into as many waves as its stacks' order needs, the stack read
 * first. A reference that points at a later wave cannot be met by cutting
 * and is named, as is a reference to a stack this repository does not list.
 *
 * The reader is a feature-detect: a pulumi lexicon without
 * `pulumiStackReferences` gives no edges, and the waves follow
 * `waves.after` alone.
 */
import { join } from "node:path";
import type { InitStack } from "./init/render";

/** One stack that updates after another: `reader` reads `upstream`'s outputs, or plywood.yml says so. */
export interface StackEdge {
  reader: string;
  upstream: string;
  because: "stack-reference" | "waves.after";
}

export interface StackOrder {
  edges: StackEdge[];
  /** References that add no edge, each with the reason. */
  outside: Array<{ stack: string; reference: string; why: string }>;
  /** True when the installed pulumi lexicon reads StackReferences. */
  reads: boolean;
}

/** What plywood calls from `@intentius/chant-lexicon-pulumi` (chant#4547) and its `/run` (chant#4546). */
interface PulumiReferenceReader {
  pulumiStackReferences(exported: unknown): Array<{ name: string; project?: string; stack: string }>;
  stackReferenceOwner(
    ref: { name: string; project?: string; stack: string },
    reader: { component: string; project: string },
    owners: ReadonlyArray<{ component: string; project: string; stack: string }>,
  ): { owner: { component: string } } | { outside: string };
  memberExportOf?(dir: string, opts?: { stack?: string }): Promise<unknown>;
  readMemberExport?(dir: string): unknown;
}

let cached: Promise<PulumiReferenceReader | undefined> | undefined;

/** chant's StackReference reader, or undefined when the installed pulumi lexicon lacks it. */
export function chantReferenceReader(): Promise<PulumiReferenceReader | undefined> {
  cached ??= (async () => {
    try {
      const lexicon: Record<string, unknown> = await import("@intentius/chant-lexicon-pulumi");
      if (typeof lexicon.pulumiStackReferences !== "function" || typeof lexicon.stackReferenceOwner !== "function") return undefined;
      let run: Record<string, unknown> = {};
      try {
        run = await import("@intentius/chant-lexicon-pulumi/run");
      } catch {
        // The index store's export needs /run; the checked-in one is read through the lexicon's readMemberExport.
      }
      return {
        pulumiStackReferences: lexicon.pulumiStackReferences as PulumiReferenceReader["pulumiStackReferences"],
        stackReferenceOwner: lexicon.stackReferenceOwner as PulumiReferenceReader["stackReferenceOwner"],
        ...(typeof run.memberExportOf === "function" ? { memberExportOf: run.memberExportOf as PulumiReferenceReader["memberExportOf"] } : {}),
        ...(typeof lexicon.readMemberExport === "function" ? { readMemberExport: lexicon.readMemberExport as PulumiReferenceReader["readMemberExport"] } : {}),
      };
    } catch {
      return undefined;
    }
  })();
  return cached;
}

/** Tests stand in a reader (or none). `reset` goes back to the real import. */
export function setReferenceReaderForTests(fake: PulumiReferenceReader | undefined | "reset"): void {
  cached = fake === "reset" ? undefined : Promise.resolve(fake);
}

/** The stack's last export, as chant reads it for the stack's own reads. */
async function exportOf(reader: PulumiReferenceReader, root: string, s: Pick<InitStack, "dir" | "stack">): Promise<unknown> {
  const dir = join(root, s.dir);
  if (reader.memberExportOf) {
    try {
      const found = await reader.memberExportOf(dir, { stack: s.stack });
      if (found !== undefined) return found;
    } catch {
      // No index store reachable from here: the checked-in export below.
    }
  }
  return reader.readMemberExport?.(dir);
}

/** Every edge between `stacks`: their StackReferences, read from each export, and `after`. */
export async function stackOrder(root: string, stacks: readonly InitStack[], after: Readonly<Record<string, readonly string[]>> = {}): Promise<StackOrder> {
  const edges: StackEdge[] = [];
  const outside: StackOrder["outside"] = [];
  const keys = new Set(stacks.map((s) => s.key));
  const add = (e: StackEdge): void => {
    if (!edges.some((x) => x.reader === e.reader && x.upstream === e.upstream)) edges.push(e);
  };
  for (const [reader, ups] of Object.entries(after)) {
    for (const upstream of ups) if (keys.has(reader) && keys.has(upstream)) add({ reader, upstream, because: "waves.after" });
  }
  const reader = await chantReferenceReader();
  if (!reader) return { edges, outside, reads: false };
  const owners = stacks.map((s) => ({ component: s.key, project: s.project, stack: s.stack }));
  for (const s of stacks) {
    const exported = await exportOf(reader, root, s);
    if (exported === undefined) continue;
    for (const ref of reader.pulumiStackReferences(exported)) {
      const found = reader.stackReferenceOwner(ref, { component: s.key, project: s.project }, owners);
      if ("owner" in found) add({ reader: s.key, upstream: found.owner.component, because: "stack-reference" });
      else outside.push({ stack: s.key, reference: ref.name, why: found.outside });
    }
  }
  return { edges, outside, reads: true };
}

export interface OrderedWave<S> {
  name: string;
  stacks: S[];
}

/**
 * The waves with the canary first and each wave cut by `edges`: a stack
 * goes in the first cut after every stack it reads within its wave. Returns
 * the waves and the edges no cut can meet (the stack read updates in a
 * later wave, or the stacks read each other).
 */
export function orderWaves<S extends { key: string }>(
  waves: ReadonlyArray<OrderedWave<S>>,
  edges: readonly StackEdge[],
  canary: readonly string[] = [],
): { waves: OrderedWave<S>[]; unmet: Array<StackEdge & { why: string }> } {
  const unmet: Array<StackEdge & { why: string }> = [];
  const firsts = canary.length ? waves.flatMap((w) => w.stacks.filter((s) => canary.includes(s.key))) : [];
  const rest = waves.map((w) => ({ name: w.name, stacks: w.stacks.filter((s) => !canary.includes(s.key)) })).filter((w) => w.stacks.length > 0);
  const listed: OrderedWave<S>[] = [...(firsts.length ? [{ name: "canary", stacks: firsts }] : []), ...rest];

  const waveOf = new Map<string, number>();
  listed.forEach((w, i) => w.stacks.forEach((s) => waveOf.set(s.key, i)));
  for (const e of edges) {
    const r = waveOf.get(e.reader);
    const u = waveOf.get(e.upstream);
    if (r !== undefined && u !== undefined && u > r) unmet.push({ ...e, why: `${e.upstream} updates in ${listed[u]!.name}, after ${e.reader}'s wave ${listed[r]!.name}` });
  }

  const out: OrderedWave<S>[] = [];
  for (const w of listed) {
    const inWave = new Set(w.stacks.map((s) => s.key));
    const ups = new Map<string, string[]>(w.stacks.map((s) => [s.key, edges.filter((e) => e.reader === s.key && inWave.has(e.upstream)).map((e) => e.upstream)]));
    const layer = new Map<string, number>();
    const open = new Set<string>();
    const depth = (k: string): number => {
      const known = layer.get(k);
      if (known !== undefined) return known;
      if (open.has(k)) return 0;
      open.add(k);
      let d = 0;
      for (const u of ups.get(k) ?? []) {
        if (open.has(u)) {
          const e = edges.find((x) => x.reader === k && x.upstream === u)!;
          unmet.push({ ...e, why: `${k} and ${u} read each other` });
          continue;
        }
        d = Math.max(d, depth(u) + 1);
      }
      open.delete(k);
      layer.set(k, d);
      return d;
    };
    for (const s of w.stacks) depth(s.key);
    const count = Math.max(0, ...layer.values()) + 1;
    for (let i = 0; i < count; i++) {
      const stacks = w.stacks.filter((s) => layer.get(s.key) === i);
      if (stacks.length) out.push({ name: i === 0 ? w.name : `${w.name}-${i + 1}`, stacks });
    }
  }
  return { waves: out, unmet };
}

/** The lines init prints for the order: each edge that cut a wave, each reference left out, each edge unmet. */
export function orderLines(order: StackOrder, unmet: ReadonlyArray<StackEdge & { why: string }>): string[] {
  const out: string[] = [];
  if (!order.reads) out.push("the installed @intentius/chant-lexicon-pulumi reads no StackReferences (chant#4547), so the waves follow waves.after alone");
  for (const e of order.edges) out.push(`${e.reader} updates after ${e.upstream} (${e.because === "stack-reference" ? "its StackReference" : "waves.after"})`);
  for (const o of order.outside) out.push(`${o.stack}'s StackReference ${o.reference} orders nothing: ${o.why}`);
  for (const u of unmet) out.push(`${u.reader} should update after ${u.upstream}, and cannot: ${u.why}; list them in one wave, or reorder waves`);
  return out;
}
