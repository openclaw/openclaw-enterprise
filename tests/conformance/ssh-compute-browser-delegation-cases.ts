import assert from "node:assert/strict";
import test from "node:test";
import {
  sshBrowserDelegation,
  sshBrowserRequest,
} from "../../apps/controller/src/drivers/compute/ssh/browser-route.ts";

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

test("browser requests require a matching private listener; no shared endpoint fallback", () => {
  const requested = { ...target, port: 18000 };
  const listener = { ...requested, localTlsPort: 28000, credential: "a".repeat(64) };
  const call = (value: typeof listener | undefined) =>
    sshBrowserRequest(requested, value, "p", "chat");
  assert.equal(call(undefined), undefined);
  for (const change of [
    { port: 18001 },
    { revisionId: "other" },
    { localTlsPort: 0 },
    { credential: "" },
  ]) {
    assert.equal(call({ ...listener, ...change }), undefined);
  }
  const request = call(listener);
  assert.equal(request?.endpoint, "wss://127.0.0.1:28000/");
  assert.equal(request?.headers["x-openclaw-scopes"], "operator.sessions.write");
});

test("the SSH forward binds only locally and selects a distinct Unix socket per revision", async () => {
  const { browserForwardArgs, browserSocketPath } =
    await import("../../apps/controller/src/drivers/compute/ssh/browser-forward.ts");
  const host = {
    address: "127.0.0.1",
    user: "compute",
    port: 22,
    knownHostsFile: "/etc/known_hosts",
    identityFile: "/etc/key",
    connectTimeoutSeconds: 5,
  };
  const args = browserForwardArgs(host, target, 19000);
  assert.ok(args.includes("127.0.0.1:19000:" + browserSocketPath(target)));
  for (const field of Object.keys(target))
    assert.notEqual(
      browserSocketPath(target),
      browserSocketPath({ ...target, [field]: "different" }),
    );
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.throws(() => browserForwardArgs(host, target, 65536));
});
