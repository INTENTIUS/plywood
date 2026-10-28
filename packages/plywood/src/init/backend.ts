/**
 * Each stack's backend, and the bucket check on a self-managed one.
 *
 * The backend is the first that answers: the stack's own `backend` in
 * plywood.yml, plywood.yml's `backend`, `PULUMI_BACKEND_URL` in init's
 * environment, `backend.url` in the project's Pulumi.yaml. None of them
 * means Pulumi Cloud (or whatever `pulumi login` holds on the machine that
 * runs the job). A URL that only the environment gave is written into
 * plywood.yml, since the jobs do not see init's environment.
 *
 * An `s3://`, `gs://` or `azblob://` backend (with or without `plunge+`)
 * gets chant's shared bucket check (`@intentius/chant/bucket-check`,
 * chant#4558): versioning, a lifecycle rule that expires noncurrent
 * versions, and the public access block. The check only reads. It is
 * reached through a feature-detect, since plywood's pinned chant (0.124.54)
 * lacks it; scripts/build-cli.mjs stands in a throwing module there.
 */
import type { DetectedProject } from "./detect";

export type BucketStore = "s3" | "gcs" | "azblob";

/** The part of chant's `BucketReport` init prints. */
export interface BucketReport {
  store: BucketStore;
  bucket: string;
  namespaces: string[];
  correct: boolean;
  settings: Array<{ setting: string; verdict: "ok" | "fail" | "unreadable"; found: string; unwaivable: boolean; fix?: string }>;
}

/** What plywood calls from `@intentius/chant/bucket-check`. */
export interface ChantBucketCheck {
  checkBucket(target: Record<string, unknown>, options?: { namespaces?: readonly string[] }): Promise<BucketReport>;
}

/** A backend URL's bucket, as chant's check takes it, or why it cannot be checked. */
export type BucketTarget =
  | { ok: true; target: Record<string, unknown>; namespaces: string[]; label: string }
  | { ok: false; reason: string; label: string };

export interface StackBackend {
  url?: string;
  source: "plywood.yml" | "PULUMI_BACKEND_URL" | "Pulumi.yaml" | "none";
}

/** The backend a stack opens, first that answers. */
export function backendOf(
  project: Pick<DetectedProject, "backendUrl">,
  plywood: { stack?: string; all?: string },
  env: NodeJS.ProcessEnv,
): StackBackend {
  if (plywood.stack) return { url: plywood.stack, source: "plywood.yml" };
  if (plywood.all) return { url: plywood.all, source: "plywood.yml" };
  const fromEnv = env.PULUMI_BACKEND_URL?.trim();
  if (fromEnv) return { url: fromEnv, source: "PULUMI_BACKEND_URL" };
  if (project.backendUrl) return { url: project.backendUrl, source: "Pulumi.yaml" };
  return { source: "none" };
}

/** True for Pulumi Cloud: no URL, or an https:// URL (the hosted service or a self-hosted Pulumi Cloud). */
export function isPulumiCloud(url: string | undefined): boolean {
  return url === undefined || /^https?:\/\//.test(url);
}

/** The URL without plunge's `plunge+` or `plunge:` prefix. */
export function stockUrl(url: string): string {
  return url.replace(/^plunge[+:]/, "");
}

/** Pulumi's state lives under `<prefix>/.pulumi/` in the bucket; the lifecycle rule must cover it. */
function namespaceOf(prefix: string): string {
  const p = prefix.replace(/^\/+|\/+$/g, "");
  return p === "" ? ".pulumi" : `${p}/.pulumi`;
}

/**
 * chant's bucket target for a backend URL, with the credentials an emulator
 * needs taken from the environment. A real store's credentials come from
 * chant's default chains, never from here.
 */
