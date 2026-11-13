import { registerAgentAdmissionCases } from "./configuration-occ-agent-admission-cases.ts";
import { registerConfigurationDocumentCases } from "./configuration-occ-document-cases.ts";
import { administrator, fixture } from "./configuration-occ-fixture.ts";
import { registerConfigurationIAMCases } from "./configuration-occ-iam-cases.ts";
import { registerConfigurationModelPolicyCases } from "./configuration-occ-model-policy-cases.ts";
import { registerConfigurationPersistenceCases } from "./configuration-occ-persistence-cases.ts";
import { registerRuntimeAdmissionCases } from "./configuration-occ-runtime-admission-cases.ts";
import { registerSandboxCapabilityCases } from "./configuration-occ-sandbox-cases.ts";

registerAgentAdmissionCases();
registerConfigurationPersistenceCases({ fixture, administrator });
registerConfigurationDocumentCases();
registerConfigurationModelPolicyCases();
registerRuntimeAdmissionCases();
registerSandboxCapabilityCases();
registerConfigurationIAMCases();
