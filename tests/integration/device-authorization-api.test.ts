import { registerDeviceAuthorizationAgentCases } from "./device-authorization-api-agent-cases.ts";
import { registerDeviceAuthorizationRefusalCases } from "./device-authorization-api-refusal-cases.ts";
import { registerDeviceAuthorizationSessionCases } from "./device-authorization-api-session-cases.ts";

registerDeviceAuthorizationAgentCases();
registerDeviceAuthorizationSessionCases();
registerDeviceAuthorizationRefusalCases();
