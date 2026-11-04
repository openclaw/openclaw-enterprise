// This function is also serialized into a trusted runtime reader. Keep it
// self-contained and return only the fixed diagnostic schema below.
// TODO: Remove this investigation diagnostic when runtime-owned policy signals
// provide the same real-turn evidence. It is not an authorization receipt.
export function parseNativeRolloutProvenance(input) {
  const result = {
    evidenceKind: "diagnostic-only",
    status: "unavailable",
    reason: "invalid-input",
    exactThreadMatched: false,
    exactTurnContextMatched: false,
    cwdMatchesExpectedWorkspace: "unknown",
    approvalPolicy: "unknown",
    sandboxPolicy: "unknown",
    permissionProfileType: "unknown",
    activeProfileKind: "unknown",
    profileIdMatchesExpected: "unknown",
    requestedEscalation: "unknown",
  };
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const controlCharacters = (value) =>
    Array.from(value).some((character) => {
      const code = character.codePointAt(0);
      return code < 32 || code === 127;
    });
  const identifier = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !controlCharacters(value);
  if (!record(input)) {
    return result;
  }
  const { text, expectedThreadId, expectedTurnId, expectedCwd, expectedProfileId } = input;
  if (
    typeof text !== "string" ||
    !identifier(expectedThreadId) ||
    !identifier(expectedTurnId) ||
    typeof expectedCwd !== "string" ||
    !expectedCwd.startsWith("/") ||
    expectedCwd.length > 4096 ||
    controlCharacters(expectedCwd) ||
    (expectedProfileId !== undefined && !identifier(expectedProfileId))
  ) {
    return result;
  }
  if (Buffer.byteLength(text, "utf8") > 8 * 1024 * 1024) {
    return { ...result, reason: "size-limit" };
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length > 20000) {
    return { ...result, reason: "record-limit" };
  }
  let sessionSeen = false;
  let currentTurn;
  let selected;
  let selectedSignature;
  let requested = false;
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > 1024 * 1024) {
      return { ...result, reason: "size-limit" };
    }
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      return { ...result, reason: "malformed-jsonl" };
    }
    if (!record(item) || typeof item.type !== "string") {
      return { ...result, reason: "malformed-jsonl" };
    }
    if (!sessionSeen) {
      if (item.type !== "session_meta" || !record(item.payload)) {
        return { ...result, reason: "missing-session" };
      }
      if (item.payload.id !== expectedThreadId) {
        return { ...result, reason: "thread-mismatch" };
      }
      sessionSeen = true;
      result.exactThreadMatched = true;
      continue;
    }
    if (item.type === "session_meta") {
      return { ...result, reason: "ambiguous-session" };
    }
    const payload = item.payload;
    // A context establishes attribution only inside its active lifecycle.
    // Unscoped records after a boundary cannot belong to that prior context.
    if (
      item.type === "event_msg" &&
      record(payload) &&
      ["task_started", "turn_started", "task_complete", "turn_complete", "turn_aborted"].includes(
        payload.type,
      )
    ) {
      currentTurn = undefined;
      continue;
    }
    if (item.type === "turn_context") {
      if (!record(payload) || !identifier(payload.turn_id)) {
        return { ...result, reason: "invalid-turn-context" };
      }
      currentTurn = payload.turn_id;
      if (currentTurn !== expectedTurnId) {
        continue;
      }
      if (
        typeof payload.cwd !== "string" ||
        !payload.cwd.startsWith("/") ||
        payload.cwd.length > 4096 ||
        controlCharacters(payload.cwd) ||
        !record(payload.sandbox_policy) ||
        typeof payload.sandbox_policy.type !== "string"
      ) {
        return { ...result, reason: "invalid-turn-context" };
      }
      // Compaction can persist the same turn again. Conflicting policy bodies
      // cannot establish one permission state, even if their display IDs match.
      const signature = JSON.stringify([
        payload.cwd,
        payload.approval_policy,
        payload.sandbox_policy,
        payload.permission_profile,
        payload.active_permission_profile,
        payload.file_system_sandbox_policy,
      ]);
      if (selectedSignature !== undefined && selectedSignature !== signature) {
        return { ...result, reason: "ambiguous-turn" };
      }
      selectedSignature = signature;
      selected = payload;
      continue;
    }
    if (currentTurn !== expectedTurnId || !record(payload)) {
      continue;
    }
    if (payload.turn_id !== undefined && payload.turn_id !== expectedTurnId) {
      continue;
    }
    if (item.type === "event_msg" && payload.type === "exec_approval_request") {
      requested = true;
    }
    if (item.type !== "response_item") {
      continue;
    }
    if (payload.type === "custom_tool_call") {
      // Code-mode JavaScript is opaque here. Do not evaluate source or mistake
      // a source substring, prompt, or function output for a permission request.
      continue;
    }
    if (payload.type !== "function_call") {
      continue;
    }
    if (["request_permissions", "functions.request_permissions"].includes(payload.name)) {
      requested = true;
      continue;
    }
    if (
      !["exec_command", "shell", "shell_command", "functions.exec_command"].includes(payload.name)
    ) {
      continue;
    }
    let argumentsValue;
    try {
      argumentsValue = JSON.parse(payload.arguments);
    } catch {
      continue;
    }
    if (!record(argumentsValue)) {
      continue;
    }
    if (
      ["require_escalated", "with_additional_permissions"].includes(
        argumentsValue.sandbox_permissions,
      )
    ) {
      requested = true;
    }
  }
  if (!selected) {
    return { ...result, reason: "turn-missing" };
  }
  if (selected.cwd !== expectedCwd) {
    return {
      ...result,
      reason: "cwd-mismatch",
      exactTurnContextMatched: true,
      cwdMatchesExpectedWorkspace: false,
    };
  }
  const approval = selected.approval_policy;
  const sandbox = selected.sandbox_policy.type;
  const profile = selected.permission_profile?.type;
  const profileId = selected.active_permission_profile?.id;
  const builtinProfiles = {
    ":workspace": "builtin-workspace",
    ":read-only": "builtin-read-only",
    ":danger-full-access": "builtin-danger-full-access",
  };
  let approvalPolicy = "unknown";
  if (["never", "on-request", "on-failure", "untrusted"].includes(approval)) {
    approvalPolicy = approval;
  } else if (record(approval) && record(approval.granular)) {
    approvalPolicy = "granular";
  }
  let activeProfileKind = "unknown";
  if (identifier(profileId)) {
    if (Object.hasOwn(builtinProfiles, profileId)) {
      activeProfileKind = builtinProfiles[profileId];
    } else if (/^openclaw-network-[a-f0-9]{16}$/u.test(profileId)) {
      activeProfileKind = "named-network-proxy";
    } else {
      activeProfileKind = "other-named";
    }
  }
  return {
    ...result,
    status: "available",
    reason: "ok",
    exactTurnContextMatched: true,
    cwdMatchesExpectedWorkspace: selected.cwd === expectedCwd,
    approvalPolicy,
    sandboxPolicy: [
      "read-only",
      "workspace-write",
      "danger-full-access",
      "external-sandbox",
    ].includes(sandbox)
      ? sandbox
      : "unknown",
    permissionProfileType: ["managed", "disabled", "external"].includes(profile)
      ? profile
      : "unknown",
    activeProfileKind,
    profileIdMatchesExpected:
      expectedProfileId === undefined || !identifier(profileId)
        ? "unknown"
        : profileId === expectedProfileId,
    requestedEscalation: requested ? true : "unknown",
  };
}
