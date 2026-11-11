import type {
  CredentialRevisionContext,
  CredentialSource,
  CredentialSourceContext,
  Namespace,
} from "../../packages/contracts/src/index.ts";
import { completeSandboxRevision } from "./sandbox-driver-revision-fixture.ts";

/** Complete records for the Credential Gateway's recording-store scenarios. */
export function createCredentialGatewayContexts(driverId: string) {
  const createdAt = "2026-09-23T00:00:00.000Z";
  const namespace: Namespace = {
    id: "ns_00000000-0000-4000-8000-0000000000aa",
    name: "placed-tenant",
    status: "ready",
    createdAt,
  };
  const signal = new AbortController().signal;
  const source = (id: string, namespaceId = namespace.id): CredentialSource => ({
    id,
    namespaceId,
    name: "openai",
    type: "openai",
    config: {},
    secrets: {},
    ownerCapability: "credential_gateway",
    driverId,
    state: "ready",
    createdAt,
  });
  const context = (id: string): CredentialSourceContext => ({
    namespace,
    source: source(id),
    signal,
  });
  const revisionContext = (sources: readonly CredentialSource[]): CredentialRevisionContext => ({
    namespace,
    revision: completeSandboxRevision({
      id: "rev_00000000-0000-4000-8000-0000000000aa",
      namespaceId: namespace.id,
      agentId: "agt_00000000-0000-4000-8000-0000000000aa",
      sandboxDriverId: "openshell-sandbox",
      harness: {
        id: "codex",
        version: "1.0.0",
        mode: "dedicated",
        overrides: {},
        configuration: {},
      },
    }),
    sources,
    signal,
  });
  return { source, context, revisionContext };
}
