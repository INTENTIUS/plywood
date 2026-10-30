/**
 * The bench's day-2 action (plywood#44), for the pw-action scenario: one
 * `command:local:Command` resource named `rotate` on shop/prod-us, which
 * e2e/scenarios/base/plywood.yml declares as the stack's action `rotate`.
 *
 * The seed adds it to the corpus program as its own file, rotate.ts,
 * imported at the end of index.ts. It declares the resource only on a stack
 * whose config sets `shop:rotateMarker`, and only Pulumi.prod-us.yaml does,
 * so dev, staging and prod-eu are as the corpus has them. The command
 * prints the marker and the time into its stdout and a file under /tmp in
 * the job container, so a replacement shows in the stack's state and
 * touches nothing on floci.
 *
 * The program names the resource by its type token, with no SDK package,
 * so the shop's package.json and lock file stay the corpus's. The engine
 * loads the command provider at plywood's image pin (images.ts
 * IMAGE_PLUGINS) from the image's Pulumi home, which the bench's job image
 * inherits from plywood's plunge image, so nothing is downloaded.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_PLUGINS } from "../packages/plywood/src/images";

export const ACTION_STACK = "prod-us";
export const ACTION_NAME = "rotate";
export const ACTION_URN = `urn:pulumi:${ACTION_STACK}::shop::command:local:Command::${ACTION_NAME}`;

/** The config key the command reads, and its value at seed time. pw-action's BREAK arm sets another. */
export const MARKER_KEY = "shop:rotateMarker";
export const SEED_MARKER = "first";

/** The command provider's version, as plywood's images carry it. */
export function commandVersion(): string {
  const p = IMAGE_PLUGINS.find((x) => x.kind === "resource" && x.name === "command");
  if (!p) throw new Error("plywood's images carry no command provider (packages/plywood/src/images.ts IMAGE_PLUGINS)");
  return p.version;
}

/** rotate.ts, the program file that declares the command resource. */
export function rotateProgram(version = commandVersion()): string {
  return [
    "// The plywood bench's day-2 action: a local command, replaced by `plywood action shop/prod-us rotate`.",
    "// It is declared only where the stack's config sets shop:rotateMarker. The command provider is in the",
    "// job image's Pulumi home, so the resource is named by its type token and the program adds no package.",
    'import * as pulumi from "@pulumi/pulumi";',
    "",
    'const marker = new pulumi.Config("shop").get("rotateMarker");',
    "// CustomResource is abstract in the SDK's types, so the resource is a subclass.",
    "class RotateCommand extends pulumi.CustomResource {",
    "    constructor(name: string, props: Record<string, unknown>, opts: pulumi.CustomResourceOptions) {",
    '        super("command:local:Command", name, props, opts);',
    "    }",
    "}",
    "",
    "if (marker !== undefined) {",
    "    new RotateCommand(",
    `        ${JSON.stringify(ACTION_NAME)},`,
    "        {",
    `            create: 'printf "%s %s\\\\n" "$ROTATE_MARKER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee /tmp/plywood-rotate-marker',`,
    "            environment: { ROTATE_MARKER: marker },",
    "            stdout: undefined,",
    "        },",
    `        { version: ${JSON.stringify(version)} },`,
    "    );",
    "}",
    "",
  ].join("\n");
}

/** Add the action to the shop program in `dir`: rotate.ts, its import in index.ts, and the marker in Pulumi.prod-us.yaml. */
export function addRotateAction(dir: string): void {
  writeFileSync(join(dir, "rotate.ts"), rotateProgram());
  const index = readFileSync(join(dir, "index.ts"), "utf8");
  if (!index.includes('import "./rotate";')) {
    appendFileSync(join(dir, "index.ts"), `${index.endsWith("\n") ? "" : "\n"}\n// The bench's day-2 action, on the stacks whose config sets shop:rotateMarker (rotate.ts).\nimport "./rotate";\n`);
  }
  const stackFile = join(dir, `Pulumi.${ACTION_STACK}.yaml`);
  const config = readFileSync(stackFile, "utf8");
  if (!new RegExp(`^\\s*${MARKER_KEY}:`, "m").test(config)) appendFileSync(stackFile, `${config.endsWith("\n") ? "" : "\n"}  ${MARKER_KEY}: ${JSON.stringify(SEED_MARKER)}\n`);
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The script `plywood-e2e action` runs in a job container: `plywood action
 * shop/<stack> <name>` as `by`, its output printed, and its exit code
 * passed on. A call that waits (exit 3) must also print the line that
 * approves `action:<stack>:<name>`, or the script exits 1.
 */
export function actionScript(stack: string, name: string, by: string): string {
  const approve = `plywood approve action:${stack}:${name} --op pulumi-stack-ops --plan `;
  return [
    "code=0",
    `out="$(plywood action ${quote(`shop/${stack}`)} ${quote(name)} --by ${quote(by)} 2>&1)" || code=$?`,
    `printf '%s\\n' "$out"`,
    `if [ "$code" = 3 ] && ! printf '%s\\n' "$out" | grep -qF -- ${quote(approve)}; then echo ${quote(`plywood action waited without the line that approves action:${stack}:${name}`)} >&2; exit 1; fi`,
    'exit "$code"',
  ].join("\n");
}
