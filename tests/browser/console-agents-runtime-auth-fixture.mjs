import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

export async function createRuntimeAuthFixture(t, namespaceName, fixtureOptions = {}) {
  const computeDriver = new SshComputeDriver({
    ssh: { identityFile: "/tmp/ssh-test-key", knownHostsFile: "/tmp/ssh-test-hosts" },
    hosts: { runtime: { address: "127.0.0.1", user: "root" } },
    runtime: {
      nodePath: "/usr/bin/node",
      openclawPath: "/opt/openclaw/index.js",
      user: "openclaw",
      root: "/tmp/ssh-runtime-test",
    },
    network: { gatewayPortRange: { start: 18800, end: 18899 } },
  });
  const state = new InMemoryPlatformState();
  const fixture = await createConsoleAppFixture(t, { ...fixtureOptions, computeDriver, state });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(namespaceName);
  await state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  return { fixture, namespace, state };
}
