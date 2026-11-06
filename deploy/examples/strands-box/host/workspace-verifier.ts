import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const WORKSPACE_VERIFIER = "/opt/demo/verifier/oce-workspace-verifier";
export const WORKSPACE_MARKER = ".oce-model-marker";

const REFUSAL = "workspace_verifier_refused";

/** Fixed operator artifact and fixed marker, with no pathname selected by the workload. */
export function verifyWorkspaceVerifier(sha256: string, workspace: string): void {
  if (!/^[a-f0-9]{64}$/.test(sha256) || realpathSync(WORKSPACE_VERIFIER) !== WORKSPACE_VERIFIER)
    throw new Error(REFUSAL);
  for (let path = dirname(WORKSPACE_VERIFIER); ; path = dirname(path)) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0)
      throw new Error(REFUSAL);
    if (path === "/") break;
  }
  const fd = openSync(
    WORKSPACE_VERIFIER,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== 0 ||
      info.nlink !== 1 ||
      info.size < 4 ||
      info.size > 8_000_000 ||
      (info.mode & 0o7022) !== 0 ||
      (info.mode & 0o111) === 0
    )
      throw new Error(REFUSAL);
    const bytes = readFileSync(fd);
    if (
      !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      createHash("sha256").update(bytes).digest("hex") !== sha256
    )
      throw new Error(REFUSAL);
  } finally {
    closeSync(fd);
  }
  if (realpathSync(workspace) !== workspace || !lstatSync(workspace).isDirectory())
    throw new Error(REFUSAL);
  const marker = lstatSync(join(workspace, WORKSPACE_MARKER));
  if (!marker.isFile() || marker.nlink !== 1 || marker.size !== 49) throw new Error(REFUSAL);
}

/** Box evaluates the expanded first word, resolved executable, argv and cwd at spawn. */
export function workspaceVerifierPolicy(workspace: string): string {
  const program = JSON.stringify(WORKSPACE_VERIFIER);
  return [
    '@id("oce_workspace_verifier")',
    'permit (principal, action == Box::Action::"shell:spawn", resource)',
    `when { context.input.program == ${program} && context.input.program_path == ${program} && context.input.arg_count == 0 && context.input.cwd == ${JSON.stringify(workspace)} && !(context.input has credential_reads) };`,
    "",
  ].join("\n");
}

/** Use a declared leaf so it does not receive the agent's read-write filesystem lists. */
export function workspaceVerifierTool(workspace: string): string {
  return [
    "[tool.oce_workspace_verifier]",
    `command = [${JSON.stringify(WORKSPACE_VERIFIER)}]`,
    `workspace = ${JSON.stringify(workspace)}`,
    "[tool.oce_workspace_verifier.filesystem]",
    `read_file = [${JSON.stringify(join(workspace, WORKSPACE_MARKER))}]`,
    "[tool.oce_workspace_verifier.network]",
    "contain_egress = true",
    "",
  ].join("\n");
}
