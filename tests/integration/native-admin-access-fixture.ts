import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type nodeTest from "node:test";
import type { TestContext } from "node:test";

import Type from "typebox";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import type { createFastifyApp } from "../../apps/controller/src/index.ts";
import type { OccLogger } from "../../apps/controller/src/logging.ts";
import type { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { Meta } from "../../packages/contracts/src/api/common.ts";
import { AgentResponse } from "../../packages/contracts/src/api/resources.ts";
import type {
  Agent,
  AgentRevision,
  Identity,
  Namespace,
  ServicePrincipal,
} from "../../packages/contracts/src/index.ts";
import type { OpenClawController, PlatformStateStore } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantRole, type ActionsByKind } from "../helpers/iam-grants.ts";
import type { nativeAdminCaseDependencies } from "./native-admin-access.test.mjs";

const cookieDomain = "oce.example.test";
export const nativeDomain = `agents.${cookieDomain}`;
export const publicOrigin = `https://console.${cookieDomain}`;
export const authBaseURL = `https://console.${cookieDomain}`;

export type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
export type Session = Awaited<ReturnType<ConsoleFixture["signIn"]>>;
export type FixtureResponse = { status: number; body: unknown };
type RequestResult = FixtureResponse & { headers: Headers; data: unknown };
type RequestOptions = NonNullable<Parameters<ConsoleFixture["request"]>[2]>;
type CheckedConsoleFixture = Omit<ConsoleFixture, "controller" | "request"> & {
  controller: OpenClawController;
  request: (...args: Parameters<ConsoleFixture["request"]>) => Promise<RequestResult>;
};
export type NativeAdminApp = { app: Pick<ReturnType<typeof createFastifyApp>, "inject"> };
type InjectedResponse = Awaited<ReturnType<NativeAdminApp["app"]["inject"]>>;
export type HttpResponse = Pick<InjectedResponse, "statusCode" | "headers" | "body">;

export type NativeAdminFixture = {
  fixture: CheckedConsoleFixture;
  namespace: Pick<Namespace, "id">;
  agent: Pick<Agent, "id" | "namespaceId">;
  revision: AgentRevision;
  session: Session;
  upstream: {
    cert: string;
    requests: readonly { method: string | undefined; url: string | undefined }[];
    routeProxy: { text: string | undefined };
  };
};

type LiveAgentOptions = {
  nativeDomain?: string;
  publicOrigin?: string;
  configure?: (origin: string) => object;
};
type LiveAgentSetup = {
  nativeOriginForAgent: (
    installationId: string,
    namespaceId: string,
    agentId: string,
    domain: string,
    origin: string,
  ) => string;
  nativeAdminHarnessConfiguration: (origin: string) => object;
};

export function createNativeAdminSetup({
  nativeOriginForAgent,
  nativeAdminHarnessConfiguration,
}: LiveAgentSetup) {
  // An Agent whose active revision serves native administration at its own origin.
  async function createLiveNativeAgent(
    fixture: CheckedConsoleFixture,
    namespace: Pick<Namespace, "id">,
    name: string,
    options: LiveAgentOptions = {},
  ) {
    const agent = await fixture.createAgent(
      namespace.id,
      name,
      createHarnessConfiguration("openclaw", "gpt-4.1"),
    );
    const nativeOrigin = nativeOriginForAgent(
      fixture.controller.installation.id,
      namespace.id,
      agent.id,
      options.nativeDomain ?? nativeDomain,
      options.publicOrigin ?? publicOrigin,
    );
    await fixture.updateConfiguration(
      namespace.id,
      agent.configurationId,
      (options.configure ?? nativeAdminHarnessConfiguration)(nativeOrigin),
    );
    const revision = await fixture.controller.deployAgent(
      adminPrincipal(fixture).id,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedHarness,
    );
    await fixture.activateRevision(namespace.id, agent.id, revision.id, undefined);
    const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
    const { data } = fixture.fixtureResponse(current, 200, AgentResponse, "read live Agent");
    assert.equal(data.desiredRuntimeState, "running");
    return { agent: data, revision };
  }
  async function completeFixture(fixture: CheckedConsoleFixture, options: LiveAgentOptions = {}) {
    await fixture.bootstrap("Native admin access test");
    const namespace = await fixture.createNamespace("Native admin", { ready: true });
    const { agent, revision } = await createLiveNativeAgent(
      fixture,
      namespace,
      "Native admin Agent",
      options,
    );
    const session = await fixture.signIn();
    return { namespace, agent, revision, session };
  }
  return { createLiveNativeAgent, completeFixture };
}

export function adminPrincipal(fixture: Pick<ConsoleFixture, "policy">) {
  const principal = fixture.policy.identities.find((identity) => identity.kind === "principal");
  assert.ok(principal, "fixture IAM policy must contain the signed-in administrator");
  return principal;
}

