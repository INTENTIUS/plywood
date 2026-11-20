/**
 * `plywood view [--export <dir>] [--port <n>] [--no-open]`: the repository's
 * stacks as one graph in behold (INTENTIUS/behold), read from the workspace
 * ledger and the snapshots under `refs/chant/snapshots`.
 *
 * behold is not a dependency of the package. plywood holds the version it
 * runs and is tested with in BEHOLD_PIN and starts it with `npx`, so a
 * repository that never runs `view` never fetches behold and the bundle stays
 * as it is. behold carries the pulumi lexicon that reads the stacks; the pin
 * names the same range behold depends on, so npx installs one copy.
 *
 * Read-only: the command writes nothing to the repository. `--export` writes
 * the static view to the directory it is given.
 *
 * The child process is injectable (ViewDeps), so tests run no npx.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The behold `plywood view` runs, and the pulumi lexicon it reads stacks with. Tested together; move them together. */
export const BEHOLD_PIN = {
  behold: "@intentius/behold@0.34.2",
  lexicon: "@intentius/chant-lexicon-pulumi@^0.124.102",
} as const;

/** behold's own default port. */
export const VIEW_PORT = 4600;

/** The behold version the pin names. */
export const beholdVersion = (): string => BEHOLD_PIN.behold.slice(BEHOLD_PIN.behold.lastIndexOf("@") + 1);

export interface ViewOptions {
  /** The checkout behold draws. */
  root: string;
  port?: number;
  /** Open the browser once behold answers. Default true. */
  open?: boolean;
  /** Export a static view to this directory instead of serving. */
  export?: string;
}

/** npx's arguments for behold: serve, or export with `--export`. */
export function beholdArgv(o: ViewOptions): string[] {
  const packages = ["--yes", "-p", BEHOLD_PIN.behold, "-p", BEHOLD_PIN.lexicon];
  if (o.export !== undefined) return [...packages, "behold", "export", o.root, "--out", o.export];
  return [...packages, "behold", "serve", o.root, "--port", String(o.port ?? VIEW_PORT)];
}

/** A started child process, as the command sees it. */
export interface ViewChild {
  /** Called with each chunk the child writes to stdout or stderr. */
  output(fn: (text: string) => void): void;
  /** How it ended: its exit code (null when a signal stopped it), or the error that kept it from starting. */
  exit: Promise<{ code: number | null; error?: NodeJS.ErrnoException }>;
  kill(signal: NodeJS.Signals): void;
}

/** `group`: the child leads its own process group and a signal goes to the whole group, so behold stops with npx. */
export type ViewSpawn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; detached?: boolean; group?: boolean }) => ViewChild;

export interface ViewDeps {
  spawn: ViewSpawn;
  fetch: (url: string) => Promise<{ status: number }>;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** A line for stdout. */
  print(line: string): void;
  /** A line for stderr. */
  warn(line: string): void;
  /** behold's own output once it serves, passed through. */
  forward(text: string): void;
  /** Call `fn` on SIGINT and SIGTERM until the returned function is called. */
  onSignal(fn: (signal: NodeJS.Signals) => void): () => void;
  sleep(ms: number): Promise<void>;
  /** How long to wait for behold to answer; npx may be downloading it. Default 300 s. */
  readyMs?: number;
}

const POLL_MS = 500;

const oneLine = (s: string): string => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > 400 ? `${line.slice(0, 397)}...` : line;
};

/** The one line that says why behold stopped, from what it printed, or undefined when nothing in it is recognized. */
export function explainBehold(text: string, o: Pick<ViewOptions, "port">): string | undefined {
  const fetchFailed = /No matching version found for (\S+?)\.?(?:\s|$)/.exec(text) ?? /404\s+'?(\S+?)'? is not in this registry/.exec(text);
  if (fetchFailed) return `npx could not fetch ${fetchFailed[1]} from the npm registry; plywood runs ${BEHOLD_PIN.behold} with ${BEHOLD_PIN.lexicon}`;
  const module = /Cannot find (?:package|module) ['"](@intentius\/chant-lexicon-pulumi)[^'"]*['"]/.exec(text);
  if (module) return `behold could not load ${module[1]}, the pulumi reader npx installs beside it (${BEHOLD_PIN.lexicon})`;
  if (/EADDRINUSE/.test(text)) return `port ${o.port ?? VIEW_PORT} is in use; pass --port with a free one`;
  const said = /^behold (?:serve|export): ([^\n]*)(?:\n {2,}([^\n]*))?/m.exec(text);
  if (said) return oneLine(`${said[1]} ${said[2] ?? ""}`);
  return undefined;
}

function lastWords(text: string, code: number | null): string {
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return oneLine(`behold exited ${code ?? "on a signal"}${last ? `: ${last}` : ""}`);
}

const NO_NPX = "npx is not on the PATH: plywood view runs behold with npx, which comes with Node.js";

/** The command and arguments that open `url` in the browser. */
export function opener(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", '""', url]];
  return ["xdg-open", [url]];
}

