import type {
  SandboxNetworkGrant,
  SandboxPolicy,
  SandboxPolicyApplication,
  OpenClawConfigurationValue,
  SandboxPolicyRecommendation,
} from "@openclaw-enterprise/contracts";
import networkPolicySchema from "./network-policy-schema.mts";
import { fixtureError as error, fixtureResponse as response } from "./preview-rules.mts";

type NetworkPolicyScenario = {
  policyState?: string;
  policyRuleCount?: number;
  policyDenialCount?: number;
  policyNewDenials?: number;
  policyWithheld?: number;
  policyCeiling?: readonly SandboxNetworkGrant[];
  policySuggestions?: readonly SandboxPolicyRecommendation[];
  policyInitialOutcome?: string;
  policyKeepPending?: boolean;
  policyNoSandboxDriver?: boolean;
  policyAdminDenied?: boolean;
};

type FixturePolicy = {
  id: string;
  namespaceId: string;
  agentId: unknown;
  version: number;
  additions: SandboxPolicy["additions"];
  applied?: {
    -readonly [K in keyof NonNullable<SandboxPolicy["applied"]>]: NonNullable<
      SandboxPolicy["applied"]
    >[K];
  };
  application?: {
    id: string;
    revisionId: SandboxPolicyApplication["revisionId"];
    policyVersion: number;
    state: SandboxPolicyApplication["state"];
    requestedBy: string;
    requestedAt: string;
    reason?: string;
    providerVersion?: string;
  };
};
// Keep the full authored schema; only the host field is replaced by these stories.
type PolicySchema = {
  properties: {
    additions: { items: { properties: { host: Record<string, OpenClawConfigurationValue> } } };
  };
};

