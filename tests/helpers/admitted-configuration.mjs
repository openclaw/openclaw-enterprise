import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";

// Deployment admission keeps OpenClaw's earlier values for the settings its personal security
// preset would otherwise fill: another participant cannot steer a running turn, and apply_patch
// stays in the workspace. An explicit value in the Configuration wins.
export function withGatewaySecurityDefaults(values) {
  const exec = values.tools?.exec ?? {};
  return {
    ...values,
    messages: {
      ...values.messages,
      queue: { allowCollaborativeSteering: false, ...values.messages?.queue },
    },
    tools: {
      ...values.tools,
      exec: { ...exec, applyPatch: { workspaceOnly: true, ...exec.applyPatch } },
    },
  };
}

// The document deployment admission freezes into an AgentRevision when OCC owns native logging.
export function admittedConfiguration(values, level = "info") {
  return admitLoggingConfiguration(withGatewaySecurityDefaults(values), level);
}
