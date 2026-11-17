import { registerDockerWireCases } from "./docker-compute-wire-cases.ts";
import { registerEmbeddedRecoveryCases } from "./docker-compute-embedded-recovery-cases.ts";
import {
  registerGatewayLaunchCases,
  registerGatewayPolicyCase,
} from "./docker-compute-gateway-cases.ts";
import {
  registerDockerConfigurationCase,
  registerRevisionRecoveryCases,
  registerRevisionStopCase,
} from "./docker-compute-revision-cases.ts";
import { registerWorkspaceCases } from "./docker-compute-workspace-cases.ts";

registerDockerWireCases();
registerDockerConfigurationCase();
registerRevisionStopCase();
registerGatewayLaunchCases();
registerRevisionRecoveryCases();
registerWorkspaceCases();
registerGatewayPolicyCase();
registerEmbeddedRecoveryCases();
