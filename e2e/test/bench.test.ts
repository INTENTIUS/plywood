import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUCKETS, FLOCI_NET, PORTS, PROJECT, composeDoc, hostUrls, jobEnv, jobImageDockerfile, plungeStoreUrl } from "../bench";
import { NeedsChantHarness, harness, isHarness, requireHarness, setHarnessForTests, type HarnessStackShape } from "../harness";
import { bucketCalls, makeBucket, type Fetch } from "../secure-bucket";
import { setYamlKeys, overlayFiles } from "../overlays";
import { cloudScript } from "../seed";

const ROOT = join(import.meta.dirname, "..", "..");

afterEach(() => setHarnessForTests("reset"));

describe("reaching chant's harness", () => {
  it("finds no harness on the pinned chant and refuses with the floor and the fallback bench", async () => {
    expect(await harness()).toBeUndefined();
    const err = await requireHarness("0.124.55").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeedsChantHarness);
    expect(String((err as Error).message)).toMatch(/needs .*@intentius\/chant\/e2e-harness/);
    expect(String((err as Error).message)).toContain("just tutorial-up");
  });

  it("takes a module only when it has the floor and every piece the bench calls", () => {
    expect(isHarness({})).toBe(false);
    expect(isHarness({ E2E_HARNESS_FLOOR: "0.125.0" })).toBe(false);
    const full = Object.fromEntries(
      ["harnessStack", "lintScenario", "runClaim", "claimRow", "renderClaims", "recordClaimRow", "SafeRun", "FlociBucket", "ForgejoForge"].map((k) => [k, () => undefined]),
    );
    expect(isHarness({ ...full, E2E_HARNESS_FLOOR: "0.125.0" })).toBe(true);
  });
});

const stack: HarnessStackShape = {
  project: PROJECT,
  network: { name: PROJECT },
  networkKey: "harness",
  volumes: { forgejoData: { name: `${PROJECT}-forgejo-data` }, runnerData: { name: `${PROJECT}-runner-data` } },
  services: {
    floci: { image: "floci@sha256:x", container_name: `${PROJECT}-floci`, networks: { harness: { aliases: ["floci"] } } },
    forgejo: { image: "forgejo", container_name: `${PROJECT}-forgejo`, volumes: ["forgejoData:/data"], networks: { harness: { aliases: ["forgejo"] } } },
    forgejoRunner: { image: "runner", container_name: `${PROJECT}-forgejo-runner`, volumes: ["runnerData:/data"], networks: { harness: { aliases: ["forgejo-runner"] } } },
    clickhouse: { image: "ch", container_name: "c", profiles: ["sql"], networks: { harness: { aliases: ["clickhouse"] } } },
    postgres: { image: "pg", container_name: "p", profiles: ["sql"], networks: { harness: { aliases: ["postgres"] } } },
  },
  portVars: { floci: "PLYWOOD_TUTORIAL_FLOCI_PORT", forgejo: "PLYWOOD_TUTORIAL_FORGEJO_PORT", clickhouse: "X", postgres: "Y" },
};

