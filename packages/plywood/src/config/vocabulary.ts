/**
 * plywood.yml against chant's product vocabulary (the reference page "CI
 * Product Config Keys"): each setting has one key there, and plywood keeps
 * reading the spelling it used before. chant's `productConfigProblems` does
 * the checking: an earlier spelling is a warning that names the key, and a
 * spelling set beside its key is an error. This file moves each vocabulary key
 * onto the spelling the group modules read, so they see one shape.
 *
 * `forge_environments` is the one key read as the vocabulary writes it:
 * `environments.<name>` is the vocabulary's stage key, so an entry under
 * `environments` whose value is a name or a `{ name, url }` mapping is the
 * earlier spelling of a glob's forge environment and moves to
 * `forge_environments`; any other mapping there stays, a stage.
 *
 * | Key written                 | Read as                   |
 * |-----------------------------|---------------------------|
 * | `environments.<glob>`, a name or `{ name, url }` | `forge_environments.<glob>` |
 * | `approval_rules.<r>.count`  | `approval_rules.<r>.quorum` |
 * | `policy.path`               | `policy.rego`             |
 * | `respond.wave-refused`      | `respond.wave_refused`    |
 * | `respond.apply-failed`      | `respond.apply_failed`    |
 * | `respond.drift: off`        | `respond.drift: none`     |
 * | `reports.bucket`            | `reports.url`             |
 * | `telemetry.headers_secret`  | `telemetry.headers_env`   |
 * | `ephemeral`                 | `review_stacks`           |
 * | `forge: <kind>`             | `forge.kind`              |
 * | `forge_url`                 | `forge.url`               |
 * | `pass.secrets`              | `pass`                    |
 * | `notify.slack: <name>`      | `notify.slack.webhook`    |
 * | `notify.teams: <name>`      | `notify.teams.webhook`    |
 * | `notify.webhook: <name>`    | `notify.webhook.url`      |
 * | `notify.webhook_key`        | `notify.webhook.key`      |
 * | `notify.events`             | `notify.on`               |
 * | `notify.relay_key`          | `notify.relay`            |
 * | `review.key_secret`         | `review.key_env`          |
 * | `agent.key_secret`          | `agent.key_env`           |
 * | `runner`                    | `runners`                 |
 */
import { productConfigProblems, type ProductConfigProblem } from "@intentius/chant/ci-product";
import { error, isObject, warning, type ConfigProblem, type RawConfig } from "./types";

/** The product name in chant's vocabulary. */
const PRODUCT = "plywood";

/** The `notify.events` words and plywood's `notify.on` words. */
const EVENT_WORDS: Readonly<Record<string, string>> = { waiting: "wave-waiting", refused: "up-refused", failed: "up-failed", drift: "drift" };

/** The schema with each key in `keys` also written under its vocabulary key (`{ runners: "runner" }`), the same fragment. */
export function withVocabularyKeys(schema: Record<string, Record<string, unknown>>, keys: Readonly<Record<string, string>>): Record<string, Record<string, unknown>> {
  const out = { ...schema };
  for (const [internal, key] of Object.entries(keys)) out[key] = schema[internal]!;
  return out;
}

/** `from` as `to` in `obj`, unless `to` is set: that pair is an error chant reports, and the earlier spelling wins here. */
function move(obj: Record<string, unknown>, from: string, to: string): void {
  if (!(from in obj)) return;
  if (!(to in obj)) obj[to] = obj[from];
  delete obj[from];
}

function section(doc: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = doc[key];
  return isObject(v) ? v : undefined;
}

/** Whether an `environments` value is a glob's forge environment, as `forge_environments` takes one: a name, or a mapping of `name` and `url`. */
export function isGlobEnvironment(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k === "name" || k === "url");
}

