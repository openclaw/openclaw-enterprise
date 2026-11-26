import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
  type OpenShellSandboxDriverSelection,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxCreateRequest,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  SandboxHarnessContext,
  SandboxNetworkGrant,
  SandboxPolicySnapshot,
} from "../../packages/contracts/src/index.ts";
import type { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

function verifyProtectedGitNetworkAdmission(
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

type NetworkPolicyFixture = {
  sandboxConfiguration: OpenShellSandboxDriverOptions;
  backend: OpenShellSandboxDriverSelection["backend"];
  loadSandbox: (configuration: OpenShellSandboxDriverOptions) => Promise<OpenShellSandboxDriver>;
  sandbox: OpenShellSandboxDriver;
  context: Omit<SandboxHarnessContext, "requirements">;
  requirements: SandboxHarnessContext["requirements"];
  gateway: Pick<OpenShellGatewayClient, "getSandbox"> & {
    updatePolicy?: OpenShellGatewayClient["updatePolicy"];
  };
  sandboxes: Readonly<ReturnType<typeof workspaceGatewayClient>["sandboxes"]>;
  getCreated: () => OpenShellSandboxCreateRequest | undefined;
};

export async function verifyProtectedGitNetworkPolicy({
  sandboxConfiguration,
  backend,
  loadSandbox,
  sandbox,
  context,
  requirements,
  gateway,
  sandboxes,
  getCreated,
}: NetworkPolicyFixture): Promise<void> {
  const endpoint = { host: "*.github.com", ports: [443] };
  const collisionConfiguration: OpenShellSandboxDriverOptions = {
    ...sandboxConfiguration,
    policy: {
      ...sandboxConfiguration.policy,
      networkPolicies: [
        ...(sandboxConfiguration.policy?.networkPolicies ?? []),
        {
          name: "overlap",
          endpoints: [endpoint],
          binaries: [{ path: "/usr/bin/curl" }],
        },
      ],
    },
  };
  // Finding 2131: an overlapping policy fails the Installation at startup, naming the
  // policy, instead of the first Agent deploy.
  const collision = () => loadSandbox(collisionConfiguration);
  for (const host of [
    "*.github.com",
    "api.github.com",
    "github.com",
    "codeload.github.com",
    "uploads.github.com",
  ]) {
    endpoint.host = host;
    await assert.rejects(
      collision,
      {
        message:
          "OpenShell Git reaches github.com and its subdomains only through its middleware route; remove those hosts from sandbox network policy overlap.",
      },
      host,
    );
  }
  // Finding 2145: an IP-address host may lead to GitHub too, so it is refused outright.
  for (const host of ["140.82.112.3", "[2606:50c0:8000::154]", "140.82.112.0/20"]) {
    endpoint.host = host;
    await assert.rejects(
      collision,
      {
        message: `OpenShell Git reaches GitHub only through its middleware route, and an IP address may lead there; use a DNS name instead of ${host} in sandbox network policy overlap.`,
      },
      host,
    );
  }
  // The same policy is fine without the Git route.
  const routeless = new OpenShellSandboxDriver(collisionConfiguration, {
    id: sandbox.id,
    backend,
  });

  const { allowed, defaults } = verifyProtectedGitNetworkAdmission(sandbox, routeless);
  // Backstop at provisioning: a revision admitted with such a grant never gets a Sandbox.
  const direct: SandboxNetworkGrant = {
    ...allowed,
    id: "git-direct",
    host: "github.com",
    ports: [{ from: 443, to: 443 }],
  };
  const snapshot: SandboxPolicySnapshot = {
    driverId: sandbox.id,
    implementation: sandbox.implementation,
    version: 2,
    defaults,
    additions: [direct],
  };
  const bypassRevision = {
    ...context.revision,
    id: "rev_00000000-0000-4000-8000-000000002144",
    sandboxPolicy: snapshot,
  };
  const createdBefore = getCreated();
  await assert.rejects(
    sandbox.provisionHarness({ ...context, revision: bypassRevision, requirements }),
    {
      name: "SandboxRevisionUnsupportedError",
      code: "SANDBOX_HARNESS_UNSUPPORTED",
      message: /Protected execution keeps only its protected egress policy/,
    },
  );
  assert.equal(getCreated(), createdBefore, "no Sandbox is created");
  await assert.rejects(
    sandbox.provisionHarness({
      ...context,
      revision: {
        ...bypassRevision,
        sandboxPolicy: {
          ...snapshot,
          additions: [{ ...direct, id: "git-address", host: "140.82.112.3" }],
        },
      },
      requirements,
    }),
    {
      name: "SandboxRevisionUnsupportedError",
      code: "SANDBOX_HARNESS_UNSUPPORTED",
      message: /Protected execution keeps only its protected egress policy/,
    },
  );
  assert.equal(getCreated(), createdBefore, "no Sandbox is created for an IP-address grant");
  // Backstop at live application: the running Git Sandbox's policy is never widened.
  const getSandbox = gateway.getSandbox;
  const updatePolicy = gateway.updatePolicy;
  let policyUpdates = 0;
  gateway.getSandbox = async ({ name }) => {
    const stored = sandboxes.get(name);
    assert.ok(stored, "the running Git Sandbox must remain observable");
    return { ...stored, resourceVersion: "1" };
  };
  gateway.updatePolicy = async () => {
    policyUpdates++;
  };
  try {
    await assert.rejects(
      sandbox.applyNetworkPolicy(
        {
          namespace: context.namespace,
          revision: context.revision,
          signal: AbortSignal.timeout(2_000),
        },
        {
          snapshot: { ...snapshot },
          expectedProviderVersion: "1",
          operationId: randomUUID(),
        },
      ),
      {
        name: "SandboxNetworkPolicyConflictError",
        message: /remove network grant git-direct/,
      },
    );
    await assert.rejects(
      sandbox.applyNetworkPolicy(
        {
          namespace: context.namespace,
          revision: context.revision,
          signal: AbortSignal.timeout(2_000),
        },
        {
          snapshot: {
            ...snapshot,
            additions: [{ ...direct, id: "git-address", host: "140.82.112.3" }],
          },
          expectedProviderVersion: "1",
          operationId: randomUUID(),
        },
      ),
      {
        name: "SandboxNetworkPolicyConflictError",
        message:
          /IP address may lead there.*: remove network grant git-address \(140\.82\.112\.3\)\.$/,
      },
    );
    assert.equal(policyUpdates, 0);
  } finally {
    gateway.getSandbox = getSandbox;
    gateway.updatePolicy = updatePolicy;
  }
}