export function bucketTarget(url: string, env: NodeJS.ProcessEnv): BucketTarget | undefined {
  const stock = stockUrl(url);
  let u: URL;
  try {
    u = new URL(stock);
  } catch {
    return undefined;
  }
  const label = stock;
  if (u.protocol === "s3:") {
    const q = u.searchParams;
    const region = q.get("region") ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
    const rawEndpoint = q.get("endpoint") ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;
    const target: Record<string, unknown> = { store: "s3", bucket: u.hostname, region };
    if (rawEndpoint) {
      const endpoint = /^https?:\/\//.test(rawEndpoint) ? rawEndpoint : `${q.get("disableSSL") === "true" ? "http" : "https"}://${rawEndpoint}`;
      if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
        return { ok: false, label, reason: `the bucket is on ${endpoint}, and checking it needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment` };
      }
      target.endpoint = endpoint;
      target.credentials = {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
      };
    }
    return { ok: true, target, namespaces: [namespaceOf(u.pathname)], label };
  }
  if (u.protocol === "gs:") {
    const target: Record<string, unknown> = { store: "gcs", bucket: u.hostname };
    const emulator = env.STORAGE_EMULATOR_HOST;
    if (emulator) {
      target.endpoint = /^https?:\/\//.test(emulator) ? emulator : `http://${emulator}`;
      target.token = env.GOOGLE_OAUTH_ACCESS_TOKEN ?? null;
    }
    return { ok: true, target, namespaces: [namespaceOf(u.pathname)], label };
  }
  if (u.protocol === "azblob:") {
    const account = u.searchParams.get("storage_account") ?? env.AZURE_STORAGE_ACCOUNT;
    const subscriptionId = env.AZURE_SUBSCRIPTION_ID;
    const resourceGroup = env.AZURE_RESOURCE_GROUP;
    if (!account || !subscriptionId || !resourceGroup) {
      return { ok: false, label, reason: "checking an Azure container needs its storage account (storage_account= in the URL, or AZURE_STORAGE_ACCOUNT), AZURE_SUBSCRIPTION_ID and AZURE_RESOURCE_GROUP" };
    }
    const target: Record<string, unknown> = { store: "azblob", subscriptionId, resourceGroup, account, container: u.hostname };
    if (env.AZURE_ARM_ENDPOINT) {
      if (!env.AZURE_ARM_TOKEN) return { ok: false, label, reason: `the account is on ${env.AZURE_ARM_ENDPOINT}, and checking it needs AZURE_ARM_TOKEN` };
      target.endpoint = env.AZURE_ARM_ENDPOINT;
      target.token = env.AZURE_ARM_TOKEN;
    }
    return { ok: true, target, namespaces: [namespaceOf(u.pathname)], label };
  }
  return undefined;
}

/** The message init prints when the installed chant has no bucket check. */
export function needsBucketCheckMessage(builtChant: string): string {
  return (
    "the bucket check needs chant >= the release after 0.124.54, which carries @intentius/chant/bucket-check (chant#4558). " +
    `This plywood was built with chant ${builtChant}, which lacks it, so the bucket was not checked.`
  );
}

let cached: Promise<ChantBucketCheck | undefined> | undefined;

/** chant's bucket check, or undefined when the installed chant lacks it. */
export function chantBucketCheck(): Promise<ChantBucketCheck | undefined> {
  cached ??= (async () => {
    try {
      // @ts-ignore: the subpath is missing from chant 0.124.54 (chant#4558).
      const m: Record<string, unknown> = await import("@intentius/chant/bucket-check");
      return typeof m.checkBucket === "function" ? (m as unknown as ChantBucketCheck) : undefined;
    } catch {
      return undefined;
    }
  })();
  return cached;
}

/** Tests stand in a fake check (or none). `reset` goes back to the real import. */
export function setBucketCheckForTests(fake: ChantBucketCheck | undefined | "reset"): void {
  cached = fake === "reset" ? undefined : Promise.resolve(fake);
}

/** The lines init prints for one report: the headline, then each failing setting with its fix. */
export function bucketLines(report: BucketReport): string[] {
  const where = `${report.store === "azblob" ? "container" : "bucket"} ${report.bucket}`;
  if (report.correct) return [`  ${where}: versioning, the noncurrent-version rule and the public access block are in place`];
  const out = [`  ${where} is missing settings plunge refuses to open without, and stock Pulumi's history relies on:`];
  for (const f of report.settings) {
    if (f.verdict === "ok") continue;
    out.push(`    ${f.setting}: ${f.found}${f.verdict === "unreadable" ? " (could not be read)" : ""}`);
    if (f.fix) out.push(...f.fix.split("\n").map((l) => `      ${l}`));
  }
  return out;
}
