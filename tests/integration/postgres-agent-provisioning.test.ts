import { registerChannelCurrentnessCases } from "./postgres-agent-provisioning-channel-currentness-cases.ts";

import { registerConfigurationResendCases } from "./postgres-agent-provisioning-configuration-resend-cases.ts";
import {
  registerProvisioningComputeGatewayCase,
  registerProvisioningDependencyCases,
} from "./postgres-agent-provisioning-dependency-cases.ts";
import { registerProvisioningRefusalCases } from "./postgres-agent-provisioning-refusal-cases.ts";

import {
  registerAdmissionCases,
  registerHandoffAdmissionCases,
} from "./postgres-agent-provisioning-admission-cases.ts";
import { registerCredentialCases } from "./postgres-agent-provisioning-credentials-cases.ts";
import {
  registerDeploymentHandoffCases,
  registerStopAndDeleteCases,
  registerTransportCases,
} from "./postgres-agent-provisioning-handoff-cases.ts";
import {
  registerHarnessRefusalCase,
  registerNativeAdminCases,
} from "./postgres-agent-provisioning-harness-cases.ts";
import {
  registerRepositoryCases,
  registerRepositoryStatusCase,
} from "./postgres-agent-provisioning-repository-cases.ts";
import {
  registerConfigurationAndAccountCases,
  registerNameAndSecretCases,
  registerRetainedPlanCase,
  registerRetryCases,
} from "./postgres-agent-provisioning-retry-cases.ts";
import {
  admitProvisioning,
  claimProvisioningWork,
  createFixture,
  createProvisioningConfigurationDriver,
  createProvisioningSecrets,
  provisioningBody,
  provisioningRow,
  refuseProvisioningWithoutGatewayRouting,
  requestAcceptedProvisioning,
  storedProvisioningCounts,
} from "./postgres-agent-provisioning-setup.ts";
import { registerTransactionCases } from "./postgres-agent-provisioning-transactions-cases.ts";

registerAdmissionCases();
registerRepositoryCases();
registerHandoffAdmissionCases();
registerTransactionCases();
registerCredentialCases();
registerRetryCases();
registerConfigurationResendCases({
  createFixture,
  createProvisioningConfigurationDriver,
  createProvisioningSecrets,
  requestAcceptedProvisioning,
});
registerNameAndSecretCases();
registerProvisioningDependencyCases({
  createFixture,
  createProvisioningSecrets,
  provisioningBody,
  createProvisioningConfigurationDriver,
  storedProvisioningCounts,
  provisioningRow,
  claimProvisioningWork,
});

registerProvisioningRefusalCases({
  createFixture,
  createProvisioningConfigurationDriver,
  admitProvisioning,
  provisioningRow,
  refuseProvisioningWithoutGatewayRouting,
});

registerProvisioningComputeGatewayCase({
  createFixture,
  createProvisioningSecrets,
  provisioningBody,
  createProvisioningConfigurationDriver,
  provisioningRow,
  refuseProvisioningWithoutGatewayRouting,
});
registerHarnessRefusalCase();
registerConfigurationAndAccountCases();
registerStopAndDeleteCases();
registerTransportCases();
registerDeploymentHandoffCases();
registerRepositoryStatusCase();
registerRetainedPlanCase();
registerNativeAdminCases();
registerChannelCurrentnessCases({
  createFixture,
  createProvisioningConfigurationDriver,
  createProvisioningSecrets,
  provisioningBody,
});
