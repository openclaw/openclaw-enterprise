type NativeWorkerPlacementObservationInput = {
  placement?: unknown;
  placementLookup?: string | null | undefined;
  environment?: unknown;
  nodes?: unknown;
  expectedNodeId?: string | undefined;
  sessionId?: string | undefined;
  environmentLookup?: string | null | undefined;
  nodeLookup?: string | null | undefined;
  elapsedMs?: number | undefined;
};

// Project public RPC observations before crossing the controller stdout boundary.
// Keep this function self-contained: the trusted controller executes its source.
export function nativeWorkerPlacementObservation({
  placement,
  placementLookup,
  environment,
  nodes,
  expectedNodeId,
  sessionId,
  environmentLookup,
  nodeLookup,
  elapsedMs,
}: NativeWorkerPlacementObservationInput) {
  const field = (value: unknown, key: PropertyKey): unknown => {
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      const result: unknown = Reflect.get(value, key);
      return result;
    }
    return undefined;
  };
  const category = <const Values extends readonly string[]>(
    value: unknown,
    values: Values,
  ): Values[number] | "absent" | "other" => {
    if (value == null) {
      return "absent";
    }
    return values.find((entry) => entry === value) ?? "other";
  };
  const errorCategory = (value: unknown) => {
    if (value == null) {
      return "absent";
    }
    if (typeof value !== "string") {
      return "other";
    }
    // Upstream provider/bootstrap owners wrap the cause before publishing placement errors.
    // Strip only their fixed prefixes, never arbitrary peer text or identifiers.
    let detail = value.slice(0, 4096);
    const wrappers = [
      ["Worker node bootstrap failed: ", "worker-bootstrap-failed"],
      ["Device worker bundle installation failed: ", "bundle-install-failed"],
      ["worker-bundle-install-failed: ", "bundle-install-failed"],
      ["Worker provider preparation failed: ", "provider-preparation-failed"],
      ["Worker provider operation failed: ", "provider-operation-failed"],
      ["Worker provider rejected profile: ", "provider-profile-rejected"],
    ] as const;
    let fallback: "other" | (typeof wrappers)[number][1] = "other";
    let bundleInstall = false;
    for (let depth = 0; depth < 4; depth += 1) {
      const wrapper = wrappers.find(([prefix]) => detail.startsWith(prefix));
      if (!wrapper) {
        break;
      }
      detail = detail.slice(wrapper[0].length);
      fallback = wrapper[1];
      bundleInstall ||= fallback === "bundle-install-failed";
    }
    if (bundleInstall) {
      const http = /^gateway returned ([0-9]{1,3})(?:\b|$)/.exec(detail);
      if (http) {
        const status = Number(http[1]);
        if ([401, 403, 404].includes(status)) {
          return `bundle-http-${status}`;
        }
        if (status >= 400 && status < 500) {
          return "bundle-http-client-error";
        }
        if (status >= 500 && status < 600) {
          return "bundle-http-server-error";
        }
        return "bundle-http-unexpected-status";
      }
      const errno =
        /^(EACCES|EPERM|EROFS|ENOSPC|ENOENT):/.exec(detail) ??
        /^spawn .+ (EACCES|EPERM|EROFS|ENOSPC|ENOENT)(?:\b|$)/.exec(detail);
      if (errno) {
        return (
          [
            ["EACCES", "bundle-storage-access-denied"],
            ["EPERM", "bundle-operation-denied"],
            ["EROFS", "bundle-storage-readonly"],
            ["ENOSPC", "bundle-storage-full"],
            ["ENOENT", "bundle-file-missing"],
          ] as const
        ).find(([code]) => code === errno[1])?.[1];
      }
      if (detail.startsWith("Command failed:")) {
        return "bundle-prewarm-failed";
      }
    }
    // These phrases come from the pinned OpenClaw worker environment and node tunnel owners.
    const errors = [
      ["Worker tunnel did not connect within 3 minutes", "tunnel-timeout"],
      ["node worker workspace command timed out", "workspace-command-timeout"],
      ["node workspace command failed (", "workspace-command-failed"],
      ["device worker node transport is unavailable", "node-transport-unavailable"],
      ["Device worker node transport is unavailable", "node-transport-unavailable"],
      [
        "Device worker node is not connected with the installer dialect",
        "node-installer-disconnected",
      ],
      [
        "Device worker installation connection is no longer current",
        "node-install-connection-stale",
      ],
      [
        "Device worker bundle installer returned a mismatched build receipt",
        "bundle-receipt-mismatch",
      ],
      ["Device worker bundle installation failed", "bundle-install-failed"],
      ["Device worker node does not support bundle prefetch", "bundle-prefetch-unsupported"],
      [
        "OpenClaw worker deploy artifact is missing; build the running package",
        "worker-deploy-artifact-missing",
      ],
      ["Unsafe worker deploy artifact:", "worker-deploy-artifact-unsafe"],
      ["Cloud bootstrap requires a built Gateway;", "gateway-build-missing"],
      ["Cloud bootstrap is missing its built CLI entry;", "gateway-cli-missing"],
      ["Node bootstrap distribution exceeds its artifact limits", "bootstrap-artifact-too-large"],
      ["Node bootstrap archive exceeds the transfer limit", "bootstrap-transfer-too-large"],
      ["INVALID_REQUEST: invalid node worker bundle install request", "bundle-request-invalid"],
      ["gateway returned an unexpected worker bundle range", "bundle-range-invalid"],
      ["gateway returned an unexpected worker bundle length", "bundle-transfer-length-invalid"],
      [
        "worker bundle download stopped after 3 consecutive no-progress failures",
        "bundle-download-no-progress",
      ],
      ["prepared worker bundle archive has an unexpected length", "bundle-archive-length-invalid"],
      ["worker bundle archive exceeded its byte limit", "bundle-archive-too-large"],
      ["worker bundle transfer response exceeded its byte limit", "bundle-response-too-large"],
      ["worker bundle archive failed integrity validation", "bundle-archive-integrity-failed"],
      ["published worker bundle failed validation", "bundle-published-invalid"],
      ["gateway TLS fingerprint mismatch", "bundle-tls-mismatch"],
      ["Cloudflare Access credentials require HTTPS", "bundle-https-required"],
      ["gateway transfer is unavailable", "bundle-transfer-unavailable"],
      [
        "Worker bundle archive manifest does not match its expected hash",
        "bundle-manifest-hash-mismatch",
      ],
      [
        "Extracted worker bundle does not match its expected hash",
        "bundle-extracted-hash-mismatch",
      ],
      ["Invalid worker bundle archive path:", "bundle-entry-invalid"],
      ["Duplicate worker bundle archive path:", "bundle-entry-invalid"],
      ["Invalid worker bundle archive size:", "bundle-entry-invalid"],
      ["Invalid worker bundle tar entry:", "bundle-entry-invalid"],
      ["Worker bundle contains an unsupported entry:", "bundle-entry-invalid"],
      ["Worker bundle archive exceeds its entry limit", "bundle-extraction-limit"],
      ["Worker bundle archive exceeds its expanded byte limit", "bundle-extraction-limit"],
      ["Worker bundle directory exceeds its limits", "bundle-extraction-limit"],
      ["Worker bundle contains a symbolic link:", "bundle-symlink-refused"],
      ["Worker bundle file changed while hashing:", "bundle-file-changed"],
      [
        "device worker node is not connected with the supervisor dialect",
        "node-supervisor-disconnected",
      ],
      ["node worker workspace is unavailable before sync", "workspace-not-synced"],
      ["Device folder does not belong to this workspace runner", "workspace-device-mismatch"],
      ["Device folder validation failed", "workspace-validation-failed"],
      ["Node workspace sync does not match its bound session", "workspace-session-mismatch"],
      ["Worker tunnel owner credential is not current", "owner-credential-stale"],
      ["node worker tunnel owner epoch is stale", "owner-epoch-stale"],
      ["node worker tunnel owner binding changed within one epoch", "owner-binding-changed"],
      ["node worker tunnel stopped before connecting", "tunnel-stopped"],
    ] as const;
    return errors.find(([phrase]) => detail.startsWith(phrase))?.[1] ?? fallback;
  };
  const present = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;
  const boundedArray = (value: unknown): readonly unknown[] | undefined =>
    Array.isArray(value) && value.length <= 4096 ? value : undefined;
  const count = (value: unknown): number | undefined => boundedArray(value)?.length;
  const validNodes = boundedArray(nodes);
  const matches = validNodes?.filter(
    (node) => present(expectedNodeId) && field(node, "nodeId") === expectedNodeId,
  );
  const exact = matches?.length === 1 ? matches[0] : undefined;
  const bool = (value: unknown): boolean | undefined =>
    typeof value === "boolean" ? value : undefined;
  const attached = field(field(environment, "worker"), "attachedSessionIds");
  const validAttached = boundedArray(attached);
  return {
    placementLookup:
      placementLookup === undefined
        ? undefined
        : category(placementLookup, ["fresh", "fallback", "absent"]),
    placementState: category(field(placement, "state"), [
      "local",
      "requested",
      "provisioning",
      "syncing",
      "starting",
      "active",
      "draining",
      "reconciling",
      "reclaimed",
      "failed",
    ]),
    recoveryError: errorCategory(field(placement, "recoveryError")),
    terminalReason: errorCategory(field(placement, "terminalReason")),
    workspaceReferencePresent: present(field(placement, "remoteWorkspaceDir")),
    environmentLookup: category(environmentLookup, ["absent", "found", "unavailable", "mismatch"]),
    environmentState: category(field(field(environment, "worker"), "state"), [
      "requested",
      "provisioning",
      "bootstrapping",
      "ready",
      "attached",
      "idle",
      "draining",
      "destroying",
      "destroyed",
      "failed",
      "orphaned",
    ]),
    environmentError: errorCategory(field(field(environment, "worker"), "error")),
    tunnelStatus: category(field(field(environment, "worker"), "tunnelStatus"), [
      "stopped",
      "connecting",
      "connected",
      "reconnecting",
    ]),
    attachedSessionCount: count(attached),
    attachedSessionMatches:
      validAttached === undefined
        ? undefined
        : present(sessionId) && validAttached.includes(sessionId),
    nodeLookup: category(nodeLookup, ["found", "unavailable", "invalid"]),
    nodeCount: count(validNodes),
    connectedNodeCount: validNodes?.filter((node) => field(node, "connected") === true).length,
    expectedNodeIdPresent: present(expectedNodeId),
    expectedNodeMatches: matches?.length,
    expectedNodeConnected: bool(field(exact, "connected")),
    expectedNodePaired: bool(field(exact, "paired")),
    expectedNodeSessionHost: bool(field(exact, "sessionHost")),
    expectedNodeCaps: count(field(exact, "caps")),
    expectedNodeCommands: count(field(exact, "commands")),
    expectedNodeWorkerBundle: category(field(field(exact, "workerBundle"), "status"), [
      "installed",
      "missing",
    ]),
    elapsedMs:
      typeof elapsedMs === "number" &&
      Number.isSafeInteger(elapsedMs) &&
      elapsedMs >= 0 &&
      elapsedMs <= 3_600_000
        ? elapsedMs
        : undefined,
  };
}

// Validate before reading placement so a foreign response cannot poison failure evidence.
// Self-contained because the controller receives this function as source.
export function nativeWorkerSessionPlacement<Placement>(
  description:
    { session?: { sessionId?: unknown; placement?: Placement } | null } | null | undefined,
  sessionId: unknown,
): Placement | undefined {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    description?.session?.sessionId !== sessionId
  ) {
    throw new Error("Native worker session identity mismatch");
  }
  return description.session.placement;
}

// The pinned Gateway returns this plain read-generation error through
// UNAVAILABLE + formatForLog. The SDK separately proves response correlation.
export function nativePlacementReadRetryable(error: unknown, correlatedResponse: unknown): boolean {
  if (
    correlatedResponse !== true ||
    !((typeof error === "object" && error !== null) || typeof error === "function")
  ) {
    return false;
  }
  const code: unknown = Reflect.get(error, "code");
  if (code !== "UNAVAILABLE") {
    return false;
  }
  const message: unknown = Reflect.get(error, "message");
  return message === "Error: Session changed while preparing its description; retry the request";
}
