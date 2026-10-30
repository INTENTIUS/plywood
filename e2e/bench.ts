/**
 * The plywood bench on chant's e2e harness (plywood#25, chant#4586 ruling
 * F): the names, ports, backends and job environment the seed, the driver
 * and the tutorial pages share.
 *
 * The stack is the harness's (`harnessStack`): floci at the harness's pin,
 * Forgejo and forgejo-runner on one network. plywood keeps the project name,
 * the port variables and the default ports of its own bench in stack/, so
 * the tutorial pages read the same on both: Forgejo on 127.0.0.1:3390 and
 * floci on 127.0.0.1:4590 from the host, http://forgejo:3000 and
 * http://floci:4566 from a job. The two benches are alternatives and share
 * the names, so only one runs at a time.
 *
 * plywood has no docker lexicon, so the compose file is written from
 * `harnessStack`'s service properties as JSON, which compose reads as YAML.
 * The images in it are the harness's.
 */
import { join } from "node:path";
import type { HarnessModule, HarnessStackShape } from "./harness";

export const PROJECT = "plywood-tutorial";
export const ENV_PREFIX = "PLYWOOD_TUTORIAL";
export const PORTS = { floci: 4590, forgejo: 3390 } as const;

/** Inside the network. */
export const FLOCI_NET = "http://floci:4566";
export const FORGEJO_NET = "http://forgejo:3000";

/** The repository the scenarios run on, and the people the driver acts as. */
export const ORG = "tutor";
export const REPO = "shop";
export const PEOPLE = {
  admin: { login: "plywood-admin", password: "plywood-tutorial-admin" },
  author: { login: "tutor", password: "plywood-tutorial-local" },
  reviewer: { login: "reviewer", password: "plywood-tutorial-reviewer" },
} as const;
export const EMAIL_DOMAIN = "plywood-tutorial.local";
export const RUNNER_NAME = "plywood-tutorial-docker";

/** The stacks of the shop repository and the regions they run in. */
export const STACKS = ["dev", "staging", "prod-us", "prod-eu"] as const;
export type StackName = (typeof STACKS)[number];
export const stackRegion = (s: string): string => (s === "prod-eu" ? "eu-west-1" : "us-east-1");

/**
 * The buckets on floci. `records` is plunge's record store, set up as
 * plunge#34 requires (versioning, a noncurrent-version lifecycle rule, the
 * four public access blocks; ./secure-bucket.ts). `state` holds stock
 * Pulumi stacks. `reports` takes chant's pr-plan.json. `bare` is created
 * with none of the settings, for pw-adopt's BREAK arm, where the plunge
 * store must refuse it.
 */
export const BUCKETS = {
  records: "plywood-tutorial-plunge",
  state: "plywood-tutorial-state",
  reports: "plywood-tutorial-reports",
  bare: "plywood-tutorial-bare",
} as const;

/** A plunge+s3 store URL on floci, as a job (`net`) or the host sees it. */
export function plungeStoreUrl(bucket: string, endpoint: string): string {
  return `plunge+s3://${bucket}?region=us-east-1&endpoint=${endpoint}&s3ForcePathStyle=true`;
}

/** A stock S3 backend on floci. */
export function s3BackendUrl(bucket: string, endpoint: string): string {
  return `s3://${bucket}?region=us-east-1&endpoint=${endpoint}&use_path_style=true`;
}

/** The report URL every scenario names (pr-plan.json lands below it). */
export const REPORT_URL = `s3://${BUCKETS.reports}/shop`;

/** A static passphrase for the stacks' secrets; the bench's secrets are its own. */
export const PASSPHRASE = "plywood-tutorial";

/** The bench's stack, from the harness. */
export function benchStack(h: Pick<HarnessModule, "harnessStack">): HarnessStackShape {
  return h.harnessStack({ project: PROJECT, envPrefix: ENV_PREFIX, ports: { ...PORTS } });
}

/** Host URLs, after the port variables. */
export function hostUrls(s: Pick<HarnessStackShape, "portVars">, env: Record<string, string | undefined> = process.env): { floci: string; forgejo: string } {
  const port = (k: "floci" | "forgejo") => Number(env[s.portVars[k]] ?? PORTS[k]);
  return { floci: `http://127.0.0.1:${port("floci")}`, forgejo: `http://127.0.0.1:${port("forgejo")}` };
}

/**
 * The compose document: the harness's network, volumes and services under
 * their export names, which are their compose keys. The sql services keep
 * their profile, so `up` without `--profile sql` leaves them out.
 */
export function composeDoc(s: HarnessStackShape): Record<string, unknown> {
  return {
    name: s.project,
    networks: { [s.networkKey]: { name: s.network.name } },
    volumes: { forgejoData: { name: s.volumes.forgejoData.name }, runnerData: { name: s.volumes.runnerData.name } },
    services: s.services,
  };
}

/**
 * Every job's environment: the harness's floci defaults, plus the passphrase,
 * no update check, an empty gcloud config, plunge's Cloud Control lister at
 * floci, and a file:// backend in the container, so nothing falls back to
 * the default backend. Every stack names its own backend in plywood.yml (a
 * plunge+s3 store or an S3 bucket on floci), and every seed line names one.
 */
