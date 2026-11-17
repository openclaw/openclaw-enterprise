import { lstatSync, mkdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { WORKSPACE_MARKER } from "./workspace-verifier.ts";

/**
 * The workload's own shell in a protected repository run (finding 3314).
 *
 * Box's Strands Shell decides every command: a shell command as `shell:exec`, each file it
 * touches as `fs:*`, and a host binary as `shell:spawn`, all default deny (exit 126). The
 * protected run's purpose is that the Agent's tool shell runs stock `git` and `gh` against the
 * repository, with Box placing OCE's per-request credential at egress; with no rule for them,
 * nothing the model asks can run. These rules grant, and only for this run:
 *
 * - shell commands, which reach only what the `fs:*` rules below grant;
 * - the workspace (read, write; never delete), and `/dev/null`;
 * - `shell:spawn` of exactly the stock `git` and `gh` host binaries, from inside the workspace,
 *   with no credential read. Each then runs in its own `[tool]` boundary (`stockGitTools`), not
 *   the agent's, and reaches Box's egress, where every GitHub request is OCE's decision.
 *
 * Writes that would change how the Harness itself runs stay refused: a project `.codex`
 * directory in the workspace and the workspace verifier's marker.
 */
export const STOCK_GIT = "/usr/bin/git";
export const STOCK_GH = "/usr/local/bin/gh";

/**
 * Git and gh never enter the agent's own boundary (finding 3325). Codex runs git itself, outside
 * Box's shell, in the workspace root at every turn start (`status --porcelain`, `rev-parse`,
 * `remote`, `config`). With git in the agent's exec list, a workspace repository whose attributes
 * name a `clean` filter of a program the agent may run (Node) runs workload-written code with the
 * Codex home, the native hook credential and the bridge in reach. Without it Codex finds no git
 * and carries on without git information, and the workload's git and gh still run in their own
 * `[tool]` boundaries below, which Box's shell starts without the agent's exec grant. So an exec
 * grant that covers git or gh in a standard program directory or the agent's search path, or git's
 * helper directory, is refused.
 */
export const AGENT_SEARCH_PATH = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
] as const;
const GIT_HELPERS = ["/usr/lib/git-core", "/usr/libexec/git-core"] as const;
/**
 * Box mounts these readable and executable in every boundary, with no grant (finding 3333): Box's
 * Linux runtime minimum, `LOADER_DIRECTORIES` in `crates/box/src/run/contain/runtime_minimum.rs`.
 * Debian and Ubuntu ship a complete git there, `/usr/lib/git-core/git`. It stays executable by its
 * full path; it stays unused while nothing names it: no directory on the admitted search path, or
 * among those the runtime adds (`runtimeSearchPath`), may lead to it when the host checks.
 */
export const LOADER_DIRECTORIES = ["/lib", "/lib64", "/usr/lib", "/usr/lib64"] as const;
/**
 * What a path here means depends on the process that resolves it (`/proc/self/cwd` is Codex's
 * working directory, the workspace, inside Box; `/dev/fd/N` is one of its descriptors), or the
 * kernel makes it up. The host cannot judge such a path for Codex, so a search path entry may not
 * lie in or pass through one (finding 3339).
 */
export const UNJUDGEABLE_DIRECTORIES = ["/proc", "/dev", "/sys"] as const;
/** Linux's own limit on the links one lookup follows (`MAXSYMLINKS`); past it, a lookup fails. */
const MAX_LINKS = 40;

const within = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
const unjudgeable = (path: string) =>
  UNJUDGEABLE_DIRECTORIES.some((directory) => within(directory, path));

interface Resolution {
  /** Where the path leads: each existing component resolved, an absent rest kept as written. */
  readonly path: string;
  /** Every path the lookup passes: each component, each link and each target, in order. */
  readonly visited: readonly string[];
  /**
   * False when the host cannot judge the path: a component under `/proc`, `/dev` or `/sys`,
   * more links than Linux follows (a loop), or any failure but an absent component.
   */
  readonly judged: boolean;
}

/**
 * Resolve a path one component at a time, as the kernel does: a link's target replaces it, a
 * relative target is read from the link's own directory, and `..` leaves the directory reached so
 * far, not the one written. A dangling link resolves to its target. Never throws.
 */
function resolution(path: string): Resolution {
  const visited: string[] = [];
  const unjudged = (at: string): Resolution => ({ path: at, visited, judged: false });
  if (!isAbsolute(path)) return unjudged(path);
  let pending = path.split("/");
  let current = "/";
  let links = 0;
  let absent = false;
  try {
    while (pending.length > 0) {
      const name = pending.shift()!;
      if (name === "" || name === ".") continue;
      if (name === "..") {
        current = dirname(current);
        continue;
      }
      const next = join(current, name);
      visited.push(next);
      if (unjudgeable(next)) return unjudged(next);
      current = next;
      if (absent) continue;
      let link: string | undefined;
      try {
        const stat = lstatSync(next);
        if (stat.isSymbolicLink()) link = readlinkSync(next);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return unjudged(next);
        // Absent: the rest is as written, and may appear later.
        absent = true;
        continue;
      }
      if (link === undefined) continue;
      links += 1;
      if (links > MAX_LINKS) return unjudged(next);
      pending = [...link.split("/"), ...pending];
      current = link.startsWith("/") ? "/" : dirname(next);
    }
  } catch {
    return unjudged(current);
  }
  return { path: current, visited, judged: true };
}

