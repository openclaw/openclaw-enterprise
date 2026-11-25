type OpenShellSandboxDiagnosticCode =
  | "OPENSHELL_HARNESS_SERVICE_INVALID"
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
