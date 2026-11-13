import assert from "node:assert/strict";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";

export function verifyProtectedGitNetworkAdmission(
  sandbox: OpenShellSandboxDriver,
  routeless: OpenShellSandboxDriver,
) {
  // Finding 2144: an Agent network grant must not open a route beside the middleware either,
  // on any port. Admission refuses it for a repository-bound Agent, naming the grant.
  const allowed = {
    id: "docs",
    binary: "/usr/bin/curl",
    host: "objects.githubusercontent.com",
    ports: [{ from: 443, to: 443 }],
  };
  const repositoryScope = { repositoryCredentials: true };
  assert.deepEqual(sandbox.admitNetworkPolicy([allowed], 2, undefined, repositoryScope).additions, [
    allowed,
  ]);
  for (const [host, port] of [
    ["github.com", 22],
    ["api.github.com", 443],
    ["*.github.com", 443],
    // Finding 2148: GitHub's other front ends under github.com skip the middleware too.
    ["ssh.github.com", 443],
    ["codeload.github.com", 443],
  ] satisfies [string, number][]) {
    const direct = {
      ...allowed,
      id: "git-direct",
      host,
      ports: [{ from: port, to: port }],
    };
    assert.throws(
      () => sandbox.admitNetworkPolicy([allowed, direct], 2, undefined, repositoryScope),
      {
        name: "SandboxNetworkPolicyConflictError",
        message: `OpenShell Git reaches github.com and its subdomains only through its middleware route, so an Agent with a repository binding cannot also allow them: remove network grant git-direct (${host}).`,
      },
      host,
    );
    // Without a repository binding, or without the Git route, the grant is admitted.
    assert.equal(sandbox.admitNetworkPolicy([direct], 2).additions[0]?.host, host);
    assert.equal(
      routeless.admitNetworkPolicy([direct], 2, undefined, repositoryScope).additions[0]?.host,
      host,
    );
  }
  // Finding 2145: an IP-address grant may reach GitHub, so it is refused with its own message;
  // without the Git route it stays an ordinary grant.
  for (const host of ["140.82.112.3", "*.82.112.3", "0x8c.0x52.0x70.0x3", "2354212867"]) {
    const address = { ...allowed, id: "git-address", host };
    assert.throws(
      () => sandbox.admitNetworkPolicy([allowed, address], 2, undefined, repositoryScope),
      {
        name: "SandboxNetworkPolicyConflictError",
        message: `OpenShell Git reaches GitHub only through its middleware route, and an IP address may lead there, so an Agent with a repository binding cannot allow one: remove network grant git-address (${host}).`,
      },
      host,
    );
    assert.equal(sandbox.admitNetworkPolicy([address], 2).additions[0]?.host, host);
  }
  // Revision defaults get the same check; the Driver's own policies were checked at startup.
  const defaults = sandbox.admitNetworkPolicy([], 1).defaults;
  const admitMirror = (host: string) =>
    sandbox.admitNetworkPolicy(
      [],
      1,
      { ...defaults, mirror: { name: "mirror", endpoints: [{ host }] } },
      repositoryScope,
    );
  assert.throws(
    () => admitMirror("github.com"),
    /remove sandbox network policy mirror \(github\.com\)\.$/,
  );
  for (const host of ["2606:50c0:8000::154", "[2606:50c0:8000::154]", "140.82.112.0/20"]) {
    assert.throws(
      () => admitMirror(host),
      {
        name: "SandboxNetworkPolicyConflictError",
        message: `OpenShell Git reaches GitHub only through its middleware route, and an IP address may lead there, so an Agent with a repository binding cannot allow one: remove sandbox network policy mirror (${host}).`,
      },
      host,
    );
  }
  return { allowed, defaults };
}
