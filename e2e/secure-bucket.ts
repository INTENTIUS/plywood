/**
 * A bucket plunge's record store accepts (plunge#20, #34), made on floci by
 * the bench's seed: the settings plunge+s3:// checks when it opens a store,
 * the same three plunge's races set (scripts/plunge-races/lib.sh
 * `secure_bucket`), so no PLUNGE_ALLOW_INSECURE waiver is needed:
 *
 *   versioning on;
 *   an enabled lifecycle rule with no filter that expires noncurrent
 *   versions after 30 days (it deletes no current object);
 *   all four public access block settings on.
 *
 * The calls are S3's REST API, path-style and unsigned, which floci takes
 * (the harness's FlociBucket reads and writes the same way). The harness has
 * no step for this yet, so the bench carries it; it belongs beside
 * FlociBucket.create in chant's harness.
 */
import { createHash } from "node:crypto";

export type Fetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const TIMEOUT_MS = 30_000;

export const VERSIONING_XML = '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>';

export const LIFECYCLE_XML =
  '<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>records-noncurrent</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status>' +
  "<NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>";

export const PUBLIC_ACCESS_BLOCK_XML =
  '<PublicAccessBlockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls>' +
  "<BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>";

/** One S3 call the step makes, in order. */
export interface BucketCall {
  what: string;
  method: "PUT";
  query: string;
  body?: string;
}

/** The calls: create (an existing bucket is kept), then the three settings. `secure: false` makes a bare bucket. */
export function bucketCalls(secure: boolean): BucketCall[] {
  const create: BucketCall = { what: "CreateBucket", method: "PUT", query: "" };
  if (!secure) return [create];
  return [
    create,
    { what: "PutBucketVersioning", method: "PUT", query: "versioning", body: VERSIONING_XML },
    { what: "PutBucketLifecycleConfiguration", method: "PUT", query: "lifecycle", body: LIFECYCLE_XML },
    { what: "PutPublicAccessBlock", method: "PUT", query: "publicAccessBlock", body: PUBLIC_ACCESS_BLOCK_XML },
  ];
}

/** Make `bucket` on floci at `endpoint` (the host URL), with plunge's settings unless `secure` is false. */
export async function makeBucket(endpoint: string, bucket: string, o: { secure: boolean; fetch?: Fetch }): Promise<void> {
  const f: Fetch = o.fetch ?? (fetch as unknown as Fetch);
  const base = `${endpoint.replace(/\/$/, "")}/${bucket}`;
  for (const call of bucketCalls(o.secure)) {
    const headers: Record<string, string> = {};
    if (call.body !== undefined) {
      headers["content-type"] = "application/xml";
      // S3 asks for a body digest on the lifecycle and public access block calls.
      headers["content-md5"] = createHash("md5").update(call.body).digest("base64");
    }
    const res = await f(call.query ? `${base}?${call.query}` : base, { method: call.method, headers, body: call.body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    // 409 on CreateBucket: the bucket is there already, and the seed keeps it.
    if (!res.ok && !(call.what === "CreateBucket" && res.status === 409)) {
      throw new Error(`floci answered ${res.status} to ${call.what} on ${bucket}: ${(await res.text()).slice(0, 200)}`);
    }
  }
}