/**
 * The directories the stock runtime puts on Codex's search path at run time, inside the agent's
 * writable state, which the host never sees in the admitted `PATH` (finding 3338). Derived from
 * the inputs the runtime itself uses:
 *
 * - the combined workspace-node program appends `$HOME/.local/bin` and
 *   `$HOME/.openclaw/tools/node/npm/bin` (`agentWithNodeEntrypoint`, `harnessPath`, in Compute's
 *   `runtime-entrypoints.ts`, with `HOME` defaulting to `/home/node`);
 * - Codex prepends a fresh directory it makes under `$CODEX_HOME/tmp/arg0` (`CODEX_HOME`
 *   defaulting to `$HOME/.codex`).
 *
 * Every layout gets the check: a `git` there has no use in any of them.
 */
export function runtimeSearchPath(environment: Readonly<Record<string, string>>): string[] {
  const home = environment.HOME || "/home/node";
  const codexHome = environment.CODEX_HOME || join(home, ".codex");
  return [
    join(home, ".local/bin"),
    join(home, ".openclaw/tools/node/npm/bin"),
    join(codexHome, "tmp/arg0"),
  ];
}

/**
 * True when the agent's boundary could run git or gh by name: an exec grant over one of them or
 * over git's helper directory, or a search path entry that is relative or empty (the working
 * directory, the workspace), that the host cannot judge (under `/proc`, `/dev` or `/sys`, or a
 * link loop), or that passes on its way (any component, link or target) through a loader
 * directory, git's helper directory or a directory the agent's boundary may write (`writable`:
 * a link there could be changed to name the loader directory's git), or that holds a `git` or
 * `gh` leading into a loader directory. `appended` are directories the runtime adds inside the
 * writable state (`runtimeSearchPath`): each must hold no `git` or `gh` of any kind, and must
 * contain no link (a link could lead into the workspace, where the workload's own git writes).
 * Never throws: a path it cannot judge counts as covering git.
 */
export function execCoversGit(
  grants: readonly string[],
  searchPath: readonly string[] = AGENT_SEARCH_PATH,
  writable: readonly string[] = [],
  appended: readonly string[] = [],
): boolean {
  try {
    // A directory as written and where it leads.
    const both = (paths: readonly string[]) => [
      ...new Set(paths.flatMap((path) => [resolve(path), resolution(path).path])),
    ];
    const loaders = both(LOADER_DIRECTORIES);
    const helpers = both(GIT_HELPERS);
    const closed = [...loaders, ...helpers];
    const written = both(writable);
    const unsafeEntry = (entry: string) => {
      if (!isAbsolute(entry)) return true;
      const { path, visited, judged } = resolution(entry);
      return (
        !judged ||
        [resolve(entry), path, ...visited].some(
          (step) =>
            unjudgeable(step) ||
            [...closed, ...written].some((directory) => within(directory, step)),
        )
      );
    };
    if (searchPath.some(unsafeEntry)) return true;
    const unsafeAppended = (directory: string) => {
      if (!isAbsolute(directory)) return true;
      const { path, visited, judged } = resolution(directory);
      if (
        !judged ||
        path !== resolve(directory) ||
        [path, ...visited].some((step) => closed.some((loader) => within(loader, step)))
      )
        return true;
      return ["git", "gh"].some((name) => {
        try {
          lstatSync(join(path, name));
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return code !== "ENOENT" && code !== "ENOTDIR";
        }
      });
    };
    if (appended.some(unsafeAppended)) return true;
    const named = [...AGENT_SEARCH_PATH, ...searchPath].flatMap((directory) => [
      join(directory, "git"),
      join(directory, "gh"),
    ]);
    // A link by one of those names that leads into a loader directory runs with no grant.
    const resolved = named.map(resolution);
    if (
      resolved.some(
        ({ path, visited, judged }) =>
          !judged ||
          [path, ...visited].some((step) => loaders.some((directory) => within(directory, step))),
      )
    )
      return true;
    // Each one and its real file, where it is a link to a file elsewhere.
    const programs = [...new Set([...named, ...resolved.map(({ path }) => path), ...GIT_HELPERS])];
    // A grant over one of them, or inside git's helper directory (each helper is git); a linked
    // grant counts as its real file too.
    if (grants.some((grant) => !resolution(grant).judged)) return true;
    return both(grants).some(
      (grant) =>
        programs.some((program) => within(grant, program)) ||
        helpers.some((directory) => within(directory, grant)),
    );
  } catch {
    return true;
  }
}

