import type {
  SandboxNetworkGrant,
  ConfigurationResult,
  SandboxPolicy,
  SandboxPolicyMutationWire,
  ProtectedDownloadDestination,
  ProtectedDownloadEdit,
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

type FixturePolicy = Omit<SandboxPolicyMutationWire, "agentId" | "additions"> & {
  agentId: unknown;
  additions: SandboxPolicy["additions"];
};
// Keep the full authored schema; only the host field is replaced by these stories.
type PolicySchema = {
  properties: {
    additions: { items: { properties: { host: Record<string, OpenClawConfigurationValue> } } };
  };
};

// Check the grant fields the Console consumes, not the full admission schema.
// Syntax, limits and delegation failures remain the authored scenario's answers.
function checkNetworkAdditions(
  additions: unknown,
): ConfigurationResult<{ additions: SandboxNetworkGrant[] }> {
  let path = "/additions";
  let missing = false;
  function reject(field: string, required = false): false {
    path = field;
    missing = required;
    return false;
  }
  const valid =
    Array.isArray(additions) &&
    additions.every((grant: unknown, index): grant is SandboxNetworkGrant => {
      const field = `/additions/${index}`;
      if (grant === null || typeof grant !== "object" || Array.isArray(grant)) {
        return reject(field);
      }
      if (!("id" in grant) || typeof grant.id !== "string") {
        return reject(`${field}/id`, !("id" in grant));
      }
      if (!("binary" in grant) || typeof grant.binary !== "string") {
        return reject(`${field}/binary`, !("binary" in grant));
      }
      if (!("host" in grant) || typeof grant.host !== "string") {
        return reject(`${field}/host`, !("host" in grant));
      }
      if (!("ports" in grant)) {
        return reject(`${field}/ports`, true);
      }
      if (!Array.isArray(grant.ports)) {
        return reject(`${field}/ports`);
      }
      return grant.ports.every((port: unknown, portIndex) => {
        const portField = `${field}/ports/${portIndex}`;
        if (port === null || typeof port !== "object" || Array.isArray(port)) {
          return reject(portField);
        }
        if (!("from" in port) || typeof port.from !== "number") {
          return reject(`${portField}/from`, !("from" in port));
        }
        if (!("to" in port) || typeof port.to !== "number") {
          return reject(`${portField}/to`, !("to" in port));
        }
        return true;
      });
    });
  if (valid) {
    return { success: true, data: { additions } };
  }
  return {
    success: false,
    error: {
      details: [
        {
          path,
          code: missing ? "REQUIRED" : "INVALID_TYPE",
          message: missing
            ? "This configuration field is required."
            : "Configuration does not satisfy type.",
        },
      ],
    },
  };
}

function hasNetworkAdditions(body: unknown): body is { additions: SandboxNetworkGrant[] } {
  return (
    body !== null &&
    typeof body === "object" &&
    "additions" in body &&
    checkNetworkAdditions(body.additions).success
  );
}

function isDownloadDestination(value: unknown): value is ProtectedDownloadDestination {
  return (
    value !== null &&
    typeof value === "object" &&
    "host" in value &&
    typeof value.host === "string" &&
    "scheme" in value &&
    "port" in value &&
    ((value.scheme === "https" && value.port === 443) ||
      (value.scheme === "http" && value.port === 80)) &&
    ("path" in value
      ? typeof value.path === "string" && Object.keys(value).length === 4
      : Object.keys(value).length === 3)
  );
}

function isDownloadChange(value: unknown): value is ProtectedDownloadEdit {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 2 &&
    "action" in value &&
    (value.action === "approve-and-enable" ||
      value.action === "enable" ||
      value.action === "disable" ||
      value.action === "withdraw-approval") &&
    "destination" in value &&
    isDownloadDestination(value.destination)
  );
}

function downloadOrigin(destination: ProtectedDownloadDestination) {
  return `${destination.scheme}://${destination.host}:${destination.port}`;
}

