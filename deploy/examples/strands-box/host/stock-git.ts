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
 *   with no credential read. What they then reach is the kernel's (Box's filesystem lists,
 *   `exec` included) and Box's egress, where every GitHub request is OCE's decision.
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
