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

let cached: Promise<PulumiReferenceReader> | undefined;

/** chant's StackReference reader (chant#4547) and its export reads (chant#4546). */
export function chantReferenceReader(): Promise<PulumiReferenceReader> {
  cached ??= (async () => {
    const lexicon = await import("@intentius/chant-lexicon-pulumi");
    const run = await import("@intentius/chant-lexicon-pulumi/run");
    return {
      pulumiStackReferences: lexicon.pulumiStackReferences as unknown as PulumiReferenceReader["pulumiStackReferences"],
      stackReferenceOwner: lexicon.stackReferenceOwner as unknown as PulumiReferenceReader["stackReferenceOwner"],
      memberExportOf: run.memberExportOf as unknown as PulumiReferenceReader["memberExportOf"],
      readMemberExport: lexicon.readMemberExport as unknown as PulumiReferenceReader["readMemberExport"],
    };
  })();
  return cached;
}

/** Tests stand in a reader. `reset` goes back to the real import. */
export function setReferenceReaderForTests(fake: PulumiReferenceReader | "reset"): void {
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
  return { edges, outside };
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
  for (const e of order.edges) out.push(`${e.reader} updates after ${e.upstream} (${e.because === "stack-reference" ? "its StackReference" : "waves.after"})`);
  for (const o of order.outside) out.push(`${o.stack}'s StackReference ${o.reference} orders nothing: ${o.why}`);
  for (const u of unmet) out.push(`${u.reader} should update after ${u.upstream}, and cannot: ${u.why}; list them in one wave, or reorder waves`);
  return out;
}
