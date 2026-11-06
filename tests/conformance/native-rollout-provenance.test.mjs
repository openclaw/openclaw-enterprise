import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { parseNativeRolloutProvenance } from "../helpers/native-rollout-provenance.mjs";

const expected = {
  expectedThreadId: "019a0000-0000-7000-8000-000000000001",
  expectedTurnId: "019a0000-0000-7000-8000-000000000002",
  expectedCwd: "/home/node/workspace",
  expectedProfileId: "openclaw-network-0123456789abcdef",
};
const canary = "SYNTHETIC-PRIVATE-ROLLOUT-CANARY";
const session = {
  type: "session_meta",
  payload: { id: expected.expectedThreadId, base_instructions: { text: canary } },
};
const context = {
  type: "turn_context",
  payload: {
    turn_id: expected.expectedTurnId,
    cwd: expected.expectedCwd,
    approval_policy: "never",
    sandbox_policy: {
      type: "workspace-write",
      writable_roots: [expected.expectedCwd],
      network_access: false,
    },
    permission_profile: {
      type: "managed",
      file_system: {
        type: "restricted",
        entries: [{ path: { type: "path", path: expected.expectedCwd }, access: "write" }],
      },
      network: "disabled",
    },
    active_permission_profile: { id: expected.expectedProfileId },
    model: canary,
  },
};
const shellCall = (permissions = "use_default") => ({
  type: "response_item",
  payload: {
    type: "function_call",
    name: "exec_command",
    arguments: JSON.stringify({ cmd: canary, sandbox_permissions: permissions }),
  },
});
const parse = (...records) =>
  parseNativeRolloutProvenance({
    ...expected,
    text: records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  });