export function stockGitPolicy(workspace: string): string {
  const w = JSON.stringify(workspace);
  const below = JSON.stringify(`${workspace}/*`);
  const codex = JSON.stringify(`${workspace}/.codex`);
  const codexBelow = JSON.stringify(`${workspace}/.codex/*`);
  const marker = JSON.stringify(`${workspace}/${WORKSPACE_MARKER}`);
  const inWorkspace = (field: string) =>
    `(context.input.${field} == ${w} || context.input.${field} like ${below})`;
  return [
    '@id("oce_workload_shell")',
    'permit (principal, action == Box::Action::"shell:exec", resource);',
    '@id("oce_workspace_read")',
    'permit (principal, action == Box::Action::"fs:read", resource)',
    `when { ${inWorkspace("path")} };`,
    '@id("oce_workspace_write")',
    'permit (principal, action == Box::Action::"fs:write", resource)',
    `when { context.input.path like ${below} };`,
    '@id("oce_dev_null")',
    'permit (principal, action in [Box::Action::"fs:read", Box::Action::"fs:write"], resource)',
    'when { context.input.path == "/dev/null" };',
    '@id("oce_stock_git")',
    'permit (principal, action == Box::Action::"shell:spawn", resource)',
    `when { (context.input.program_path == ${JSON.stringify(STOCK_GIT)} || context.input.program_path == ${JSON.stringify(STOCK_GH)}) && ${inWorkspace("cwd")} && !(context.input has credential_reads) };`,
    '@id("oce_harness_files")',
    'forbid (principal, action in [Box::Action::"fs:write", Box::Action::"fs:delete", Box::Action::"fs:move"], resource)',
    `when { context.input.path == ${codex} || context.input.path like ${codexBelow} || context.input.path == ${marker} };`,
    "",
  ].join("\n");
}

/**
 * The two programs' own boundaries on a protected repository run (finding 3320). Box runs a host
 * binary that no `[tool]` table names inside the agent's boundary, which reaches the Codex home,
 * the native hook relay credentials and the bridge sockets; a binary raises no `fs:*` decision,
 * so the shell's file rules above do not bind it. A table that names the binary's file gives it a
 * leaf boundary of its own instead, and the children it starts stay in that boundary:
 *
 * - `git`: the workspace, read and write. `gh`: the workspace, read only, and the `git` file
 *   (readable is executable in a leaf), which it runs for remote and branch lookups.
 * - Both: Box's leaf minimum (system libraries, `/etc/ssl`, `/dev/null`, Box's gateway CA) and
 *   nothing else: no Git or `gh` configuration file, so a Git identity must be repository-local.
 * - `deny`: the workspace's `.codex` (project Codex configuration) and, with the verifier, its
 *   marker: the paths the shell policy forbids its own writes to. Box refuses a deny path that
 *   does not exist at start, so the host makes `.codex` first (`ensureWorkspaceCodex`).
 * - `HOME`: the agent's. No `workspace` key: a program starts in the shell's current directory
 *   when that lies in the workspace (Box's default for a table), which the spawn permit checks.
 * - Egress through Box's gateway. Box gives every boundary every route and its placeholder
 *   variables, so the GitHub routes inject for both programs as for the agent, and the model
 *   route is as reachable from them as from the agent: Box cannot attribute a request to a process.
 */
export function stockGitTools(workspace: string, home: string, marker: boolean): string {
  const quoted = (value: string) => JSON.stringify(value);
  const list = (paths: readonly string[]) => `[${paths.map(quoted).join(", ")}]`;
  const deny = list([
    join(workspace, ".codex"),
    ...(marker ? [join(workspace, WORKSPACE_MARKER)] : []),
  ]);
  return [
    "[tool.git]",
    `command = ${list([STOCK_GIT])}`,
    `env = { HOME = ${quoted(home)} }`,
    "[tool.git.filesystem]",
    `read = ${list([workspace])}`,
    `write = ${list([workspace])}`,
    `deny = ${deny}`,
    "[tool.git.network]",
    "contain_egress = true",
    "",
    "[tool.gh]",
    `command = ${list([STOCK_GH])}`,
    `env = { HOME = ${quoted(home)} }`,
    "[tool.gh.filesystem]",
    `read = ${list([workspace])}`,
    `read_file = ${list([STOCK_GIT])}`,
    `deny = ${deny}`,
    "[tool.gh.network]",
    "contain_egress = true",
    "",
  ].join("\n");
}

/**
 * The workspace's `.codex`, which both tools deny, must exist when Box starts: absent, the host
 * makes it an empty directory (its own user, mode 0700); a directory is kept as it is; anything
 * else (a link, a file) refuses the start. Codex reads its project configuration there; an empty
 * directory changes nothing for it.
 */
export function ensureWorkspaceCodex(workspace: string): void {
  const path = join(workspace, ".codex");
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!lstatSync(path).isDirectory()) throw new Error("workspace_codex_refused");
}
