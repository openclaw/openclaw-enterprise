import type {
  NetworkSimulationPolicy,
  PluginSimulationPolicy,
  PolicySimulationPolicy,
  PolicySimulationRequest,
  PolicySimulationResult,
  PolicySimulationDecision,
} from "@openclaw-enterprise/contracts";

type Trace = PolicySimulationResult["rules"][number];

/** OCE selector semantics: * stays within a segment; ** crosses segments. */
function selector(pattern: string, value: string, delimiter: string): boolean | undefined {
  if (["?", "[", "]", "{", "}", "\\"].some((character) => pattern.includes(character))) {
    return undefined;
  }
  let expression = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        expression += ".*";
        i++;
      } else {
        expression += delimiter === "." ? "[^.]*" : "[^/]*";
      }
    } else {
      expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`, "u").test(value);
}

function network(
  policy: NetworkSimulationPolicy,
  action: Extract<PolicySimulationRequest, { kind: "network" }>,
): PolicySimulationResult {
  const rules: Trace[] = [];
  const endpoints: NetworkSimulationPolicy["rules"][number]["destinations"][number][] = [];
  let uncertain = false;
  for (const rule of policy.rules) {
    const binaryMatches = rule.binaries
      .map((path) =>
        [action.binaryPath, ...(action.ancestors ?? [])].map((value) => selector(path, value, "/")),
      )
      .flat();
    const binary = binaryMatches.includes(true);
    const candidates = rule.destinations
      .filter((endpoint) => endpoint.ports.includes(action.port))
      .map((endpoint) => ({
        endpoint,
        host: selector(endpoint.host.toLowerCase(), action.host.toLowerCase(), "."),
      }));
    const matched = binary && candidates.some(({ host }) => host === true);
    const unsupported =
      rule.unsupportedReason ??
      (candidates.some(({ host, endpoint }) => host !== false && endpoint.unsupportedReason)
        ? "An endpoint has unsupported conditions."
        : undefined);
    const unknown =
      Boolean(unsupported) ||
      (candidates.some(({ host }) => host !== false) &&
        !binary &&
        binaryMatches.includes(undefined)) ||
      (binary && candidates.some(({ host }) => host === undefined));
    uncertain ||= unknown;
    rules.push({
      id: rule.id,
      name: rule.name,
      matched: matched && !unknown,
      decision: unknown ? "unknown" : matched ? "allow" : "deny",
      reason:
        unsupported ??
        (unknown
          ? "Unsupported selector syntax."
          : matched
            ? "Destination and supplied process identity match."
            : !binary
              ? "Executable and ancestor paths do not match."
              : "Destination does not match."),
    });
    if (matched && !unknown) {
      endpoints.push(
        ...candidates.filter(({ host }) => host === true).map(({ endpoint }) => endpoint),
      );
    }
  }
  if (endpoints.length === 0) {
    const decision = uncertain ? "unknown" : "deny";
    rules.push({
      id: "builtin:default-deny",
      name: "Default deny",
      matched: !uncertain,
      decision,
      reason: uncertain
        ? "An unsupported rule could affect the result."
        : "No authored network rule grants this action.",
    });
    return {
      decision,
      reason: uncertain
        ? "OCE cannot determine this action from the supported policy conditions."
        : "No authored network rule allows this action.",
      rules,
      unevaluatedChecks: policy.unevaluatedChecks,
    };
  }
  rules.push({
    id: "builtin:default-deny",
    name: "Default deny",
    matched: false,
    decision: "allow",
    reason: "An authored network rule grants this action.",
  });
  if (action.http) {
    if (
      /[\s%?#\\]/u.test(action.http.path) ||
      [...action.http.path].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      /\/(?:\.|\.\.)(?:\/|$)/u.test(action.http.path)
    ) {
      return {
        decision: "unknown",
        reason:
          "This HTTP path requires native canonicalization outside the OCE method-preset simulation.",
        rules,
        unevaluatedChecks: [...policy.unevaluatedChecks, "HTTP path canonicalization"],
      };
    }
    if (uncertain || endpoints.some((endpoint) => endpoint.http === undefined)) {
      return {
        decision: "unknown",
        reason: "Network selectors match; HTTP enforcement is outside this simulation's coverage.",
        rules,
        unevaluatedChecks: [...policy.unevaluatedChecks, "HTTP application policy"],
      };
    }
    // The portable policy describes each endpoint, not which overlapping endpoint a provider
    // selects. Report a decision only if every matching endpoint would give the same answer.
    const method = action.http.method;
    const decisions = new Set<PolicySimulationDecision>(
      endpoints.map(({ http }) => {
        const { methods, enforcement } = http!;
        return methods.includes("*") || methods.includes(method)
          ? "allow"
          : enforcement === "enforce"
            ? "deny"
            : "audit";
      }),
    );
    const [first] = decisions;
    const decision = decisions.size === 1 && first ? first : "unknown";
    const reason =
      decision === "unknown"
        ? "Overlapping HTTP access presets disagree. OCE cannot tell which one the provider will use."
        : decision === "allow"
          ? "The HTTP method is allowed by the authored access preset."
          : decision === "audit"
            ? "The HTTP method is outside the access preset; the policy audits it."
            : "The HTTP method is outside the authored access preset.";
    rules.push({
      id: "http:access-preset",
      name: "HTTP access preset",
      matched: true,
      decision,
      reason,
    });
    return { decision, reason, rules, unevaluatedChecks: policy.unevaluatedChecks };
  }
  return {
    decision: "allow",
    reason: "An authored network rule grants the supplied destination and process identity.",
    rules,
    unevaluatedChecks: [
      ...policy.unevaluatedChecks,
      ...(endpoints.some((endpoint) => endpoint.http !== undefined)
        ? ["HTTP application policy (no HTTP action supplied)"]
        : []),
    ],
  };
}

function plugin(
  policy: PluginSimulationPolicy,
  action: Extract<PolicySimulationRequest, { kind: "plugin" }>,
): PolicySimulationResult {
  const rules: Trace[] = [];
  const finish = (decision: PolicySimulationDecision, reason: string): PolicySimulationResult => ({
    decision,
    reason,
    rules,
    unevaluatedChecks: policy.unevaluatedChecks,
  });
  const selection = Object.hasOwn(policy.plugins, action.pluginId)
    ? policy.plugins[action.pluginId]
    : undefined;
  const enabled = selection?.enabled === true;
  rules.push({
    id: `plugin:${action.pluginId}`,
    name: "Plugin enabled",
    matched: true,
    decision: enabled ? "allow" : "deny",
    reason: enabled
      ? "The revision enables this plugin."
      : "The revision does not enable this plugin.",
  });
  if (!selection || !enabled) {
    return finish("deny", "The plugin is disabled or absent from this revision.");
  }
  const ids = policy.toolIds[action.pluginId];
  if (!ids || !ids.includes(action.toolId)) {
    return finish("unknown", "The Driver has no verified ownership inventory for this tool.");
  }
  const tool =
    selection.tools && Object.hasOwn(selection.tools, action.toolId)
      ? selection.tools[action.toolId]
      : undefined;
  const toolEnabled = tool?.enabled ?? selection.toolDefaults?.enabled ?? true;
  rules.push({
    id: `tool:${action.toolId}`,
    name: "Tool enabled",
    matched: true,
    decision: toolEnabled ? "allow" : "deny",
    reason:
      tool?.enabled !== undefined
        ? "Explicit tool enablement takes precedence over the plugin tool default."
        : "The tool inherits the plugin default.",
  });
  if (!toolEnabled) {
    return finish("deny", "The authored policy disables this tool.");
  }
  if (Object.keys(selection.driverPolicy ?? {}).length) {
    return finish(
      "unknown",
      "Driver-specific policy conditions are outside OCE's common simulation semantics.",
    );
  }
  const approval = tool?.approval ?? selection.toolDefaults?.approval ?? "provider_default";
  const capability =
    tool?.approval !== undefined ? policy.capabilities.tools : policy.capabilities.toolDefaults;
  const reviewer = tool?.reviewer ?? selection.toolDefaults?.reviewer;
  if (
    !capability.approval.includes(approval) ||
    (reviewer !== undefined &&
      !(
        tool?.reviewer !== undefined ? policy.capabilities.tools : policy.capabilities.toolDefaults
      ).reviewer.includes(reviewer))
  ) {
    return finish(
      "unknown",
      "The Driver does not advertise support for this approval or reviewer policy.",
    );
  }
  let decision: PolicySimulationDecision;
  let reason: string;
  if (approval === "provider_default") {
    decision = "unknown";
    reason = "Approval is inherited from the native runtime.";
  } else if (approval === "none") {
    decision = "allow";
    reason = "The authored policy does not require approval.";
  } else if (approval === "all_actions") {
    decision = "approval_required";
    reason = "The authored policy requires approval for every action.";
  } else if (action.destructive === true || action.readOnly === false) {
    decision = "approval_required";
    reason = "The supplied action metadata identifies a write or destructive action.";
  } else if (action.readOnly === true && action.destructive === false) {
    decision = "allow";
    reason = "The supplied metadata identifies a non-destructive read.";
  } else {
    decision = "unknown";
    reason = "Write-action approval requires known read-only and destructive annotations.";
  }
  rules.push({
    id: `approval:${action.toolId}`,
    name: "Approval policy",
    matched: true,
    decision,
    reason,
  });
  return finish(decision, reason);
}

/** Pure intended-policy prediction. Native state and enforcement evidence are separate. */
export function simulatePolicy(
  policy: PolicySimulationPolicy,
  action: PolicySimulationRequest,
): PolicySimulationResult {
  if (policy.kind === "network" && action.kind === "network") {
    return network(policy, action);
  }
  if (policy.kind === "plugin" && action.kind === "plugin") {
    return plugin(policy, action);
  }
  throw new Error("The action does not match the simulation policy kind.");
}