// Check the grant fields the Console consumes, not the full admission schema.
// Syntax, limits and delegation failures remain the authored scenario's answers.
function hasNetworkAdditions(body: unknown): body is { additions: SandboxNetworkGrant[] } {
  if (
    body === null ||
    typeof body !== "object" ||
    !("additions" in body) ||
    !Array.isArray(body.additions)
  ) {
    return false;
  }
  return body.additions.every(
    (grant: unknown) =>
      grant !== null &&
      typeof grant === "object" &&
      "id" in grant &&
      typeof grant.id === "string" &&
      "binary" in grant &&
      typeof grant.binary === "string" &&
      "host" in grant &&
      typeof grant.host === "string" &&
      "ports" in grant &&
      Array.isArray(grant.ports) &&
      grant.ports.every(
        (port: unknown) =>
          port !== null &&
          typeof port === "object" &&
          "from" in port &&
          typeof port.from === "number" &&
          "to" in port &&
          typeof port.to === "number",
      ),
  );
}
export function createNetworkPolicyFixture(
  scenario: NetworkPolicyScenario,
  {
    namespaceId,
    createdAt,
    candidateRevisionId,
    seedAgent,
  }: {
    namespaceId: string;
    createdAt: string;
    candidateRevisionId: string;
    seedAgent: () => { id: unknown };
  },
) {
  const policyGrant = {
    id: scenario.policyState === "unicode" ? "unicode-tool" : "python-web",
    binary:
      scenario.policyState === "unicode"
        ? "/" + Array(6).fill("\u{10400}".repeat(45)).join("/") + "/tool"
        : "/usr/bin/python3.11",
    host: "example.org",
    ports: [{ from: 443, to: 443 }],
  };
  let policyEditing = scenario.policyState !== "disabled";
  let policyPolls = 0;
  let policyReads = 0;
  const initialAdditions =
    scenario.policyState === "protected"
      ? [policyGrant]
      : Array.from({ length: scenario.policyRuleCount ?? 0 }, (_, index) => ({
          ...structuredClone(policyGrant),
          id: `explicit-${index + 1}`,
          host: `allowed-${index + 1}.example.org`,
        }));
  let sandboxPolicy: FixturePolicy = {
    id: "sbp_00000000-0000-4000-8000-000000000001",
    namespaceId,
    agentId: seedAgent().id,
    version: 1,
    additions: initialAdditions,
  };
  if (scenario.policyRuleCount) {
    sandboxPolicy.applied = {
      revisionId: candidateRevisionId,
      policyVersion: 1,
      providerVersion: "4",
      appliedAt: createdAt,
    };
  }
  const policyCeiling = scenario.policyCeiling ?? [
    policyGrant,
    ...(scenario.policyDenialCount
      ? [{ ...policyGrant, id: "observed-services-ceiling", host: "*.example.org" }]
      : []),
    ...initialAdditions,
    ...(scenario.policySuggestions ?? []).map((entry) => entry.grant),
  ];
  if (scenario.policyInitialOutcome) {
    sandboxPolicy.version = 2;
    if (scenario.policyInitialOutcome !== "saved") {
      if (
        scenario.policyInitialOutcome !== "pending" &&
        scenario.policyInitialOutcome !== "applied" &&
        scenario.policyInitialOutcome !== "failed"
      ) {
        throw new TypeError("Invalid preview policy application state");
      }
      sandboxPolicy.application = {
        id: "00000000-0000-4000-8000-000000000009",
        revisionId: candidateRevisionId,
        policyVersion: 2,
        state: scenario.policyInitialOutcome,
        requestedBy: "identity_demo",
        requestedAt: createdAt,
      };
    }
    if (scenario.policyInitialOutcome === "applied") {
      if (!sandboxPolicy.applied) {
        throw new TypeError("Missing preview applied policy");
      }
      sandboxPolicy.applied.policyVersion = 2;
    }
  }
  let policyNewRead = false;
  if (scenario.policyState === "failed" || scenario.policyState === "failedCeiling") {
    sandboxPolicy.application = {
      id: "00000000-0000-4000-8000-000000000009",
      revisionId: candidateRevisionId,
      policyVersion: 1,
      state: "failed",
      requestedBy: "identity_demo",
      requestedAt: createdAt,
      reason:
        scenario.policyState === "failed"
          ? "SANDBOX_POLICY_UNCONFIRMED"
          : "SANDBOX_POLICY_CEILING_CHANGED",
    };
  }
  function serve(
    id: string,
    suffix: string,
    method: string,
    body: unknown,
    url: URL,
  ): Response | Promise<Response> | undefined {
    const policyPath = `/namespaces/${namespaceId}/agents/${id}/sandbox-policy/networking`;
    const configurationSchema: PolicySchema = networkPolicySchema;
    const policyDescriptor = {
      capability: "sandbox",
      driverId: "sandbox-story",
      implementation: "storybook-driver",
      scope: "agent",
      key: "sandbox-network-policy",
      binding: "sandbox-policy",
      configurationSchema,
      actions: {
        read: { method: "GET", href: policyPath, available: true },
        validate: { method: "POST", href: `${policyPath}/validate`, available: policyEditing },
        save: { method: "PUT", href: policyPath, available: policyEditing },
        apply: { method: "POST", href: `${policyPath}/apply`, available: policyEditing },
      },
    };
    if (scenario.policyState === "alternate") {
      policyDescriptor.implementation = "another-sandbox-driver";
      policyDescriptor.configurationSchema = structuredClone(networkPolicySchema);
      policyDescriptor.configurationSchema.properties.additions.items.properties.host.enum = [
        "example.org",
        "service.example.org",
      ];
    }
    if (scenario.policyState === "json") {
      policyDescriptor.configurationSchema = structuredClone(networkPolicySchema);
      policyDescriptor.configurationSchema.properties.additions.items.properties.host = {
        title: "Destination hostname",
        anyOf: [{ const: "example.org" }, { const: "service.example.org" }],
      };
    }
    if (suffix === "/driver-configurations" && method === "GET") {
      return response({
        configurations:
          !scenario.policyState || ["unsupported", "ownerDenied"].includes(scenario.policyState)
            ? []
            : [policyDescriptor],
      });
    }
    if (suffix === "/sandbox-policy/networking/validate" && method === "POST") {
      if (scenario.policyState === "editDenied") {
        return error(403, "FORBIDDEN");
      }
      if (scenario.policyState === "conflict") {
        return error(409, "RESOURCE_CONFLICT", "The policy changed. Reload before editing.");
      }
      if (["ceilingDenied", "invalid"].includes(scenario.policyState ?? "")) {
        return response({
          success: false,
          error: {
            details: [
              {
                path: "/additions/0/host",
                code: "OUTSIDE_CEILING",
                message: "The grant exceeds the Installation delegation ceiling.",
              },
            ],
          },
        });
      }
      if (scenario.policyState === "incompletePreview") {
        return response({ success: true, data: {} });
      }
      if (!hasNetworkAdditions(body)) {
        return error(
          400,
          "INVALID_REQUEST",
          "The preview requires network additions with string identities and numeric port ranges.",
        );
      }
      return response({ success: true, data: { additions: body.additions } });
    }
    if (scenario.policyState && suffix === "/sandbox-policy/networking" && method === "GET") {
      if (scenario.policyState === "ownerDenied") {
        return error(403, "FORBIDDEN");
      }
      const read = ++policyReads;
      if (scenario.policyState === "refreshRace" && !sandboxPolicy.application && read <= 3) {
        // Simulate another operator saving between reads; HTTP workflow coverage uses real saves.
        sandboxPolicy.version = read;
      }
      if (
        sandboxPolicy.application?.state === "pending" &&
        !scenario.policyKeepPending &&
        ++policyPolls > 1
      ) {
        sandboxPolicy.application.state = "applied";
        sandboxPolicy.application.providerVersion = "5";
        sandboxPolicy.applied = {
          revisionId: candidateRevisionId,
          policyVersion: sandboxPolicy.version,
          providerVersion: "5",
          appliedAt: createdAt,
        };
      }
      const result = response({
        policy: sandboxPolicy,
        configuration: policyDescriptor,
        editingEnabled: policyEditing,
        protectedExecution: scenario.policyState === "protected",
        ceiling: policyCeiling,
        defaults:
          scenario.policyState === "unsupported"
            ? null
            : {
                networkPolicies: [
                  {
                    name: "python-default",
                    binaries: [{ path: policyGrant.binary }],
                    endpoints: [{ host: "example.com", ports: [443], tls: "skip" }],
                  },
                ],
              },
        // The candidate version was deployed with policy v1; later saves need an application
        // (D773).
        ...(scenario.policyState === "unsupported" || scenario.policyState === "protected"
          ? {}
          : { defaultsRevisionId: candidateRevisionId, deployedPolicyVersion: 1 }),
        capability:
          scenario.policyState === "unsupported"
            ? null
            : { live: true, wildcards: true, portRanges: true },
        // The API names why per-Agent network policy is unavailable (D774).
        ...(scenario.policyState === "unsupported"
          ? {
              unavailableReason: scenario.policyNoSandboxDriver
                ? "This Installation selects no Sandbox Driver, so Agents run without a Sandbox: there are no policy denials, suggestions or Agent network rules."
                : "The selected Sandbox Driver does not support per-Agent network policy.",
            }
          : {}),
      });
      if (scenario.policyState === "refreshRace" && (read === 2 || read === 3)) {
        return new Promise<Response>((resolve) =>
          setTimeout(() => resolve(result), read === 2 ? 300 : 1500),
        );
      }
      return result;
    }
    if (
      scenario.policyState &&
      suffix === "/sandbox-policy/networking/editing" &&
      method === "PATCH"
    ) {
      if (scenario.policyAdminDenied) {
        return error(403, "AUTHORIZATION_DENIED");
      }
      if (
        body === null ||
        typeof body !== "object" ||
        !("enabled" in body) ||
        typeof body.enabled !== "boolean"
      ) {
        return error(400, "INVALID_REQUEST", "The preview requires a boolean policy editing flag.");
      }
      policyEditing = body.enabled;
      return response({ ...seedAgent(), sandboxPolicyEditing: policyEditing });
    }
    if (scenario.policyState && suffix === "/sandbox-policy/networking" && method === "PUT") {
      if (scenario.policyState === "ceilingDenied") {
        return error(
          409,
          "RESOURCE_CONFLICT",
          "The requested network grant exceeds the Installation delegation ceiling.",
        );
      }
      if (scenario.policyState === "editDenied") {
        return error(403, "AUTHORIZATION_DENIED");
      }
      if (!hasNetworkAdditions(body)) {
        return error(
          400,
          "INVALID_REQUEST",
          "The preview requires network additions with string identities and numeric port ranges.",
        );
      }
      if (scenario.policyState === "protected" && body.additions.length > 0) {
        return error(
          409,
          "SANDBOX_POLICY_PROTECTED_EXECUTION",
          "Protected execution applies to this Agent: the Credential Proxy routes alone govern its egress, so network policy additions are refused; only an empty policy can be saved.",
        );
      }
      if (!("expectedVersion" in body) || body.expectedVersion !== sandboxPolicy.version) {
        return error(409, "RESOURCE_STATE_CONFLICT");
      }
      sandboxPolicy = {
        ...sandboxPolicy,
        version: sandboxPolicy.version + 1,
        additions: body.additions,
      };
      delete sandboxPolicy.application;
      return response(
        scenario.policyState === "unconfirmedSave"
          ? { ...sandboxPolicy, additions: [] }
          : sandboxPolicy,
      );
    }
    if (
      scenario.policyState &&
      suffix === "/sandbox-policy/networking/apply" &&
      method === "POST"
    ) {
      if (scenario.policyState === "applyRejected") {
        return error(
          409,
          "RESOURCE_CONFLICT",
          "The Agent, revision, editing setting, or policy changed. Reload before applying.",
        );
      }
      if (
        body === null ||
        typeof body !== "object" ||
        !("revisionId" in body) ||
        typeof body.revisionId !== "string"
      ) {
        return error(
          400,
          "INVALID_REQUEST",
          "The preview requires a string policy application revision ID.",
        );
      }
      sandboxPolicy.application = {
        id: "00000000-0000-4000-8000-000000000009",
        revisionId: body.revisionId,
        policyVersion: sandboxPolicy.version,
        state: "pending",
        requestedBy: "identity_demo",
        requestedAt: createdAt,
      };
      policyPolls = 0;
      return response(sandboxPolicy, 202);
    }
    if (scenario.policyState && suffix.endsWith("/sandbox-policy/networking/recommendations")) {
      if (scenario.policyState === "ownerDenied") {
        return error(403, "FORBIDDEN");
      }
      if (scenario.policyState === "suggestionsUnavailable") {
        return error(503, "DEPENDENCY_UNAVAILABLE");
      }
      return response({
        recommendations:
          scenario.policySuggestions ??
          (scenario.policyState === "empty"
            ? []
            : [
                {
                  id: "00000000-0000-4000-8000-000000000011",
                  status: "pending",
                  grant:
                    scenario.policyState === "ceilingDenied"
                      ? { ...policyGrant, host: "outside.example.org" }
                      : policyGrant,
                  observations: 4,
                },
              ]),
        truncated: false,
      });
    }
    if (scenario.policyState && suffix.endsWith("/runtime/logs")) {
      const stream = { source: "sandbox", sandbox: "os-demo" };
      const log = {
        type: "line",
        time: createdAt,
        level: "warn",
        kind: "sandbox",
        contentClass: "activity",
        stream,
        message: "NET:OPEN DENIED python3.11 → example.org:443",
        fields: { action: "DENIED", rule_name: "default" },
        decision:
          scenario.policyState === "missingMetadata"
            ? undefined
            : {
                decision: "denied",
                enforcement: "blocked",
                binary: policyGrant.binary,
                host: policyGrant.host,
                port: 443,
                rule: "default",
                engine: "OPA",
                reason: "Destination is not in the network policy",
              },
      };
      if (url.searchParams.has("cursor") && scenario.policyNewDenials && !policyNewRead) {
        policyNewRead = true;
        return response({
          revisionId: candidateRevisionId,
          source: "sandbox",
          stream,
          observedAt: createdAt,
          records: Array.from({ length: scenario.policyNewDenials }, (_, index) => ({
            ...log,
            time: new Date(Date.parse(createdAt) + (index + 1) * 1000).toISOString(),
          })),
          cursor: "simulated-policy-new-cursor",
          withheld: 0,
          truncated: false,
        });
      }
      return response({
        revisionId: candidateRevisionId,
        source: "sandbox",
        stream,
        observedAt: createdAt,
        records:
          scenario.policyState === "empty" || url.searchParams.has("cursor")
            ? []
            : [
                ...(scenario.policyState === "gap"
                  ? [
                      {
                        type: "gap",
                        time: createdAt,
                        stream,
                        reason: "buffer_lost",
                        remedy: "Earlier records are unavailable. Start a fresh window.",
                      },
                    ]
                  : []),
                ...Array.from({ length: scenario.policyDenialCount ?? 1 }, (_, index) => ({
                  ...log,
                  time: new Date(
                    Date.parse(createdAt) - ((scenario.policyDenialCount ?? 1) - index - 1) * 17000,
                  ).toISOString(),
                  ...(scenario.policyDenialCount
                    ? {
                        decision: {
                          ...log.decision,
                          host: `service-${Math.floor(index / 2) + 1}.example.org`,
                        },
                      }
                    : {}),
                })),
              ],
        cursor: "simulated-policy-cursor",
        withheld: scenario.policyWithheld ?? 0,
        truncated: false,
      });
    }
    return undefined;
  }
  return { serve };
}
