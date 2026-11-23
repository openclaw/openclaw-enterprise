import assert from "node:assert/strict";
import test from "node:test";
import { sshBrowserDelegation } from "../../apps/controller/src/drivers/compute/ssh/browser-route.ts";

const target = { installationId: "i", namespaceId: "n", agentId: "a", revisionId: "r" };

test("a different served target cannot receive the browser principal", () => {
  for (const field of Object.keys(target)) {
    assert.equal(
      sshBrowserDelegation(target, { ...target, [field]: "other" }, "p", "chat"),
      undefined,
    );
  }
});

test("chat and admin use the same principal but distinct authority", () => {
  const chat = sshBrowserDelegation(target, target, "p", "chat");
  const admin = sshBrowserDelegation(target, target, "p", "admin");
  assert.ok(chat && admin);
  assert.equal(chat.subject, admin.subject);
  assert.equal(chat.scope, "operator.sessions.write");
  assert.equal(admin.scope, "operator.admin");
  assert.notEqual(chat.subject, sshBrowserDelegation(target, target, "q", "chat")?.subject);
  assert.equal(sshBrowserDelegation(target, target, " ", "admin"), undefined);
});
