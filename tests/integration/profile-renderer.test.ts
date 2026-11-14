import { registerCliCases } from "./profile-renderer-cli-cases.ts";
import { registerOutputFileCases } from "./profile-renderer-output-files-cases.ts";
import { registerDnsCases } from "./profile-renderer-dns-cases.ts";
import { registerHelmCases } from "./profile-renderer-helm-cases.ts";
import { registerInputMatrixCases } from "./profile-renderer-input-matrix-cases.ts";
import { registerDeploymentCases } from "./profile-renderer-deployment-cases.ts";
import { registerSignInCases } from "./profile-renderer-sign-in-cases.ts";
import { registerEgressCases } from "./profile-renderer-egress-cases.ts";
import { registerComputeCases } from "./profile-renderer-compute-cases.ts";

registerCliCases();
registerOutputFileCases();
registerDnsCases();
registerHelmCases();
registerInputMatrixCases();
registerDeploymentCases();
registerSignInCases();
registerEgressCases();
registerComputeCases();