/** The glob entries of `environments` (the earlier spelling) under `forge_environments`, which keeps a glob it names itself; the stage entries stay. */
function moveGlobEnvironments(doc: Record<string, unknown>): void {
  const earlier = section(doc, "environments");
  if (!earlier || (doc.forge_environments !== undefined && !isObject(doc.forge_environments))) return;
  const globs = Object.entries(earlier).filter(([, v]) => isGlobEnvironment(v));
  if (globs.length === 0) return;
  const own = section(doc, "forge_environments") ?? {};
  for (const [glob, v] of globs) {
    if (!(glob in own)) own[glob] = v;
    delete earlier[glob];
  }
  doc.forge_environments = own;
  if (Object.keys(earlier).length === 0) delete doc.environments;
}

/**
 * The config with each vocabulary key moved onto the spelling the groups
 * read. The input is not changed; a config that holds no vocabulary key comes
 * back as it was.
 */
export function readVocabulary(config: RawConfig): RawConfig {
  const doc = structuredClone(config) as Record<string, unknown>;

  moveGlobEnvironments(doc);
  move(doc, "ephemeral", "review_stacks");
  move(doc, "runner", "runners");

  // forge: a kind, with forge_url beside it; plywood reads forge.kind and forge.url.
  if (typeof doc.forge === "string") doc.forge = { kind: doc.forge };
  if ("forge_url" in doc) {
    if (doc.forge === undefined) doc.forge = {};
    if (isObject(doc.forge) && !("url" in doc.forge)) doc.forge.url = doc.forge_url;
    delete doc.forge_url;
  }

  // pass: the secrets as `pass.secrets`; a map of variable to secret stays as it was.
  const pass = section(doc, "pass");
  if (pass && Array.isArray(pass.secrets) && Object.keys(pass).length === 1) doc.pass = pass.secrets;

  const policy = section(doc, "policy");
  if (policy) move(policy, "path", "rego");

  const rules = section(doc, "approval_rules");
  if (rules) for (const rule of Object.values(rules)) if (isObject(rule)) move(rule, "count", "quorum");

  const respond = section(doc, "respond");
  if (respond) {
    move(respond, "wave-refused", "wave_refused");
    move(respond, "apply-failed", "apply_failed");
    if (respond.drift === "off") respond.drift = "none";
  }

  const reports = section(doc, "reports");
  if (reports) move(reports, "bucket", "url");

  const telemetry = section(doc, "telemetry");
  if (telemetry) move(telemetry, "headers_secret", "headers_env");

  for (const key of ["review", "agent"]) {
    const s = section(doc, key);
    if (s) move(s, "key_secret", "key_env");
  }

  const notify = section(doc, "notify");
  if (notify) {
    for (const chat of ["slack", "teams"]) if (typeof notify[chat] === "string") notify[chat] = { webhook: notify[chat] };
    if (typeof notify.webhook === "string") notify.webhook = { url: notify.webhook };
    if ("webhook_key" in notify) {
      if (notify.webhook === undefined) notify.webhook = {};
      if (isObject(notify.webhook) && !("key" in notify.webhook)) notify.webhook.key = notify.webhook_key;
      delete notify.webhook_key;
    }
    if (Array.isArray(notify.events)) notify.events = notify.events.map((e) => (typeof e === "string" ? (EVENT_WORDS[e] ?? e) : e));
    move(notify, "events", "on");
    move(notify, "relay_key", "relay");
  }

  return doc;
}

/**
 * chant's findings for a plywood.yml as written, as plywood's problems: an
 * earlier spelling is a warning, the rest are errors. chant reports a
 * spelling set beside its key where the alias names a fixed path; under
 * `approval_rules.<rule>` the rule's name varies, so a rule that sets both
 * `quorum` and `count` is reported here.
 */
export function vocabularyProblems(written: RawConfig): ConfigProblem[] {
  const out = productConfigProblems(written, { product: PRODUCT }).map((p: ProductConfigProblem) =>
    p.level === "warning" ? warning(p.path, `${p.message}; the key is ${p.key}`) : error(p.path, `${p.message} (${p.key})`),
  );
  const rules = isObject(written) ? section(written as Record<string, unknown>, "approval_rules") : undefined;
  for (const [name, rule] of Object.entries(rules ?? {})) {
    if (isObject(rule) && "quorum" in rule && "count" in rule) out.push(error(`approval_rules.${name}.quorum`, "is count's older spelling; set count alone"));
  }
  return out;
}