export function nativeStatus(
  {
    fixture,
    namespace,
    agent,
  }: {
    fixture: Pick<CheckedConsoleFixture, "request">;
    namespace: Pick<Namespace, "id">;
    agent: Pick<Agent, "id">;
  },
  options: RequestOptions = {},
): Promise<RequestResult> {
  return fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
    options,
  );
}

export async function injectJson(
  fixture: NativeAdminApp,
  method: "GET" | "POST",
  url: string,
  { headers = {}, body }: { headers?: Record<string, string | undefined>; body?: unknown } = {},
) {
  const filteredHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      filteredHeaders[name] = value;
    }
  }
  return fixture.app.inject({
    method,
    url,
    headers: {
      ...filteredHeaders,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

export function nativeAuthority(native: { origin: string }) {
  return new URL(native.origin).host;
}

// A second Agent beside the one named by an exact binding.
export function createSiblingAgent({
  fixture,
  namespace,
}: {
  fixture: Pick<ConsoleFixture, "createAgent">;
  namespace: Pick<Namespace, "id">;
}) {
  return fixture.createAgent(
    namespace.id,
    `Native admin sibling ${randomUUID().slice(0, 8)}`,
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
}

type ServiceKeyContext = {
  fixture: Pick<CheckedConsoleFixture, "request" | "fixtureResponse"> & {
    policy: Pick<ConsoleFixture["policy"], "roles" | "bindings"> & { identities: Identity[] };
  };
  namespace: Pick<Namespace, "id">;
  agent: Pick<Agent, "id">;
};

const IssuedKeyResponse = Type.Object({
  meta: Meta,
  data: Type.Object({
    key: Type.String({ pattern: "^occ_" }),
    namespaceId: Type.String(),
    servicePrincipalId: Type.String(),
    id: Type.String(),
    name: Type.String(),
    expiresAt: Type.String({ format: "date-time" }),
  }),
});

export async function issueServiceKeyForNativeAgent(context: ServiceKeyContext) {
  const principal: ServicePrincipal = {
    id: `native-admin-service-${randomUUID()}`,
    kind: "service_principal",
    namespaceId: context.namespace.id,
  };
  context.fixture.policy.identities.push(principal);
  const { role } = grantRole(context.fixture.policy, principal.id, {
    id: `native-admin-service-role-${randomUUID()}`,
    bindingId: `native-admin-service-binding-${randomUUID()}`,
    namespaceId: context.namespace.id,
    permissions: { agent: ["administer"] },
    resource: { kind: "agent", id: context.agent.id },
  });
  const issued = await context.fixture.request("POST", "/api/auth/service-keys", {
    body: {
      servicePrincipalId: principal.id,
      namespaceId: context.namespace.id,
      name: "native-admin-service-key",
    },
  });
  const { data } = context.fixture.fixtureResponse(
    issued,
    201,
    IssuedKeyResponse,
    "issue Agent service key",
  );
  assert.equal(data.servicePrincipalId, principal.id);
  assert.equal(data.namespaceId, context.namespace.id);
  return { key: data.key, role };
}

export type CreateLiveNativeAgent = ReturnType<
  typeof createNativeAdminSetup
>["createLiveNativeAgent"];

export interface NativeAdminCaseDependencies {
  createNativeAdminFixture: (
    t: TestContext,
    options?: {
      state?: PlatformStateStore;
      auditSink?: InMemoryAuditSink;
      logger?: OccLogger;
      recordOperations?: boolean;
      nativeAdminEnabled?: boolean;
      nativeDomain?: string;
      exclusiveReplacement?: boolean | ((revision: AgentRevision) => boolean);
    },
  ) => Promise<NativeAdminFixture>;
  nativeOriginForAgent: (installationId: string, namespaceId: string, agentId: string) => string;
  createReadOnlySession: (context: NativeAdminFixture, label?: string) => Promise<Session>;
  createExactAgentAdministerSession: (
    context: NativeAdminFixture,
    label?: string,
  ) => Promise<Session>;
  createAgentPermissionSession: (
    context: NativeAdminFixture,
    label: string,
    permissions: ActionsByKind,
  ) => Promise<Session>;
  assertSiblingStatusDenied: (
    context: NativeAdminFixture,
    session: Session,
    deniedText: (resource: string) => string,
  ) => Promise<void>;
  trustLocalUpstreamCertificate: (t: TestContext, cert: string) => void;
}

// The function assignment checks the actual callbacks supplied by the JavaScript entry.
export type RegisterNativeAdminCases = (
  test: typeof nodeTest,
  dependencies: typeof nativeAdminCaseDependencies,
) => void;
