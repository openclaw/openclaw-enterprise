export type OpenShellSandboxDiagnosticCode =
  | "OPENSHELL_HARNESS_SERVICE_INVALID"
  | "OPENSHELL_POLICY_LOAD_FAILED"
  | "OPENSHELL_POLICY_MODE_MISMATCH"
  | "OPENSHELL_POLICY_READBACK_UNAVAILABLE"
  | "OPENSHELL_POLICY_REFUSED"
  | "OPENSHELL_PUBLIC_EGRESS_EVIDENCE_CONFLICT"
  | "OPENSHELL_PUBLIC_EGRESS_INACTIVE"
  | "OPENSHELL_SANDBOX_IDENTITY_MISMATCH"
  | "OPENSHELL_SANDBOX_OWNERSHIP_MISMATCH"
  | "OPENSHELL_WORKSPACE_INITIALIZATION_FAILED";

export class OpenShellSandboxConfigurationFailure extends Error {
  readonly diagnosticCode: OpenShellSandboxDiagnosticCode | undefined;

  constructor(message: string, diagnosticCode?: OpenShellSandboxDiagnosticCode) {
    super(message);
    this.diagnosticCode = diagnosticCode;
  }
}