test("native rollout diagnostics keep only the exact thread and turn policy", () => {
  const result = parse(session, context, shellCall());
  assert.deepEqual(result, {
    evidenceKind: "diagnostic-only",
    status: "available",
    reason: "ok",
    exactThreadMatched: true,
    exactTurnContextMatched: true,
    cwdMatchesExpectedWorkspace: true,
    approvalPolicy: "never",
    sandboxPolicy: "workspace-write",
    permissionProfileType: "managed",
    activeProfileKind: "named-network-proxy",
    profileIdMatchesExpected: true,
    requestedEscalation: "unknown",
  });
  // A trusted reader can transport this receipt without exposing IDs, paths,
  // model input, command arguments, or permission-profile bodies.
  const serialized = JSON.stringify(result);
  for (const forbidden of [canary, ...Object.values(expected), "file_system", "arguments"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  const unknown = structuredClone(context);
  unknown.payload.approval_policy = canary;
  unknown.payload.sandbox_policy.type = canary;
  unknown.payload.permission_profile.type = canary;
  unknown.payload.active_permission_profile.id = canary;
  const unfamiliar = parse(session, unknown);
  assert.equal(unfamiliar.approvalPolicy, "unknown");
  assert.equal(unfamiliar.sandboxPolicy, "unknown");
  assert.equal(unfamiliar.permissionProfileType, "unknown");
  assert.equal(JSON.stringify(unfamiliar).includes(canary), false);
  const displaced = structuredClone(context);
  displaced.payload.cwd = "/home/node";
  const mismatch = parse(session, displaced, shellCall("require_escalated"));
  assert.equal(mismatch.cwdMatchesExpectedWorkspace, false);
  assert.equal(mismatch.reason, "cwd-mismatch");
  for (const field of [
    "approvalPolicy",
    "sandboxPolicy",
    "permissionProfileType",
    "activeProfileKind",
    "profileIdMatchesExpected",
    "requestedEscalation",
  ]) {
    assert.equal(mismatch[field], "unknown");
  }
  const wrongThread = structuredClone(session);
  wrongThread.payload.id = "another-owned-thread";
  assert.equal(parse(wrongThread, context).reason, "thread-mismatch");
  const wrongTurn = structuredClone(context);
  wrongTurn.payload.turn_id = "another-turn";
  assert.equal(parse(session, wrongTurn, shellCall("require_escalated")).reason, "turn-missing");
});

test("native rollout diagnostics preserve uncertainty about opaque code-mode escalation", () => {
  assert.equal(parse(session, context, shellCall("require_escalated")).requestedEscalation, true);
  assert.equal(
    parse(session, context, shellCall("with_additional_permissions")).requestedEscalation,
    true,
  );
  assert.equal(
    parse(session, context, shellCall("future-unknown-value")).requestedEscalation,
    "unknown",
  );
  const opaque = {
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      input:
        'globalThis.nativeRolloutExecuted = true; /* sandbox_permissions: "require_escalated" */',
    },
  };
  assert.equal(parse(session, context, opaque, shellCall()).requestedEscalation, "unknown");
  assert.equal(globalThis.nativeRolloutExecuted, undefined);
  const otherTurn = structuredClone(context);
  otherTurn.payload.turn_id = "another-turn";
  assert.equal(
    parse(session, context, shellCall(), otherTurn, shellCall("require_escalated"))
      .requestedEscalation,
    "unknown",
  );
});

test("native rollout diagnostics stop attributing unscoped calls at lifecycle boundaries", () => {
  for (const payload of [
    { type: "task_complete", turn_id: expected.expectedTurnId },
    { type: "turn_complete", turn_id: expected.expectedTurnId },
    { type: "turn_aborted", turn_id: expected.expectedTurnId },
    { type: "turn_aborted", turn_id: null },
    { type: "task_started", turn_id: "another-turn" },
    { type: "turn_started", turn_id: "another-turn" },
    { type: "task_started", turn_id: expected.expectedTurnId },
  ]) {
    const boundary = { type: "event_msg", payload };
    // A later unscoped command or approval cannot be attributed to the saved
    // context. A fresh exact-turn context restores positive attribution.
    const approval = { type: "event_msg", payload: { type: "exec_approval_request" } };
    assert.equal(
      parse(session, context, boundary, shellCall("require_escalated"), approval)
        .requestedEscalation,
      "unknown",
    );
    assert.equal(
      parse(session, context, boundary, context, shellCall("require_escalated"))
        .requestedEscalation,
      true,
    );
  }
});

test("native rollout diagnostics reject conflicting policy even under the same named profile", () => {
  // Compaction can repeat a context. Identical policy is usable; a different
  // compiled policy must not be hidden by a stable display-profile ID.
  assert.equal(parse(session, context, context).status, "available");
  const changed = structuredClone(context);
  changed.payload.permission_profile.file_system = { type: "unrestricted" };
  changed.payload.sandbox_policy = { type: "danger-full-access" };
  assert.equal(parse(session, context, changed).reason, "ambiguous-turn");
  assert.equal(parse(session, context, session).reason, "ambiguous-session");
  const builtin = structuredClone(context);
  builtin.payload.active_permission_profile.id = ":workspace";
  const result = parse(session, builtin);
  assert.equal(result.activeProfileKind, "builtin-workspace");
  assert.equal(result.profileIdMatchesExpected, false);
  assert.equal(
    parseNativeRolloutProvenance({
      ...expected,
      expectedProfileId: undefined,
      text: [session, context].map((item) => JSON.stringify(item)).join("\n"),
    }).profileIdMatchesExpected,
    "unknown",
  );
});

test("native rollout diagnostics fail closed on malformed and oversized input after serialization", () => {
  assert.equal(parseNativeRolloutProvenance(null).reason, "invalid-input");
  for (const text of ["", "{", JSON.stringify(session) + "\n{", "[]"]) {
    assert.equal(parseNativeRolloutProvenance({ ...expected, text }).status, "unavailable");
  }
  assert.equal(
    parseNativeRolloutProvenance({ ...expected, text: "x".repeat(8 * 1024 * 1024 + 1) }).reason,
    "size-limit",
  );
  // The runtime reader embeds the actual function, with no module closures.
  const transported = vm.runInNewContext("(" + parseNativeRolloutProvenance.toString() + ")", {
    Buffer,
  });
  const input = {
    ...expected,
    text: [session, context, shellCall()].map((item) => JSON.stringify(item)).join("\n"),
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(transported(input))),
    parseNativeRolloutProvenance(input),
  );
});
