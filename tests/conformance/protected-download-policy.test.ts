import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxPolicy } from "../../packages/contracts/src/index.ts";
import { projectProtectedDownloadPolicy } from "../../packages/occ/src/protected-download-policy.ts";

const host = Object.freeze({
  scheme: "https" as const,
  host: "files.example.com",
  port: 443 as const,
});
const first = Object.freeze({ ...host, path: "/first" });
const second = Object.freeze({ ...host, path: "/second" });
const third = Object.freeze({ ...host, path: "/third" });

function tenant(namespaceId: string): SandboxPolicy {
  return Object.freeze({
    id: namespaceId + "-policy",
    namespaceId,
    agentId: namespaceId + "-agent",
    version: 8,
    additions: Object.freeze([]),
  });
}

test("one Agent's exact approval survives disable and repeat approval without widening another Agent's scope", () => {
  const a = tenant("a");
  const b = tenant("b");
  const approve = { action: "approve-and-enable" as const, destination: first };
  const initial = projectProtectedDownloadPolicy(a, approve, []);
  assert.equal(initial.status, "changed");
  assert.deepEqual(initial.policy, {
    ...a,
    approvedDownloadDestinations: [first],
    downloadDestinations: [first],
  });
  const duplicate = projectProtectedDownloadPolicy(
    initial.policy,
    { ...approve, destination: { ...first } },
    [],
  );
  assert.equal(duplicate.status, "unchanged");
  assert.equal(duplicate.policy, initial.policy);
  for (const destination of [
    host,
    second,
    { ...first, path: "/first/child" },
    { ...first, scheme: "http" as const, port: 80 as const },
  ]) {
    assert.equal(
      projectProtectedDownloadPolicy(initial.policy, { action: "enable", destination }, []).status,
      "outside-scope",
    );
  }
  assert.equal(
    projectProtectedDownloadPolicy(b, { action: "enable", destination: first }, []).status,
    "outside-scope",
  );
  const disable = { action: "disable" as const, destination: first };
  const off = projectProtectedDownloadPolicy(initial.policy, disable, []);
  assert.equal(off.status, "changed");
  assert.deepEqual(off.policy, {
    ...a,
    approvedDownloadDestinations: [first],
    downloadDestinations: [],
  });
  assert.equal(projectProtectedDownloadPolicy(off.policy, disable, []).status, "unchanged");
  const on = projectProtectedDownloadPolicy(
    off.policy,
    { action: "enable", destination: first },
    [],
  );
  assert.equal(on.status, "changed");
  assert.deepEqual(on.policy, initial.policy);
  const delegated = projectProtectedDownloadPolicy(b, { action: "enable", destination: second }, [
    host,
  ]);
  assert.equal(delegated.status, "changed");
  assert.deepEqual(delegated.policy, { ...b, downloadDestinations: [second] });
  const removed = projectProtectedDownloadPolicy(
    delegated.policy,
    { action: "disable", destination: second },
    [],
  );
  assert.equal(removed.status, "changed");
  assert.deepEqual(removed.policy, { ...b, downloadDestinations: [] });
  assert.equal(
    projectProtectedDownloadPolicy(removed.policy, { action: "enable", destination: second }, [])
      .status,
    "outside-scope",
  );
});

test("withdrawing a host removes only grants depending on that approval", () => {
  const unrelated = { ...host, host: "other.example.com" };
  const approved = Object.freeze([first, host]);
  const active = Object.freeze([host, first, second, third, unrelated]);
  const policy = Object.freeze({
    ...tenant("owner"),
    approvedDownloadDestinations: approved,
    downloadDestinations: active,
  });
  const withdraw = { action: "withdraw-approval" as const, destination: host };
  const result = projectProtectedDownloadPolicy(policy, withdraw, [second]);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.policy, {
    ...policy,
    approvedDownloadDestinations: [first],
    downloadDestinations: [first, second, unrelated],
  });
  assert.equal(
    projectProtectedDownloadPolicy(result.policy, withdraw, [second]).status,
    "unchanged",
  );
  const withdrawObject = projectProtectedDownloadPolicy(
    policy,
    { ...withdraw, destination: first },
    [],
  );
  assert.equal(withdrawObject.status, "changed");
  assert.deepEqual(withdrawObject.policy, { ...policy, approvedDownloadDestinations: [host] });
});
