/**
 * The audit record in the reports bucket: `audit.jsonl`, one `chant.audit/v1`
 * line per approval request, approval, override, revocation and update
 * (chant#5336). chant builds the lines from the gate ledger and appends the
 * ones the record lacks (`auditLinesFromLedger`, `writeAuditRecord` in
 * `@intentius/chant/report-store`); plywood names the project and the
 * product and passes the bucket. `plywood estate` writes the record beside
 * the estate page, and `plywood audit record` reads it.
 *
 * The modules load on first use, as plywood's other chant imports do.
 */
import { PRODUCT } from "./words";

/** One `chant.audit/v1` line, the fields plywood reads. */
export interface AuditLineView {
  schema: string;
  product: string;
  id: string;
  kind: string;
  project: string;
  environment?: string;
  at: string;
  who: string | null;
  what: string;
  digest: string | null;
  result: string;
  evidence: Record<string, unknown>;
  detail?: Record<string, unknown>;
  product_kind?: string;
  product_fields?: Record<string, unknown>;
}

/** The part of `@intentius/chant/report-store` plywood calls. */
export interface ChantReportStore {
  AUDIT_RECORD_FILE: string;
  auditLinesFromLedger(entries: readonly unknown[], options: { product: string; project: string; environment?: string; branch?: string }): AuditLineView[];
  writeAuditRecord(lines: readonly AuditLineView[], options: { put: unknown; get: unknown; key?: string }): Promise<{ key: string; added: number }>;
  readAuditRecord(text: string, options?: Record<string, unknown>): { lines: AuditLineView[]; unreadable: number[] };
}

/** The part of the gate ledger's reader and `deriveGateAudit` plywood calls. */
export interface ChantGateAudit {
  deriveGateAudit(input: { ledgers: readonly unknown[]; applies?: readonly unknown[] }): { entries: unknown[]; gaps: Array<{ kind?: string; message?: string }> };
  readGateAuditLedgers(port: { read(op: string): Promise<unknown> }, ops: readonly string[]): Promise<unknown[]>;
}

/** An apply the ledger holds, as `applied.jsonl` records it. */
export interface AppliedRecordView {
  op: string;
  gate: string;
  planDigest: string;
  approvedBy: string;
  timestamp: string;
  runId?: string;
  commit?: string;
  wave?: { number: number; name: string };
}

export interface GateLedgerPortView {
  read(op: string): Promise<{ resolutions: unknown[]; pending: unknown[] }>;
  readApplied?(op: string): Promise<AppliedRecordView[]>;
}

let store: Promise<ChantReportStore> | undefined;
let gate: Promise<ChantGateAudit & { gitGateLedgerPort(opts?: { cwd?: string }): GateLedgerPortView }> | undefined;

/** chant's report store (chant#5336). */
export function chantReportStore(): Promise<ChantReportStore> {
  store ??= import("@intentius/chant/report-store").then((m) => m as unknown as ChantReportStore);
  return store;
}

/** chant's gate audit and git ledger port. */
export function chantGateAudit() {
  gate ??= (async () => {
    const a = await import("@intentius/chant/lifecycle/gate-audit");
    const o = await import("@intentius/chant/op");
    return { deriveGateAudit: a.deriveGateAudit, readGateAuditLedgers: a.readGateAuditLedgers, gitGateLedgerPort: o.gitGateLedgerPort } as unknown as ChantGateAudit & { gitGateLedgerPort(opts?: { cwd?: string }): GateLedgerPortView };
  })();
  return gate;
}

/** Tests stand in chant's report store and gate audit. `reset` goes back to the real imports. */
export function setChantAuditRecordForTests(fake: { store: ChantReportStore; gate: Awaited<ReturnType<typeof chantGateAudit>> } | "reset"): void {
  store = fake === "reset" ? undefined : Promise.resolve(fake.store);
  gate = fake === "reset" ? undefined : Promise.resolve(fake.gate);
}

/** The ops the gate ledger holds rows for, from the `gates` table of the estate read. */
export function gateOpsOf(load: unknown): string[] {
  const data = (load as { data?: { gates?: Array<{ op?: unknown }> } } | undefined)?.data;
  const ops = new Set<string>();
  for (const r of data?.gates ?? []) if (typeof r.op === "string" && r.op !== "") ops.add(r.op);
  return [...ops].sort();
}

/**
 * The audit lines of the gate ledger at `cwd`: each op's pending facts and
 * resolutions, with the applies `applied.jsonl` records. `project` is the
 * repository or workspace the lines belong to.
 */
export async function auditLinesOf(cwd: string, ops: readonly string[], project: string): Promise<AuditLineView[]> {
  const s = await chantReportStore();
  const g = await chantGateAudit();
  const port = g.gitGateLedgerPort({ cwd });
  const ledgers = await g.readGateAuditLedgers(port, ops);
  const applies: unknown[] = [];
  if (port.readApplied) {
    for (const op of ops) {
      const rows = await port.readApplied(op);
      rows.forEach((a, i) =>
        applies.push({
          ref: `_gates/${op}/applied.jsonl:${i + 1}`,
          at: a.timestamp,
          gate: a.gate,
          op: a.op,
          digest: a.planDigest,
          by: a.approvedBy,
          detail: { ...(a.runId ? { runId: a.runId } : {}), ...(a.commit ? { commit: a.commit } : {}), ...(a.wave ? { wave: a.wave } : {}) },
        }),
      );
    }
  }
  const { entries } = g.deriveGateAudit({ ledgers, applies });
  return s.auditLinesFromLedger(entries, { product: PRODUCT, project });
}

/** `audit.jsonl`'s text as chant reads it, every line as `chant.audit/v1` whichever format wrote it. */
export async function readAuditText(text: string): Promise<{ lines: AuditLineView[]; unreadable: number[] }> {
  return (await chantReportStore()).readAuditRecord(text);
}
