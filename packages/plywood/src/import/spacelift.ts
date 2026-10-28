/**
 * `plywood init --from spacelift`: `.spacelift/config.yml` (version 1),
 * the stack settings Spacelift reads from the repository. A stack's branch,
 * autodeploy and policies live in Spacelift itself, so they are not here to
 * read. Each stack, with `stack_defaults` laid under it:
 *
 *   project_root    stacks.<key>.dir; the project is the Pulumi.yaml's name
 *                   there, and the stack is the Spacelift stack's id when a
 *                   Pulumi.<id>.yaml is beside it, else that directory's one stack
 *   runner_image    image
 *
 * `environment`, the `before_*` and `after_*` hooks and every other key are
 * listed as not carried, by name.
 */
import { isObject, type RawConfig } from "../config/types";
import { firstPresent, projectAt, readDoc, repoJoin, stackEntry, type Importer, type Unsupported } from "./types";

export const SPACELIFT_FILES = [".spacelift/config.yml", ".spacelift/config.yaml"];
const CARRIED = ["project_root", "runner_image"];

export const importSpacelift: Importer = (root, detected, named) => {
  const keys: RawConfig = {};
  const unsupported: Unsupported[] = [];
  const notes: string[] = [];
  const file = named[0] ?? firstPresent(root, SPACELIFT_FILES);
  if (!file) return { source: "spacelift", files: [], keys, unsupported, notes: [`no ${SPACELIFT_FILES[0]} in the repository`] };
  for (const extra of named.slice(1)) unsupported.push({ file: extra, setting: "(file)", why: "Spacelift reads one config file; this one was not read" });
  const doc = readDoc(root, file);
  if (!isObject(doc)) return { source: "spacelift", files: [file], keys, unsupported: [{ file, setting: "(file)", why: "is not a mapping" }], notes };
  const defaults = isObject(doc.stack_defaults) ? doc.stack_defaults : {};
  const stacks = isObject(doc.stacks) ? doc.stacks : {};
  for (const k of Object.keys(doc).filter((x) => !["version", "stack_defaults", "stacks"].includes(x))) {
    unsupported.push({ file, setting: k, why: k === "module_version" || k === "tests" ? "Spacelift module settings; plywood runs stacks" : "plywood has no setting for it" });
  }
  const images = new Set<string>();
  const listOthers = (s: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(s)) {
      if (CARRIED.includes(k)) continue;
      const why =
        k === "environment"
          ? `set each one as a forge variable or secret: ${isObject(v) ? Object.keys(v).sort().join(", ") : "(none)"}`
          : /^(before|after)_/.test(k)
            ? "plywood runs no hook around chant's stages; put the commands in the job's image or the stack's program"
            : "plywood has no setting for it";
      unsupported.push({ file, setting: `${prefix}.${k}`, why });
    }
  };
  listOthers(defaults, "stack_defaults");
  for (const [id, raw] of Object.entries(stacks)) {
    const own = isObject(raw) ? raw : {};
    const s = { ...defaults, ...own };
    const dir = repoJoin(typeof s.project_root === "string" ? s.project_root : ".");
    const project = projectAt(detected, dir);
    if (!project) {
      unsupported.push({ file, setting: `stacks.${id}.project_root`, why: `${dir} holds no Pulumi.yaml` });
      continue;
    }
    let stack = id;
    if (!project.stacks.includes(id)) {
      if (project.stacks.length === 1) {
        stack = project.stacks[0]!;
        notes.push(`Spacelift stack ${id} is ${project.name}/${stack}, the one stack in ${dir}`);
      } else notes.push(`Spacelift stack ${id} has no Pulumi.${id}.yaml in ${dir}; it is listed as ${project.name}/${id}, so run pulumi stack init ${id} there or rename it in plywood.yml`);
    }
    const key = `${project.name}/${stack}`;
    const entry = stackEntry(keys, key);
    if (dir !== ".") entry.dir = dir;
    if (typeof s.runner_image === "string") images.add(s.runner_image);
    listOthers(own, `stacks.${id}`);
  }
  if (images.size === 1) keys.image = [...images][0];
  else if (images.size > 1) unsupported.push({ file, setting: "runner_image", why: `the stacks run in ${images.size} images; plywood runs every job in one, so set image to the one that has every tool` });
  notes.push("a stack's branch, autodeploy and policies are Spacelift settings outside the repository; set branches, gate and policy in plywood.yml");
  return { source: "spacelift", files: [file], keys, unsupported, notes };
};