export function jobEnv(h: Pick<HarnessModule, "RUNNER_JOB_ENV">): Record<string, string> {
  return {
    ...h.RUNNER_JOB_ENV,
    AWS_ENDPOINT_URL: FLOCI_NET,
    PLUNGE_CLOUDCONTROL_ENDPOINT: FLOCI_NET,
    PULUMI_BACKEND_URL: "file:///tmp/plywood-tutorial-backend",
    PULUMI_CONFIG_PASSPHRASE: PASSPHRASE,
    PULUMI_SKIP_UPDATE_CHECK: "true",
    CLOUDSDK_CONFIG: "/tmp/plywood-tutorial-gcloud-empty",
  };
}

/** The state directory: tokens, the seeded repository, logs and the claims ledger. Ignored by git. */
export function stateDir(repoRoot: string, env: Record<string, string | undefined> = process.env): string {
  return env.PLYWOOD_E2E_STATE ?? join(repoRoot, "stack", ".state", "e2e");
}

/** The plunge corpus commit the shop repository is built from: plunge main after plunge#55's timings. */
export const PLUNGE_REF = "812cfd894151027dbc22269a5a8b43fb53368ec2";

/**
 * The job image the scenarios run: plywood's plunge image as `just images`
 * tags it, with stock Pulumi copied in from plywood's pulumi image (staging
 * is a stock stack, and plunge's adopt exports it with `pulumi stack
 * export`), and a local plunge build on PATH when the released plunge lacks
 * a feature a scenario reads (plunge 0.1.0 predates plunge#55's timings).
 * The command provider pw-action's resource needs comes with the plunge
 * image's Pulumi home (packages/plywood/src/images.ts IMAGE_PLUGINS).
 * `just e2e-image <linux plunge binary>` builds it from
 * {@link jobImageDockerfile}. Nothing pushes it.
 */
export const JOB_IMAGE = "plywood-tutorial-job:local";

/**
 * The Dockerfile `just e2e-image` builds, from plywood's two images by tag
 * and the binary in the build context as `plunge`. `pulumiVersion` is the
 * stock Pulumi release plywood's pulumi image carries, `plungeVersion` the
 * plunge release its plunge image carries.
 *
 * The generated workflows run in this image (base/plywood.yml's `image`),
 * and their install lines link `/usr/local/bin/plunge` to
 * `/opt/plywood/plunge-<release>/plunge` when that file is there, so that
 * path names the local build too. `chantTarballs`, the files `just
 * chant-local` packed (under `chant-local/` in the build context), replace
 * the pinned chant packages under the global plywood, so the jobs run the
 * same chant as the host. It also takes git from trixie (plywood#49).
 */
export function jobImageDockerfile(o: { plungeImage: string; pulumiImage: string; pulumiVersion: string; plungeVersion: string; chantTarballs?: readonly string[] }): string {
  const dir = `/opt/plywood/pulumi-${o.pulumiVersion}`;
  const release = `/opt/plywood/plunge-${o.plungeVersion}`;
  const tarballs = o.chantTarballs ?? [];
  const chant = tarballs.length
    ? [
        `COPY ${tarballs.map((t) => `chant-local/${t}`).join(" ")} /tmp/chant-local/`,
        // npm installs the local packages in place of the pinned ones under the global plywood; --legacy-peer-deps as chant-local.sh.
        `RUN set -e; cd "$(npm root -g)/@intentius/plywood" && npm install --no-save --omit=dev --no-audit --no-fund --legacy-peer-deps ${tarballs.map((t) => `/tmp/chant-local/${t}`).join(" ")} && grep '"version"' node_modules/@intentius/chant/package.json && plywood --version`,
      ]
    : [];
  return [
    "# Written by e2e/bench.ts (just e2e-image): plywood's plunge image with stock Pulumi beside it",
    "# and a local plunge build on PATH, for scenarios that read what the released plunge lacks.",
    `FROM ${o.pulumiImage} AS pulumi`,
    `FROM ${o.plungeImage}`,
    `COPY --from=pulumi ${dir}/ ${dir}/`,
    "COPY plunge /opt/plywood/plunge-local/plunge",
    // The language hosts and plugins plunge runs come with the release beside it.
    `RUN set -e; for f in /opt/plywood/plunge-0*/pulumi-*; do [ -e "$f" ] && ln -sf "$f" /opt/plywood/plunge-local/; done; ln -sf /opt/plywood/plunge-local/plunge /usr/local/bin/plunge; ln -sf /opt/plywood/plunge-local/plunge ${release}/plunge; ln -sf ${dir}/pulumi /usr/local/bin/pulumi; plunge version; ${release}/plunge version; pulumi version`,
    // plywood's images carry bookworm's git 2.39.5, which has no `git merge-tree --write-tree --merge-base`
    // (git 2.40), which chant's lifecycle push replays with when two jobs push chant/lifecycle at once
    // (plywood#49). The bench takes git from trixie so the scenarios measure their claims.
    'RUN set -e; echo "deb http://deb.debian.org/debian trixie main" > /etc/apt/sources.list.d/trixie.list && printf "Package: *\\nPin: release n=trixie\\nPin-Priority: 100\\n" > /etc/apt/preferences.d/trixie && apt-get update && apt-get install -y --no-install-recommends -t trixie git && rm -rf /var/lib/apt/lists/* && git --version',
    ...chant,
    "",
  ].join("\n");
}

/** Every pulumi or plunge process the bench starts on the host carries these, on top of SafeRun's scrub. */
export function engineEnv(fileBackendDir: string): Record<string, string> {
  return { PULUMI_BACKEND_URL: `file://${fileBackendDir}`, PULUMI_SKIP_UPDATE_CHECK: "true", PULUMI_CONFIG_PASSPHRASE: PASSPHRASE };
}
