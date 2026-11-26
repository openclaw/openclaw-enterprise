import assert from "node:assert/strict";
import { Check } from "typebox/value";
import type { ControllerApp } from "../../apps/controller/src/index.ts";
import {
  AgentRevisionListResponse,
  type NamespaceWire,
  type OpenClawConfigurationDocument,
  type PresetDraftTemplate,
} from "../../packages/contracts/src/index.ts";
import {
  KUBERNETES_ALLOW_USERS_REFUSAL,
  KUBERNETES_DEVICE_AUTO_APPROVE_REFUSAL,
} from "../helpers/refusal-text.mjs";
import {
  INVALID_ALLOW_USERS_SAMPLE,
  INVALID_DEVICE_AUTO_APPROVE_SAMPLE,
} from "../helpers/trusted-proxy-shapes.ts";

interface HttpResponse {
  status: number;
  body: unknown;
}

interface ConfigurationContext {
  app: ControllerApp;
  namespace: NamespaceWire;
}

interface StoredAgent {
  agentPath: string;
  valid: OpenClawConfigurationDocument;
}

interface TrustedProxyOperations<Context, Agent> {
  request(app: ControllerApp, method: "GET", pathname: string): Promise<HttpResponse>;
  refusedAtSaveAndDeploy(
    context: Context,
    agent: Agent,
    values: OpenClawConfigurationDocument,
    message: string,
  ): Promise<void>;
  savePreset(context: Context, template: PresetDraftTemplate, name?: string): Promise<HttpResponse>;
  assertRefused(response: HttpResponse, message: string): void;
  deployableAgent(
    context: Context,
    namespace: NamespaceWire,
    options: { values: OpenClawConfigurationDocument; name: string; secretName: string },
  ): Promise<Pick<StoredAgent, "agentPath">>;
  deployAccepted(context: Context, agentPath: string): Promise<HttpResponse>;
}

const deferredPresets: readonly (readonly [
  name: string,
  variables: NonNullable<PresetDraftTemplate["variables"]>,
  fields: OpenClawConfigurationDocument,
])[] = [
  [
    "Allowlist-deferred",
    { identity: { type: "string" } },
    { allowUsers: ["{{ vars.identity }}", "oidc:member-01"] },
  ],
  [
    "Auto-approval-deferred",
    { autoApprove: { type: "boolean" } },
    { deviceAutoApprove: { enabled: "{{ vars.autoApprove }}" } },
  ],
];

export async function checkConfigurationGatewayTrustedProxyCases<
  Context extends ConfigurationContext,
  Agent extends StoredAgent,
>(
  context: Context,
  agent: Agent,
  operations: TrustedProxyOperations<Context, Agent>,
): Promise<void> {
  const {
    request,
    refusedAtSaveAndDeploy,
    savePreset,
    assertRefused,
    deployableAgent,
    deployAccepted,
  } = operations;
  const trustedProxy = (fields: OpenClawConfigurationDocument): OpenClawConfigurationDocument => ({
    ...agent.valid,
    gateway: { auth: { trustedProxy: { allowUsers: ["occ-workspace-files"], ...fields } } },
  });

  // Preparation once reached these Gateway refusals after a dedicated deployment stopped its
  // predecessor. Check saves and deployment on the caller's existing row before any revision.
  for (const allowUsers of INVALID_ALLOW_USERS_SAMPLE) {
    await refusedAtSaveAndDeploy(
      context,
      agent,
      trustedProxy({ allowUsers }),
      KUBERNETES_ALLOW_USERS_REFUSAL,
    );
  }
  for (const deviceAutoApprove of INVALID_DEVICE_AUTO_APPROVE_SAMPLE) {
    await refusedAtSaveAndDeploy(
      context,
      agent,
      trustedProxy({ deviceAutoApprove }),
      KUBERNETES_DEVICE_AUTO_APPROVE_REFUSAL,
    );
  }
  const revisions = await request(context.app, "GET", `${agent.agentPath}/revisions`);
  assert.equal(revisions.status, 200, JSON.stringify(revisions.body));
  assert.ok(Check(AgentRevisionListResponse, revisions.body), "expected an Agent revision list");
  assert.deepEqual(revisions.body.data, []);

  // Preset save refuses the same missing machine identity. The launch checks fields that wait
  // on a variable, including the allowlist identity and the boolean that enables auto-approval.
  const [allowUsers] = INVALID_ALLOW_USERS_SAMPLE;
  assertRefused(
    await savePreset(context, { configuration: { values: trustedProxy({ allowUsers }) } }),
    KUBERNETES_ALLOW_USERS_REFUSAL,
  );
  for (const [name, variables, fields] of deferredPresets) {
    const waiting = await savePreset(
      context,
      { variables, configuration: { values: trustedProxy(fields) } },
      name,
    );
    assert.equal(waiting.status, 201, `${name}: ${JSON.stringify(waiting.body)}`);
  }

  // An explicit human with its own grant and a device policy the Gateway accepts can deploy.
  const humanAgent = await deployableAgent(context, context.namespace, {
    values: {
      ...agent.valid,
      gateway: {
        auth: {
          trustedProxy: {
            allowUsers: ["occ-workspace-files", "member@example.com"],
            deviceAutoApprove: { enabled: true, scopes: ["operator.read"] },
          },
          identityScopes: {
            "occ-workspace-files": ["operator.admin"],
            "member@example.com": ["operator.read"],
          },
        },
      },
    },
    name: "Trusted proxy human consumer",
    secretName: "trusted-proxy-human-key",
  });
  await deployAccepted(context, humanAgent.agentPath);
}
