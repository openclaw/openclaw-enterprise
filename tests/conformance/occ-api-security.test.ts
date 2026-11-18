import {
  registerResourceAuthorityCases,
  registerExactResourceCases,
  registerNamespaceDeletionCase,
} from "./occ-api-security-resources.ts";
import { registerDevelopmentAdmissionCases } from "./occ-api-security-development-admission.ts";
import {
  registerRestrictionAuditCase,
  registerAuditFailureCase,
  registerMutationAuditCase,
} from "./occ-api-security-audit.ts";
import { registerBootstrapCases } from "./occ-api-security-bootstrap.ts";
import {
  registerBodyValidationCases,
  registerPathValidationCases,
  registerDiagnosticLimitCase,
} from "./occ-api-security-request-validation.ts";
import { registerAuthenticationCases } from "./occ-api-security-authentication.ts";
import { registerRuntimeLogAdmissionCase } from "./occ-api-security-runtime-logs.ts";

registerResourceAuthorityCases();
registerDevelopmentAdmissionCases();
registerRestrictionAuditCase();
registerBootstrapCases();
registerBodyValidationCases();
registerAuthenticationCases();
registerPathValidationCases();
registerExactResourceCases();
registerAuditFailureCase();
registerNamespaceDeletionCase();
registerMutationAuditCase();
registerDiagnosticLimitCase();
registerRuntimeLogAdmissionCase();
