import {
  AGENT_WITH_NODE_ENTRYPOINT,
  CODEX_WORKSPACE_NODE_COMMANDS,
  PROVIDER_CODEX_ONLY_PROGRAM,
  RUNTIME_WRAPPER_COMMAND,
} from "./kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments, withoutLineComments } from "./node-program.ts";

/**
 * The stock dedicated Codex launch with its file-only workspace node, for a Sandbox that runs
 * that node outside a Compute-owned Pod. This module is the supported surface for such a
 * Sandbox (package export `@openclaw-enterprise/controller/workspace-node-launch`); every value
 * is byte-identical to what Kubernetes Compute renders in the same release.
 */
export interface StockWorkspaceNodeLaunch {
  /** The combined Codex and workspace-node program Compute delivers in `requirements.command`. */
  readonly combinedProgram: string;
  /** The argv that runs the same Codex child without the in-Pod node supervisor. */
  readonly codexCommand: readonly string[];
  /** The exact command allowlist of the separately confined file-only node. */
  readonly nodeCommands: string;
}

let stock: StockWorkspaceNodeLaunch | undefined;

export function stockWorkspaceNodeLaunch(): StockWorkspaceNodeLaunch {
  stock ??= Object.freeze({
    combinedProgram: withoutLineComments(AGENT_WITH_NODE_ENTRYPOINT),
    codexCommand: Object.freeze([
      ...RUNTIME_WRAPPER_COMMAND,
      ...nodeProgramArguments(PROVIDER_CODEX_ONLY_PROGRAM),
    ]),
    nodeCommands: CODEX_WORKSPACE_NODE_COMMANDS,
  });
  return stock;
}
