/**
 * The drift event `plywood drift` sends (plywood#30). When plywood.yml's
 * `notify.on` takes `drift` (or `notify.on` is left out, which takes every
 * event) and a run finds drift, the run sends one signed event through
 * chant's notify with plywood's words: chant's `driftNotifyFields` and
 * `productSendOptions` on `@intentius/chant/ci-product` (chant#4610), and
 * `makeNotifyEvent` and `sendNotify` on `@intentius/chant/notify`. The
 * event names the drifted stacks, the ones whose read failed, and the run's
 * fingerprint (each drifted stack's finding fingerprint, hashed together).
 *
 * A run whose finding is the last run's sends nothing. The last finding is
 * the drift issues: each drifted stack's issue carries its fingerprint, and
 * chant's `trackIssue` answers `unchanged` when the finding is the same. So
 * a run with `--forge` whose every drifted stack's issue is unchanged sends
 * nothing; a run without issues (no `--forge`, or `respond.drift: none`)
 * has no last finding and sends on every drift.
 *
 * A failed delivery is a line on stderr and never changes the exit code.
 */
import { createHash } from "node:crypto";
import type { ChantNotifyConfig } from "./config/observe";
import type { DriftRow } from "./words";

/** One stack's read, as the notice reads it. */
export interface DriftNoticeStack {
  stack: string;
  ok: boolean;
  drifted: number;
  rows: DriftRow[];
  issue?: { action: string };
}

/** The part of chant plywood calls to send the event. */
export interface ChantDriftNotify {
  driftNotifyFields(words: unknown, input: { changed: string[]; failed?: string[]; fingerprint?: string; project?: string; environment?: string }): unknown;
  productSendOptions(words: unknown, options?: Record<string, unknown>): Record<string, unknown>;
  makeNotifyEvent(fields: unknown, options?: { env?: NodeJS.ProcessEnv }): unknown;
  sendNotify(config: unknown, event: unknown, options?: Record<string, unknown>): Promise<Array<{ target: string; ok: boolean; detail: string }>>;
  /** chant's resolved words for plywood (`assertProductWords`). */
  words: unknown;
}

/** What the run did about the event, for the output. */
export interface DriftNotice {
  sent: boolean;
  /** Why nothing was sent, when nothing was. */
  reason?: string;
  fingerprint?: string;
  deliveries?: Array<{ target: string; ok: boolean; detail: string }>;
}

/** The run's fingerprint: each drifted stack and its finding's, sorted, hashed. */
export function runFingerprint(results: readonly DriftNoticeStack[], stackFingerprint: (rows: readonly DriftRow[]) => string): string {
  const parts = results.filter((r) => r.ok && r.drifted > 0).map((r) => `${r.stack}\t${stackFingerprint(r.rows)}`).sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/** Whether `notify` takes the drift event. */
export function notifiesDrift(notify: ChantNotifyConfig | undefined): boolean {
  return notify !== undefined && (notify.events === undefined || notify.events.includes("drift"));
}

/** Send the run's drift event, or say why not. */
export async function sendDriftNotice(input: {
  notify: ChantNotifyConfig | undefined;
  results: readonly DriftNoticeStack[];
  stackFingerprint: (rows: readonly DriftRow[]) => string;
  chant: ChantDriftNotify;
  env: NodeJS.ProcessEnv;
  environment?: string;
  log: (line: string) => void;
  /** Tests pass a loopback fetch. */
  fetch?: unknown;
}): Promise<DriftNotice | undefined> {
  if (!notifiesDrift(input.notify)) return undefined;
  const drifted = input.results.filter((r) => r.ok && r.drifted > 0);
  if (drifted.length === 0) return undefined;
  const fingerprint = runFingerprint(input.results, input.stackFingerprint);
  if (drifted.every((r) => r.issue?.action === "unchanged")) {
    return { sent: false, reason: "no drift event was sent: every drifted stack's finding is the one its issue already holds", fingerprint };
  }
  const failed = input.results.filter((r) => !r.ok).map((r) => r.stack);
  const c = input.chant;
  const fields = c.driftNotifyFields(c.words, {
    changed: drifted.map((r) => r.stack),
    ...(failed.length ? { failed } : {}),
    fingerprint,
    ...(input.environment ? { environment: input.environment } : {}),
  });
  const event = c.makeNotifyEvent(fields, { env: input.env });
  const deliveries = await c.sendNotify(input.notify, event, c.productSendOptions(c.words, { env: input.env, log: input.log, ...(input.fetch ? { fetch: input.fetch } : {}) }));
  return { sent: deliveries.some((d) => d.ok), fingerprint, deliveries, ...(deliveries.some((d) => d.ok) ? {} : { reason: "no drift event was delivered" }) };
}

let loaded: Promise<Omit<ChantDriftNotify, "words">> | undefined;

/** chant's drift fields and notify (chant#4610). */
export function chantDriftNotify(): Promise<Omit<ChantDriftNotify, "words">> {
  loaded ??= (async () => {
    const product = await import("@intentius/chant/ci-product");
    const notify = await import("@intentius/chant/notify");
    return {
      driftNotifyFields: product.driftNotifyFields as unknown as ChantDriftNotify["driftNotifyFields"],
      productSendOptions: product.productSendOptions as unknown as ChantDriftNotify["productSendOptions"],
      makeNotifyEvent: notify.makeNotifyEvent as unknown as ChantDriftNotify["makeNotifyEvent"],
      sendNotify: notify.sendNotify as unknown as ChantDriftNotify["sendNotify"],
    };
  })();
  return loaded;
}

/** Tests stand in chant's notify; `reset` goes back to the real imports. */
export function setChantDriftNotifyForTests(fake: Omit<ChantDriftNotify, "words"> | "reset"): void {
  loaded = fake === "reset" ? undefined : Promise.resolve(fake);
}
