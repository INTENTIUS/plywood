/**
 * `engine` and `backend`, the two keys chant's pulumi lexicon reads from
 * plywood.yml itself (chant#4559, `readPlywoodEngine`): `engine` is
 * `pulumi` or `plunge`, `backend` a URL string, and a `plunge+` or `plunge:`
 * backend means plunge. plywood keeps them top-level strings so chant reads
 * them as plywood does, and also hands each member its engine and backend
 * as the member's config, the rule chant asks first.
 *
 * Engine detection stays in chant: with neither key set, plywood names no
 * engine and chant decides from PULUMI_BACKEND_URL and Pulumi.yaml.
 */
import { stacksOf } from "./stacks";
import { BACKEND_SCHEMA, error, oneOf, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";

export const ENGINES = ["pulumi", "plunge"] as const;
export type Engine = (typeof ENGINES)[number];

/** The backend URL forms chant's pulumi lexicon takes as plunge (member-engine.ts `PLUNGE_URL`). */
export const PLUNGE_URL = /^plunge[+:]/;

/** The engine plywood.yml names for a stack's backend, or for all stacks, and why; undefined leaves it to chant. */
export function engineOf(doc: RawConfig, backend?: string): { engine: Engine; because: string } | undefined {
  if (doc.engine === "pulumi" || doc.engine === "plunge") return { engine: doc.engine, because: `plywood.yml says engine: ${doc.engine}` };
  const url = backend ?? (typeof doc.backend === "string" ? doc.backend : undefined);
  if (url && PLUNGE_URL.test(url)) return { engine: "plunge", because: `the backend ${url} is plunge's` };
  return undefined;
}

export const engine: ConfigGroup = {
  name: "engine",
  keys: ["engine", "backend"],
  schema: {
    engine: { type: "string", enum: [...ENGINES], description: "pulumi or plunge. Absent, a plunge+ backend picks plunge, else chant reads PULUMI_BACKEND_URL and Pulumi.yaml." },
    backend: BACKEND_SCHEMA,
  },
  check(doc) {
    const out: ConfigProblem[] = [...oneOf(doc.engine, ENGINES, "engine")];
    if (doc.backend !== undefined && typeof doc.backend !== "string") out.push(error("backend", "must be a URL string"));
    if (doc.engine === "pulumi") {
      const backends: [string, unknown][] = [["backend", doc.backend], ...Object.entries(stacksOf(doc)).map(([n, s]): [string, unknown] => [`stacks.${n}.backend`, s?.backend])];
      for (const [key, url] of backends) {
        if (typeof url === "string" && PLUNGE_URL.test(url)) {
          out.push(error(key, `${url} is a plunge backend and engine is pulumi; set engine: plunge, or give a stock backend URL`));
        }
      }
    }
    return out;
  },
  translate(doc, out) {
    const all = engineOf(doc);
    if (all) out.memberDefaults.engine = all.engine;
    if (typeof doc.backend === "string") out.memberDefaults.backend = doc.backend;
    for (const m of out.members) {
      if (m.backend === undefined && typeof doc.backend === "string") m.backend = doc.backend;
      const e = engineOf(doc, m.backend);
      if (e) m.engine = e.engine;
    }
  },
};
