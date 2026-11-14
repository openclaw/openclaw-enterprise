import {
  registerDedicatedGatewayCases,
  registerEmbeddedDockerCase,
} from "./plugin-runtime-policy-dedicated-gateway-cases.ts";
import {
  registerInstallationAndNativeAdminCases,
  registerInstallAndGrantCases,
} from "./plugin-runtime-policy-installation-cases.ts";
import { registerKubernetesAdmissionCases } from "./plugin-runtime-policy-kubernetes-admission-cases.ts";
import { registerSlackApprovalCases } from "./plugin-runtime-policy-slack-approval-cases.ts";
import { registerWorkspaceLaunchCases } from "./plugin-runtime-policy-workspace-launch-cases.ts";
import {
  registerWorkspacePollCases,
  registerWorkspaceTimeoutCase,
} from "./plugin-runtime-policy-workspace-poll-cases.ts";

registerInstallationAndNativeAdminCases();
registerSlackApprovalCases();
registerInstallAndGrantCases();
registerWorkspacePollCases();
registerWorkspaceLaunchCases();
registerKubernetesAdmissionCases();
registerWorkspaceTimeoutCase();
registerDedicatedGatewayCases();
registerEmbeddedDockerCase();