describe("the bench's stack", () => {
  it("writes the harness's services under their export names, with the network and volumes they name", () => {
    const doc = composeDoc(stack) as { name: string; networks: Record<string, { name: string }>; volumes: Record<string, { name: string }>; services: Record<string, unknown> };
    expect(doc.name).toBe("plywood-tutorial");
    expect(doc.networks).toEqual({ harness: { name: "plywood-tutorial" } });
    expect(Object.keys(doc.volumes).sort()).toEqual(["forgejoData", "runnerData"]);
    expect(Object.keys(doc.services)).toEqual(["floci", "forgejo", "forgejoRunner", "clickhouse", "postgres"]);
  });

  it("keeps the tutorial bench's ports, so the pages read the same on both benches", () => {
    expect(PORTS).toEqual({ floci: 4590, forgejo: 3390 });
    expect(hostUrls(stack, {})).toEqual({ floci: "http://127.0.0.1:4590", forgejo: "http://127.0.0.1:3390" });
    expect(hostUrls(stack, { PLYWOOD_TUTORIAL_FLOCI_PORT: "4600" }).floci).toBe("http://127.0.0.1:4600");
    const compose = readFileSync(join(ROOT, "stack", "compose.yml"), "utf8");
    expect(compose).toContain("PLYWOOD_TUTORIAL_FLOCI_PORT:-4590");
    expect(compose).toContain("PLYWOOD_TUTORIAL_FORGEJO_PORT:-3390");
  });

  it("gives every job a file:// backend, no update check, floci and plunge's lister at floci", () => {
    const env = jobEnv({ RUNNER_JOB_ENV: { AWS_ACCESS_KEY_ID: "test" } });
    expect(env.PULUMI_BACKEND_URL).toMatch(/^file:\/\//);
    expect(env.PULUMI_SKIP_UPDATE_CHECK).toBe("true");
    expect(env.AWS_ENDPOINT_URL).toBe(FLOCI_NET);
    expect(env.PLUNGE_CLOUDCONTROL_ENDPOINT).toBe(FLOCI_NET);
    expect(env.AWS_ACCESS_KEY_ID).toBe("test");
  });

  it("names plunge's store path-style on floci", () => {
    expect(plungeStoreUrl(BUCKETS.records, FLOCI_NET)).toBe("plunge+s3://plywood-tutorial-plunge?region=us-east-1&endpoint=http://floci:4566&s3ForcePathStyle=true");
  });

  it("builds the job image from plywood's plunge image, with stock Pulumi and a local plunge on PATH", () => {
    const d = jobImageDockerfile({ plungeImage: "ghcr.io/intentius/plywood-plunge:0.0.0-plunge0.1.0", pulumiImage: "ghcr.io/intentius/plywood-pulumi:0.0.0-pulumi3.272.0", pulumiVersion: "3.272.0" });
    expect(d).toContain("FROM ghcr.io/intentius/plywood-pulumi:0.0.0-pulumi3.272.0 AS pulumi");
    expect(d).toContain("FROM ghcr.io/intentius/plywood-plunge:0.0.0-plunge0.1.0\n");
    expect(d).toContain("COPY --from=pulumi /opt/plywood/pulumi-3.272.0/ /opt/plywood/pulumi-3.272.0/");
    expect(d).toContain("COPY plunge /opt/plywood/plunge-local/plunge");
    expect(d).toMatch(/ln -sf \/opt\/plywood\/plunge-local\/plunge \/usr\/local\/bin\/plunge/);
    expect(d).toMatch(/plunge version; pulumi version/);
  });
});

describe("a bucket plunge's store accepts", () => {
  const recorder = (status: (url: string) => number) => {
    const calls: Array<{ url: string; method: string; headers?: Record<string, string>; body?: string }> = [];
    const f: Fetch = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const s = status(url);
      return { ok: s >= 200 && s < 300, status: s, text: async () => "<Error/>" };
    };
    return { calls, f };
  };

  it("creates the bucket, then turns on versioning, the noncurrent lifecycle rule and the four public access blocks", async () => {
    const { calls, f } = recorder(() => 200);
    await makeBucket("http://127.0.0.1:4590/", "plywood-tutorial-plunge", { secure: true, fetch: f });
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4590/plywood-tutorial-plunge",
      "http://127.0.0.1:4590/plywood-tutorial-plunge?versioning",
      "http://127.0.0.1:4590/plywood-tutorial-plunge?lifecycle",
      "http://127.0.0.1:4590/plywood-tutorial-plunge?publicAccessBlock",
    ]);
    expect(calls.every((c) => c.method === "PUT")).toBe(true);
    expect(calls[1]!.body).toContain("<Status>Enabled</Status>");
    expect(calls[2]!.body).toContain("<NoncurrentDays>30</NoncurrentDays>");
    expect(calls[2]!.body).toContain("<Filter><Prefix></Prefix></Filter>");
    for (const k of ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"]) expect(calls[3]!.body).toContain(`<${k}>true</${k}>`);
    for (const c of calls.slice(1)) expect(c.headers?.["content-md5"]).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it("keeps a bucket that is there already, and fails on any other refusal", async () => {
    await makeBucket("http://f", "b", { secure: true, fetch: recorder((u) => (u.endsWith("/b") ? 409 : 200)).f });
    await expect(makeBucket("http://f", "b", { secure: true, fetch: recorder((u) => (u.endsWith("?lifecycle") ? 501 : 200)).f })).rejects.toThrow(/501 to PutBucketLifecycleConfiguration on b/);
  });

  it("makes a bare bucket with no settings, for pw-adopt's BREAK arm", () => {
    expect(bucketCalls(false).map((c) => c.what)).toEqual(["CreateBucket"]);
  });

  it("is the same three settings stack/seed.sh gives the tutorial bench's buckets", () => {
    const seed = readFileSync(join(ROOT, "stack", "seed.sh"), "utf8");
    for (const q of ["?versioning", "?lifecycle", "?publicAccessBlock"]) expect(seed).toContain(q);
    expect(seed).toContain('secure_bucket "$PLUNGE_BUCKET"');
    expect(seed).toContain('secure_bucket "$BUCKET"');
  });
});

describe("the seed", () => {
  it("names a backend and skips the update check on every pulumi and plunge line", () => {
    for (const commit of [true, false]) {
      const lines = cloudScript(commit)
        .split("\n")
        .flatMap((l) => l.split(" || "))
        .filter((l) => /\b(pulumi|plunge|plywood) /.test(l) && !l.startsWith("git"));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        expect(l, l).toMatch(/^PULUMI_BACKEND_URL='[^']+' PULUMI_SKIP_UPDATE_CHECK=true /);
        expect(l).not.toMatch(/app\.pulumi\.com|amazonaws\.com/);
      }
    }
  });

  it("deploys dev on plunge's store and staging as a stock stack in the store's bucket, and runs plywood init only on the first seed", () => {
    const first = cloudScript(true);
    expect(first).toMatch(/plunge\+s3:\/\/plywood-tutorial-plunge\?[^']*' PULUMI_SKIP_UPDATE_CHECK=true plunge up --yes --non-interactive --stack dev/);
    expect(first).toMatch(/s3:\/\/plywood-tutorial-plunge\?[^']*' PULUMI_SKIP_UPDATE_CHECK=true pulumi up --yes --non-interactive --stack staging/);
    expect(first).toContain("plywood init --forge forgejo --yes");
    expect(cloudScript(false)).not.toContain("plywood init");
    expect(cloudScript(false)).not.toContain("git push");
  });

  it("builds the repository with stack/seed-repo.sh at plunge's main after plunge#55, the knobs far apart", () => {
    const repo = readFileSync(join(ROOT, "stack", "seed-repo.sh"), "utf8");
    const lib = readFileSync(join(ROOT, "stack", "lib.sh"), "utf8");
    expect(lib).toContain("PLYWOOD_TUTORIAL_PLUNGE_REF:-812cfd894151027dbc22269a5a8b43fb53368ec2");
    expect(readFileSync(join(ROOT, "stack", "seed.sh"), "utf8")).toContain('"$STACK_DIR/seed-repo.sh" "$SHOP"');
    const block = repo.slice(repo.indexOf("config:\n"), repo.indexOf("EOT", repo.indexOf("config:\n")));
    const lines = block.trim().split("\n");
    expect(lines[1]).toMatch(/aws:region/);
    expect(lines[2]).toBe('  corpus:eventsRetentionSeconds: "3600"');
    expect(lines[lines.length - 1]).toBe('  corpus:workerCount: "3"');
  });
});

describe("overlays", () => {
  const stackFile = 'config:\n  aws:region: us-east-1\n  corpus:eventsRetentionSeconds: "3600"\n  corpus:prefix: plw-dev\n  corpus:workerCount: "3"\nencryptionsalt: v1:abc\n';

  it("sets a key's value and keeps every other line, the salt among them", () => {
    const out = setYamlKeys(stackFile, { "corpus:workerCount": "4" });
    expect(out).toContain('  corpus:workerCount: "4"');
    expect(out).toContain("encryptionsalt: v1:abc");
    expect(out.split("\n").length).toBe(stackFile.split("\n").length);
  });

  it("refuses a key the file lacks", () => {
    expect(() => setYamlKeys(stackFile, { "corpus:nothing": "1" }, "Pulumi.dev.yaml")).toThrow(/Pulumi.dev.yaml has no corpus:nothing line/);
  });

  it("reads the seeded repository for set and append, and writes files as given", () => {
    const dir = join(import.meta.dirname, "fixtures", "shop");
    const out = overlayFiles({ set: { "Pulumi.dev.yaml": { "corpus:eventsRetentionSeconds": "7200" } }, append: { "plywood.yml": "locks:\n  grain: stack\n" }, files: { "x.txt": "x" } }, dir);
    expect(out["Pulumi.dev.yaml"]).toContain('corpus:eventsRetentionSeconds: "7200"');
    expect(out["plywood.yml"]!.endsWith("locks:\n  grain: stack\n")).toBe(true);
    expect(out["x.txt"]).toBe("x");
  });
});