/** Run behold: serve and open the browser until Ctrl-C, or export. Returns the exit code. */
export async function view(o: ViewOptions, deps: ViewDeps): Promise<number> {
  const fail = (line: string): number => {
    deps.warn(`plywood view: ${line}`);
    return 1;
  };
  const port = o.port ?? VIEW_PORT;
  const url = `http://127.0.0.1:${port}`;
  if (o.export === undefined) {
    // Something already answering there would pass for behold.
    try {
      await deps.fetch(`${url}/`);
      return fail(`something already answers on ${url}; stop it or pass --port with a free one`);
    } catch {
      // Nothing there: the port is free.
    }
  }
  const child = deps.spawn("npx", beholdArgv(o), { cwd: o.root, env: deps.env, group: true });
  let out = "";
  let serving = false;
  child.output((t) => {
    out = (out + t).slice(-65536);
    if (serving) deps.forward(t);
  });
  let ended: { code: number | null; error?: NodeJS.ErrnoException } | undefined;
  void child.exit.then((e) => (ended = e));
  let stopped = false;
  const unhook = deps.onSignal((signal) => {
    stopped = true;
    child.kill(signal);
  });
  const ending = (e: { code: number | null; error?: NodeJS.ErrnoException }): number => {
    if (e.error) return fail(e.error.code === "ENOENT" ? NO_NPX : `could not start npx: ${e.error.message}`);
    if (stopped || e.code === 0) return 0;
    return fail(explainBehold(out, o) ?? lastWords(out, e.code));
  };
  try {
    if (o.export !== undefined) {
      deps.print(`plywood view: exporting with behold ${beholdVersion()} to ${o.export}`);
      return ending(await child.exit);
    }
    deps.print(`plywood view: starting behold ${beholdVersion()} with npx on ${o.root}`);
    const tries = Math.max(1, Math.ceil((deps.readyMs ?? 300_000) / POLL_MS));
    for (let i = 0; ; i++) {
      if (ended) return ending(ended);
      let status: number | undefined;
      try {
        status = (await deps.fetch(`${url}/`)).status;
      } catch {
        // Not listening yet.
      }
      if (status !== undefined) {
        if (status >= 200 && status < 300) break;
        child.kill("SIGTERM");
        return fail(`behold answered ${url} with ${status}`);
      }
      if (i + 1 >= tries) {
        child.kill("SIGTERM");
        return fail(explainBehold(out, o) ?? `behold did not answer on ${url} within ${Math.round((tries * POLL_MS) / 1000)} s`);
      }
      await deps.sleep(POLL_MS);
    }
    serving = true;
    deps.print(`plywood view: behold serves ${url}; Ctrl-C stops it`);
    if (o.open !== false) {
      const [cmd, args] = opener(deps.platform, url);
      const browser = deps.spawn(cmd, args, { cwd: o.root, env: deps.env, detached: true });
      void browser.exit.then((e) => {
        if (e.error || e.code) deps.warn(`plywood view: open ${url} in a browser`);
      });
    }
    return ending(await child.exit);
  } finally {
    unhook();
  }
}

/** The checkout's top directory: the nearest parent with a `.git`, or `cwd` outside a checkout. */
export function repoRoot(cwd: string): string {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return resolve(cwd);
  }
}

/** The real process, network and signals. */
export function nodeViewDeps(): ViewDeps {
  return {
    spawn(cmd, args, opts) {
      const group = opts.group === true && process.platform !== "win32";
      const child = nodeSpawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: opts.detached ? "ignore" : ["ignore", "pipe", "pipe"],
        ...(opts.detached || group ? { detached: true } : {}),
        // npx is npx.cmd on Windows, which Node starts only through a shell.
        ...(process.platform === "win32" ? { shell: true } : {}),
      });
      const listeners: ((t: string) => void)[] = [];
      child.stdout?.on("data", (d) => listeners.forEach((f) => f(String(d))));
      child.stderr?.on("data", (d) => listeners.forEach((f) => f(String(d))));
      const exit = new Promise<{ code: number | null; error?: NodeJS.ErrnoException }>((res) => {
        child.on("error", (error) => res({ code: null, error }));
        child.on("close", (code) => res({ code }));
      });
      if (opts.detached) child.unref();
      return {
        output: (fn) => void listeners.push(fn),
        exit,
        kill: (signal) => {
          if (group && child.pid !== undefined) {
            try {
              process.kill(-child.pid, signal);
              return;
            } catch {
              // The group is gone; signal the child alone.
            }
          }
          child.kill(signal);
        },
      };
    },
    fetch: (url) => fetch(url, { signal: AbortSignal.timeout(2000) }),
    env: process.env,
    platform: process.platform,
    print: (line) => console.log(line),
    warn: (line) => console.error(line),
    forward: (text) => void process.stdout.write(text),
    onSignal(fn) {
      const h = (s: NodeJS.Signals) => fn(s);
      process.on("SIGINT", h);
      process.on("SIGTERM", h);
      return () => {
        process.off("SIGINT", h);
        process.off("SIGTERM", h);
      };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** `plywood view` for the command line: flags in, exit code out. */
export async function viewCommand(args: string[], cwd: string, warn: (line: string) => void, deps: ViewDeps = nodeViewDeps()): Promise<number> {
  const usage = "plywood view [--export <dir>] [--port <n>] [--no-open]";
  let out: string | undefined;
  let port: number | undefined;
  let open = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-open") open = false;
    else if (a === "--export" || a === "--port") {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) {
        warn(`plywood view: ${a} takes a value: ${usage}`);
        return 1;
      }
      if (a === "--export") out = v;
      else port = Number(v);
    } else {
      warn(`plywood view: unknown argument '${a}': ${usage}`);
      return 1;
    }
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    warn("plywood view: --port takes a port number");
    return 1;
  }
  if (port !== undefined && out !== undefined) {
    warn("plywood view: --port is for serving; --export writes files and serves nothing");
    return 1;
  }
  return view({ root: repoRoot(cwd), open, ...(port !== undefined ? { port } : {}), ...(out !== undefined ? { export: resolve(cwd, out) } : {}) }, deps);
}
