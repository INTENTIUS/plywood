/**
 * The drift event (plywood#30): one signed event per run to a loopback
 * webhook, through the pinned chant's makeNotifyEvent and sendNotify, with
 * chant#4610's driftNotifyFields and productSendOptions stood in when the
 * installed chant lacks them. Nothing leaves 127.0.0.1.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifyEvent, sendNotify, verifyWebhook } from "@intentius/chant/notify";
import { parseConfig } from "../src/config/index";
import { chantNotifyOf } from "../src/config/observe";
import { driftFingerprint, driftNotifyVariables } from "../src/drift";
import { DRIFT_NOTIFY_NEEDS_CHANT, notifiesDrift, runFingerprint, sendDriftNotice, type ChantDriftNotify, type DriftNoticeStack } from "../src/drift-notify";

const KEY = "loopback-signing-key";
const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    res.writeHead(204).end();
  });
});
let url = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** chant#4610's two functions, as chant writes them, over the pinned notify. */
const chant: ChantDriftNotify = {
  words: { product: "plywood", noun: ["stack", "stacks"], notify: { source: "plywood", headers: "x-plywood" } },
  driftNotifyFields: (words, input) => {
    const w = words as { noun: [string, string]; notify: { source: string } };
    return { source: w.notify.source, event: "drift", summary: `${input.changed.length} ${w.noun[1]} drifted: ${input.changed.join(", ")}`, targets: input.changed, drift: { changed: input.changed, ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}) } };
  },
  productSendOptions: (words, options = {}) => ({ ...options, prefix: (words as { notify: { headers: string } }).notify.headers }),
  makeNotifyEvent: makeNotifyEvent as ChantDriftNotify["makeNotifyEvent"],
  sendNotify: sendNotify as ChantDriftNotify["sendNotify"],
};

const row = { urn: "urn:pulumi:dev::shop::aws:s3/bucket:Bucket::assets", status: "drifted", attributes: ["tags"] };
const results = (issue?: string): DriftNoticeStack[] => [
  { stack: "shop/dev", ok: true, drifted: 1, rows: [row], ...(issue ? { issue: { action: issue } } : {}) },
  { stack: "shop/prod", ok: true, drifted: 0, rows: [] },
];
const notify = chantNotifyOf(parseConfig("notify: { webhook: { url: DRIFT_HOOK_URL, key: DRIFT_HOOK_KEY }, on: [drift] }\n").doc);
const env = () => ({ DRIFT_HOOK_URL: url, DRIFT_HOOK_KEY: KEY });

describe("the drift event", () => {
  it("one signed event per run, in plywood's words, with the drifted stacks and the fingerprint", async () => {
    received.length = 0;
    const notice = await sendDriftNotice({ notify, results: results("edited"), stackFingerprint: driftFingerprint, chant, env: env(), log: () => {} });
    expect(notice).toMatchObject({ sent: true, fingerprint: runFingerprint(results(), driftFingerprint) });
    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(verifyWebhook({ body, headers: headers as Record<string, string>, key: KEY, prefix: "x-plywood" })).toMatchObject({ ok: true });
    const event = JSON.parse(body) as { source: string; event: string; targets: string[]; drift: { fingerprint: string } };
    expect(event).toMatchObject({ source: "plywood", event: "drift", targets: ["shop/dev"], drift: { fingerprint: notice!.fingerprint } });
  });

  it("sends nothing when every drifted stack's issue already holds the finding", async () => {
    received.length = 0;
    const notice = await sendDriftNotice({ notify, results: results("unchanged"), stackFingerprint: driftFingerprint, chant, env: env(), log: () => {} });
    expect(notice).toMatchObject({ sent: false, reason: expect.stringContaining("already holds") });
    expect(received).toEqual([]);
  });

  it("nothing to send with no drift, or when notify.on leaves drift out", async () => {
    expect(await sendDriftNotice({ notify, results: [{ stack: "shop/dev", ok: true, drifted: 0, rows: [] }], stackFingerprint: driftFingerprint, chant, env: env(), log: () => {} })).toBeUndefined();
    const waves = chantNotifyOf(parseConfig("notify: { slack: { webhook: SLACK_URL }, on: [wave-waiting] }\n").doc);
    expect(notifiesDrift(waves)).toBe(false);
    expect(await sendDriftNotice({ notify: waves, results: results(), stackFingerprint: driftFingerprint, chant, env: env(), log: () => {} })).toBeUndefined();
  });

  it("on a chant without driftNotifyFields the run says no event was sent", async () => {
    received.length = 0;
    const notice = await sendDriftNotice({ notify, results: results(), stackFingerprint: driftFingerprint, chant: undefined, env: env(), log: () => {} });
    expect(notice).toMatchObject({ sent: false, reason: DRIFT_NOTIFY_NEEDS_CHANT });
    expect(received).toEqual([]);
  });

  it("the same findings give the same fingerprint, in any order", () => {
    expect(runFingerprint([...results()].reverse(), driftFingerprint)).toBe(runFingerprint(results(), driftFingerprint));
  });
});

describe("the scheduled drift job", () => {
  it("maps each notify variable from the secret of its name, except on GitLab", () => {
    expect(driftNotifyVariables("github", notify)).toEqual({ DRIFT_HOOK_URL: "${{ secrets.DRIFT_HOOK_URL }}", DRIFT_HOOK_KEY: "${{ secrets.DRIFT_HOOK_KEY }}" });
    expect(driftNotifyVariables("gitlab", notify)).toEqual({});
    expect(driftNotifyVariables("github", undefined)).toEqual({});
  });
});
