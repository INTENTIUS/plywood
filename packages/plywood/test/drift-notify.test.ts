/**
 * The drift event (plywood#30): one signed event per run to a loopback
 * webhook, through the pinned chant's driftNotifyFields (which computes the
 * fingerprint from the stacks, chant#4944), productSendOptions,
 * makeNotifyEvent and sendNotify. Nothing leaves 127.0.0.1.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertProductWords } from "@intentius/chant/ci-product";
import { verifyWebhook } from "@intentius/chant/notify";
import { parseConfig } from "../src/config/index";
import { chantNotifyOf } from "../src/config/observe";
import { driftNotifyVariables } from "../src/drift";
import { driftRunFingerprint } from "@intentius/chant/drift-issue";
import { chantDriftNotify, notifiesDrift, sendDriftNotice, type ChantDriftNotify, type DriftNoticeStack } from "../src/drift-notify";
import { PRODUCT_WORDS } from "../src/words";

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

/** The pinned chant's drift fields and notify, in plywood's words. */
const chant: ChantDriftNotify = { ...(await chantDriftNotify()), words: assertProductWords(PRODUCT_WORDS) };

const record = { member: "shop", address: "urn:pulumi:dev::shop::aws:s3/bucket:Bucket::assets", status: "drifted" as const, attributes: [{ path: "tags" }] };
const results = (issue?: string): DriftNoticeStack[] => [
  { stack: "shop/dev", ok: true, drifted: 1, records: [record], ...(issue ? { issue: { action: issue } } : {}) },
  { stack: "shop/prod", ok: true, drifted: 0, records: [] },
];
const notify = chantNotifyOf(parseConfig("notify: { webhook: { url: DRIFT_HOOK_URL, key: DRIFT_HOOK_KEY }, on: [drift] }\n").doc);
const env = () => ({ DRIFT_HOOK_URL: url, DRIFT_HOOK_KEY: KEY });

describe("the drift event", () => {
  it("one signed event per run, in plywood's words, with the drifted stacks and the fingerprint", async () => {
    received.length = 0;
    const notice = await sendDriftNotice({ notify, results: results("edited"), chant, env: env(), log: () => {} });
    expect(notice).toMatchObject({ sent: true, fingerprint: driftRunFingerprint(results().slice(0, 1)) });
    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(verifyWebhook({ body, headers: headers as Record<string, string>, key: KEY, prefix: "x-plywood" })).toMatchObject({ ok: true });
    const event = JSON.parse(body) as { source: string; event: string; targets: string[]; drift: { fingerprint: string } };
    expect(event).toMatchObject({ source: "plywood", event: "drift", targets: ["shop/dev"], drift: { fingerprint: notice!.fingerprint } });
  });

  it("sends nothing when every drifted stack's issue already holds the finding", async () => {
    received.length = 0;
    const notice = await sendDriftNotice({ notify, results: results("unchanged"), chant, env: env(), log: () => {} });
    expect(notice).toMatchObject({ sent: false, reason: expect.stringContaining("already holds"), fingerprint: driftRunFingerprint(results().slice(0, 1)) });
    expect(received).toEqual([]);
  });

  it("nothing to send with no drift, or when notify.on leaves drift out", async () => {
    expect(await sendDriftNotice({ notify, results: [{ stack: "shop/dev", ok: true, drifted: 0, records: [] }], chant, env: env(), log: () => {} })).toBeUndefined();
    const waves = chantNotifyOf(parseConfig("notify: { slack: { webhook: SLACK_URL }, on: [wave-waiting] }\n").doc);
    expect(notifiesDrift(waves)).toBe(false);
    expect(await sendDriftNotice({ notify: waves, results: results(), chant, env: env(), log: () => {} })).toBeUndefined();
  });
});

describe("the scheduled drift job", () => {
  it("maps each notify variable from the secret of its name, except on GitLab", () => {
    expect(driftNotifyVariables("github", notify)).toEqual({ DRIFT_HOOK_URL: "${{ secrets.DRIFT_HOOK_URL }}", DRIFT_HOOK_KEY: "${{ secrets.DRIFT_HOOK_KEY }}" });
    expect(driftNotifyVariables("gitlab", notify)).toEqual({});
    expect(driftNotifyVariables("github", undefined)).toEqual({});
  });
});
