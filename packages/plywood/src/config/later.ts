/**
 * Keys reference/config.md lists whose groups land in later plywood units.
 * Each is accepted as written and not yet turned into chant's settings, so
 * a plywood.yml that sets one checks clean today and keeps working once the
 * group lands. A unit that builds one of these adds its group file under
 * src/config/ and takes the key out of LATER_KEYS.
 */
import type { ConfigGroup } from "./types";

export const LATER_KEYS: Readonly<Record<string, string>> = {
  policy: "plywood#13",
  drift: "plywood#8",
  identity: "plywood#14",
  pulumi_cloud: "plywood#14",
  notify: "plywood#20",
  telemetry: "plywood#20",
  reports: "plywood#20",
  review: "plywood#19",
  agent: "plywood#19",
  control: "plywood#18",
  pulumi: "plywood#12",
  plunge: "plywood#12",
  runners: "plywood#12",
  env: "plywood#5",
  pass: "plywood#5",
  parallelism: "plywood#5",
  environments: "plywood#5",
};

export const later: ConfigGroup = {
  name: "later",
  keys: Object.keys(LATER_KEYS),
  schema: Object.fromEntries(Object.keys(LATER_KEYS).map((k) => [k, { description: "Read by a later plywood; accepted as written." }])),
  check: () => [],
  translate() {},
};
