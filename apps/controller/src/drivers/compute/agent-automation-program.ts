import type { AgentRevision, WorkspaceSetup } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";

import { EMBEDDED_GATEWAY_OWNER_STARTUP } from "./embedded-gateway-owner.ts";
import { readCanonicalNodeProgram, withoutLineComments } from "./node-program.ts";
import { workspaceSetupMainEntry, workspaceSetupVerifier } from "./workspace-setup-runtime.ts";

/** Match the complete controller-rendered program; no unverified prefix can execute. */
export function verifyAgentAutomationProgram(
  args: unknown,
  revision: Readonly<AgentRevision>,
  gatewayProgram: string,
): boolean {
  const observed = readCanonicalNodeProgram(args);
  if (observed === undefined) {
    return false;
  }
  const embedded = revision.harness.mode === "embedded";
  const prefix = embedded ? EMBEDDED_GATEWAY_OWNER_STARTUP : "";
  const exact = (program: string) => observed === withoutLineComments(program);
  if (exact(prefix + gatewayProgram)) {
    return true;
  }
  if (!embedded) {
    return false;
  }
  const match = observed.match(/\n {8}input: ("(?:[^"\\]|\\.)*"),\n {8}env:/u);
  if (!match) {
    return false;
  }
  let identity: Record<string, unknown> | undefined;
  try {
    identity = asRecord(JSON.parse(JSON.parse(match[1]!)));
  } catch {
    return false;
  }
  if (
    !identity ||
    Object.keys(identity).some(
      (key) => !["id", "namespaceId", "agentId", "defaultsId", "completed"].includes(key),
    ) ||
    typeof identity.id !== "string" ||
    identity.id.length === 0 ||
    identity.id.length > 128 ||
    identity.namespaceId !== revision.namespaceId ||
    identity.agentId !== revision.agentId ||
    identity.completed !== true ||
    (identity.defaultsId !== undefined &&
      (typeof identity.defaultsId !== "string" || !/^[a-f0-9]{64}$/u.test(identity.defaultsId)))
  ) {
    return false;
  }
  const workspace =
    workspaceSetupMainEntry(revision.configuration)?.agent?.workspace ??
    asRecord(asRecord(revision.configuration.agents)?.defaults)?.workspace ??
    "/home/node/.openclaw/workspace";
  if (typeof workspace !== "string") {
    return false;
  }
  const setup: Pick<WorkspaceSetup, "id" | "namespaceId" | "agentId" | "defaultsId"> = {
    id: identity.id,
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    ...(identity.defaultsId === undefined ? {} : { defaultsId: identity.defaultsId as string }),
  };
  return exact(prefix + workspaceSetupVerifier(setup, workspace) + gatewayProgram);
}
