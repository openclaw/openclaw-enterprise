import assert from "node:assert/strict";
import type {
  AgentRevision,
  HarnessWorkloadRequirements,
} from "../../packages/contracts/src/index.ts";

type Harness = AgentRevision["harness"];

export type SandboxFixtureRevision = Pick<AgentRevision, "id" | "namespaceId" | "agentId"> & {
  sandboxDriverId: string;
  harness: Pick<Harness, "id" | "version" | "mode"> &
    Partial<Pick<Harness, "overrides" | "configuration">>;
};

/** Add admission fields to the identity and Harness supplied by the startup fixtures. */
export function completeSandboxRevision(
  fixture: SandboxFixtureRevision,
  harnessAuth: AgentRevision["harnessAuth"] = { method: "runtime" },
): AgentRevision {
  const idSuffix = fixture.id.slice("rev_".length);
  return {
    ...fixture,
    executionAdmission: { version: 2, mode: "unprotected" },
    revision: 1,
    backendId: null,
    configurationId: `cfg_${idSuffix}`,
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {},
    gatewayManagedMode: false,
    harness: { overrides: {}, configuration: {}, ...fixture.harness },
    compute: { id: "kubernetes", implementation: "kubernetes" },
    harnessAuth,
    servicePrincipalId: `sp_${idSuffix}`,
    createdAt: "2026-09-23T00:00:00.000Z",
  };
}

/** The workspace fixtures attach exactly one source for model authentication. */
export function completeWorkspaceRevision(
  fixture: SandboxFixtureRevision,
  {
    credentialAttachments,
    loginMode,
  }: Pick<HarnessWorkloadRequirements, "credentialAttachments" | "loginMode">,
): AgentRevision {
  assert.equal(credentialAttachments.length, 1);
  const [attachment] = credentialAttachments;
  assert.ok(attachment);
  assert.ok(loginMode === "api_key" || loginMode === "chatgptAuthTokens");
  return completeSandboxRevision(fixture, {
    method: "credential_source",
    sourceId: attachment.sourceId,
    credentialGatewayId: "openshell-credentials",
    sourceType: loginMode === "api_key" ? "openai" : "codex-oauth",
    loginMode,
  });
}
