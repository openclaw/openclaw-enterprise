import type { CredentialGatewayDriver, DriverRegistration } from "@openclaw-enterprise/contracts";
import { createDriver as createProtectedDriver } from "./index.ts";

export { calls, configurationSchema, validateConfiguration } from "./index.ts";

/** Add this package's startup-only Credential Gateway view to one of its registrations. */
export function withCredentialGateway(
  registration: DriverRegistration,
  selection: { readonly id: string; readonly implementation: string },
  fixture = "",
): DriverRegistration {
  const outsideStartup = (): never => {
    throw new Error("This fixture exposes only startup and capability identity.");
  };
  const gateway: CredentialGatewayDriver = {
    id: fixture === "/wrong-id" ? "other-driver" : selection.id,
    implementation:
      fixture === "/wrong-implementation" ? "other-implementation" : selection.implementation,
    capability: "credential_gateway",
    listSourceTypes: async () => [],
    validateSourceConfig: outsideStartup,
    registerSource: outsideStartup,
    updateSource: outsideStartup,
    sourceStatus: outsideStartup,
    removeSource: outsideStartup,
    attachForRevision: outsideStartup,
    attachmentStatus: outsideStartup,
    withdraw: outsideStartup,
  };
  if (fixture === "/gateway-only") {
    return {
      ...registration,
      capabilities: {
        sandbox: registration.capabilities.sandbox!,
        credential_gateway: gateway,
      },
    };
  }
  return {
    ...registration,
    capabilities: { ...registration.capabilities, credential_gateway: gateway },
  };
}

export function createDriver(
  selection: Parameters<typeof createProtectedDriver>[0],
): DriverRegistration {
  const registration = createProtectedDriver(selection);
  const fixture = new URL(selection.configuration.endpoint).pathname;
  if (fixture === "/missing-gateway") {
    return registration;
  }
  return withCredentialGateway(registration, selection, fixture);
}