function downloadKey(destination: ProtectedDownloadDestination) {
  return downloadOrigin(destination) + (destination.path ?? "");
}

function downloadCovers(
  scope: ProtectedDownloadDestination,
  destination: ProtectedDownloadDestination,
) {
  return (
    downloadOrigin(scope) === downloadOrigin(destination) &&
    (scope.path === undefined || scope.path === destination.path)
  );
}

function withDownload(
  destinations: readonly ProtectedDownloadDestination[],
  destination: ProtectedDownloadDestination,
) {
  if (destinations.some((entry) => downloadKey(entry) === downloadKey(destination))) {
    return destinations;
  }
  return [...destinations, destination].sort((left, right) =>
    downloadKey(left) < downloadKey(right) ? -1 : 1,
  );
}

function editDownloads(
  destinations: readonly ProtectedDownloadDestination[],
  { action, destination }: ProtectedDownloadEdit,
  approvals: readonly ProtectedDownloadDestination[],
) {
  if (action === "disable") {
    return destinations.filter((entry) => downloadKey(entry) !== downloadKey(destination));
  }
  if (action === "withdraw-approval") {
    return destinations.filter(
      (entry) =>
        !downloadCovers(destination, entry) ||
        approvals.some((scope) => downloadCovers(scope, entry)),
    );
  }
  return withDownload(destinations, destination);
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
  const downloadViewer = scenario.policyState === "protectedDownloadViewer";
  const previousDownloadRevision = scenario.policyState === "protectedDownloadPreviousRevision";
  const downloadScenario =
    scenario.policyState === "protectedDownloadCoverage" ||
    downloadViewer ||
    previousDownloadRevision;
  const protectedExecution = scenario.policyState === "protected" || downloadScenario;
  const downloadHost = {
    scheme: "https",
    host: "downloads.example.org",
    port: 443,
  } satisfies ProtectedDownloadDestination;
  const downloadArchive = {
    ...downloadHost,
    path: "/releases/tool.tar.gz",
  } satisfies ProtectedDownloadDestination;
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
  let pendingDownloadTargets: ProtectedDownloadDestination[] | undefined;
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
  if (downloadScenario) {
    const operationId = "00000000-0000-4000-8000-000000000009";
    // Version 7 is active in all three stories. Only the replacement story retains a v6 receipt.
    const receiptRevisionId = previousDownloadRevision
      ? "rev_00000000-0000-4000-8000-000000000006"
      : candidateRevisionId;
    const confirmedAt = previousDownloadRevision
      ? "2026-09-25T12:05:00.000Z"
      : "2026-09-26T22:55:00.000Z";
    sandboxPolicy.approvedDownloadDestinations = [downloadHost, downloadArchive];
    if (scenario.policyState === "protectedDownloadCoverage") {
      sandboxPolicy.approvedDownloadDestinations.push({
        ...downloadHost,
        host: "mirror.example.org",
      });
    }
    sandboxPolicy.downloadDestinations = [downloadHost, downloadArchive];
    sandboxPolicy.application = {
      kind: "protected_downloads",
      id: operationId,
      revisionId: receiptRevisionId,
      policyVersion: 1,
      state: "applied",
      requestedBy: "storybook-operator",
      requestedAt: confirmedAt,
      providerVersion: "4",
      action: "approve-and-enable",
      destination: downloadArchive,
    };
    sandboxPolicy.applied = {
      kind: "protected_downloads",
      operationId,
      revisionId: receiptRevisionId,
      policyVersion: 1,
      providerVersion: "4",
      appliedAt: confirmedAt,
      confirmedDownloadDestinations: [downloadHost, downloadArchive],
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
  function applyDownloadChange(body: unknown) {
    if (
      body === null ||
      typeof body !== "object" ||
      Object.keys(body).length !== 3 ||
      !("expectedVersion" in body) ||
      typeof body.expectedVersion !== "number" ||
      !Number.isInteger(body.expectedVersion) ||
      body.expectedVersion < 1 ||
      body.expectedVersion > 2147483647 ||
      !("revisionId" in body) ||
      typeof body.revisionId !== "string" ||
      !("downloadChange" in body) ||
      !isDownloadChange(body.downloadChange)
    ) {
      return error(
        400,
        "INVALID_REQUEST",
        "Supply the policy version, revision and download change.",
      );
    }
    if (downloadViewer) {
      return error(403, "AUTHORIZATION_DENIED");
    }
    if (
      !policyEditing ||
      body.expectedVersion !== sandboxPolicy.version ||
      body.revisionId !== candidateRevisionId ||
      sandboxPolicy.application?.state === "pending"
    ) {
      return error(409, "RESOURCE_CONFLICT", "The policy changed. Refresh before applying.");
    }
    const { downloadChange } = body;
    const { action, destination } = downloadChange;
    const approved = sandboxPolicy.approvedDownloadDestinations ?? [];
    const desired = sandboxPolicy.downloadDestinations ?? [];
    const receipt = sandboxPolicy.applied;
    const confirmed =
      receipt && "kind" in receipt && receipt.revisionId === body.revisionId
        ? receipt.confirmedDownloadDestinations
        : [];
    // These stories have Agent approvals only. A replaced revision starts with no live downloads.
    if (action === "enable" && !approved.some((scope) => downloadCovers(scope, destination))) {
      return error(
        409,
        "RESOURCE_CONFLICT",
        "This destination is outside the Agent's download delegation.",
      );
    }
    const approvals =
      action === "approve-and-enable"
        ? withDownload(approved, destination)
        : action === "withdraw-approval"
          ? approved.filter((entry) => downloadKey(entry) !== downloadKey(destination))
          : approved;
    if (action === "withdraw-approval" && approvals.length === approved.length) {
      return error(409, "SANDBOX_POLICY_DOWNLOAD_UNCHANGED");
    }
    const nextDesired = editDownloads(desired, downloadChange, approvals);
    const nextConfirmed = editDownloads(confirmed, downloadChange, approvals);
    if (
      approvals.length === approved.length &&
      nextDesired.length === desired.length &&
      nextConfirmed.length === confirmed.length
    ) {
      return error(409, "SANDBOX_POLICY_DOWNLOAD_UNCHANGED");
    }
    const version = sandboxPolicy.version + 1;
    sandboxPolicy = {
      ...sandboxPolicy,
      version,
      approvedDownloadDestinations: [...approvals],
      downloadDestinations: [...nextDesired],
      application: {
        ...downloadChange,
        kind: "protected_downloads",
        id: crypto.randomUUID(),
        revisionId: body.revisionId,
        policyVersion: version,
        state: "pending",
        requestedBy: "storybook-operator",
        requestedAt: new Date(
          Date.parse("2026-09-26T22:55:00.000Z") + version * 60_000,
        ).toISOString(),
      },
    };
    pendingDownloadTargets = [...nextConfirmed];
    policyPolls = 0;
    return response(sandboxPolicy, 202);
  }
  function serve(
    id: string,
    suffix: string,
    method: string,
    body: unknown,
    url: URL,
  ): Response | Promise<Response> | undefined {
    const application = sandboxPolicy.application;
    if (
      suffix === "/sandbox-policy/networking" &&
      method === "GET" &&
      application?.state === "pending" &&
      !scenario.policyKeepPending &&
      ++policyPolls > 1
    ) {
      const providerVersion = "kind" in application ? String(application.policyVersion + 3) : "5";
      application.state = "applied";
      application.providerVersion = providerVersion;
      const confirmation = {
        revisionId: application.revisionId,
        policyVersion: application.policyVersion,
        providerVersion,
        appliedAt:
          "kind" in application
            ? new Date(Date.parse(application.requestedAt) + 1_000).toISOString()
            : createdAt,
      };
      sandboxPolicy.applied =
        "kind" in application && pendingDownloadTargets
          ? {
              ...confirmation,
              kind: "protected_downloads",
              operationId: application.id,
              confirmedDownloadDestinations: pendingDownloadTargets,
            }
          : confirmation;
      pendingDownloadTargets = undefined;
    }
    const policyPath = `/namespaces/${namespaceId}/agents/${id}/sandbox-policy/networking`;
    const configurationSchema: PolicySchema = networkPolicySchema;
    const canSave =
      policyEditing && !downloadViewer && (!downloadScenario || application?.state !== "pending");
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
        validate: { method: "POST", href: `${policyPath}/validate`, available: canSave },
        save: { method: "PUT", href: policyPath, available: canSave },
        apply: {
          method: "POST",
          href: `${policyPath}/apply`,
          available: canSave && (!downloadScenario || suffix === "/sandbox-policy/networking"),
        },
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
      if (downloadViewer) {
        return error(403, "AUTHORIZATION_DENIED");
      }
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
      // SandboxPolicyValidateBody validates the envelope, but additions is Type.Unknown.
      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !Object.hasOwn(body, "expectedVersion") ||
        !Object.hasOwn(body, "additions") ||
        !("expectedVersion" in body) ||
        !("additions" in body) ||
        typeof body.expectedVersion !== "number" ||
        !Number.isInteger(body.expectedVersion) ||
        body.expectedVersion < 1 ||
        body.expectedVersion > 2147483647
      ) {
        return error(
          400,
          "INVALID_REQUEST",
          "The preview requires an integer policy version and additions, with no extra fields.",
        );
      }
      return response(checkNetworkAdditions(body.additions));
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
      const result = response({
        policy: {
          approvedDownloadDestinations: [],
          downloadDestinations: [],
          ...sandboxPolicy,
        },
        configuration: policyDescriptor,
        editingEnabled: policyEditing,
        protectedExecution,
        ...(downloadScenario && {
          protectedDownloads: {
            state: "verified",
            revisionId: candidateRevisionId,
            canApprove: canSave,
          },
        }),
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
        ...(scenario.policyState === "unsupported" || protectedExecution
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
      if (scenario.policyAdminDenied || downloadViewer) {
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
      if (scenario.policyState === "editDenied" || downloadViewer) {
        return error(403, "AUTHORIZATION_DENIED");
      }
      if (!hasNetworkAdditions(body)) {
        return error(
          400,
          "INVALID_REQUEST",
          "The preview requires network additions with string identities and numeric port ranges.",
        );
      }
      if (protectedExecution && body.additions.length > 0) {
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
      if (downloadScenario) {
        if (body !== null && typeof body === "object" && "downloadChange" in body) {
          return applyDownloadChange(body);
        }
        return downloadViewer
          ? error(403, "AUTHORIZATION_DENIED")
          : error(409, "SANDBOX_POLICY_PROTECTED_EXECUTION");
      }
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
      if (
        !("expectedVersion" in body) ||
        body.expectedVersion !== sandboxPolicy.version ||
        body.revisionId !== candidateRevisionId ||
        sandboxPolicy.application?.state === "pending"
      ) {
        return error(409, "RESOURCE_STATE_CONFLICT");
      }
      if ("additions" in body) {
        if (!hasNetworkAdditions(body)) {
          return error(400, "INVALID_REQUEST", "The reviewed network additions are invalid.");
        }
        sandboxPolicy.version += 1;
        sandboxPolicy.additions = body.additions;
      }
      sandboxPolicy.application = {
        id: crypto.randomUUID(),
        revisionId: body.revisionId,
        policyVersion: sandboxPolicy.version,
        state: "pending",
        requestedBy: "identity_demo",
        requestedAt: createdAt,
      };
      policyPolls = 0;
      return response(
        scenario.policyState === "unconfirmedSave"
          ? { ...sandboxPolicy, additions: [] }
          : sandboxPolicy,
        202,
      );
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
