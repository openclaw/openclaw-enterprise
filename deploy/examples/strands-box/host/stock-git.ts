import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
