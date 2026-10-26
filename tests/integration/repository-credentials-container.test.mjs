import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.mjs";
import { repositoryRoot } from "../fixtures/repository-credentials/runtime.mjs";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";

test("emitted native service and client enforce development token routing without issuance", async (t) => {
  await runInFixtureContainer(t, "tests/integration/repository-credentials-github-token.test.mjs", {
    packaged: true,
  });
});

// Each host case launches its own selected artifact workflow or inspects host mounts.
if (process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD !== "1") {
  for (const workflow of ["git", "gh", "native-paths"]) {
    test(`emitted service and client qualify the real ${workflow} workflow`, async (t) => {
      await runInFixtureContainer(
        t,
        `tests/integration/repository-credentials-${workflow}.test.mjs`,
        { packaged: true },
      );
    });
  }

  test("emitted common owners qualify alternate-backend renewal, authentication and streamed drain", async (t) => {
    await runInFixtureContainer(
      t,
      "tests/conformance/repository-credentials-backend-conformance.test.mjs",
      { packaged: true },
    );
  });

  test("delivered Compose client mounts exclude provider inputs and the control socket", async (t) => {
    const directory = await temporaryDirectory(t);
    const privateAddress = "192.168.50.10";
    const gatewayHostname = "credentials.example.test";
    const paths = {
      CREDENTIAL_SERVICE_INPUTS: join(directory, "private-inputs"),
      CREDENTIAL_SERVICE_CONTROL: join(directory, "private-control"),
      CREDENTIAL_CLIENT_SESSION: join(directory, "client-parent", "selected-session"),
      CREDENTIAL_CLIENT_WORKSPACE: join(directory, "workspace"),
    };
    const result = await run(
      "docker",
      [
        "compose",
        "--file",
        join(repositoryRoot, "deploy/examples/repository-credentials/compose.yaml"),
        "--profile",
        "client",
        "config",
        "--format",
        "json",
      ],
      {
        env: cleanEnvironment({
          ...paths,
          CREDENTIAL_SERVICE_PRIVATE_ADDRESS: privateAddress,
          CREDENTIAL_GATEWAY_HOSTNAME: gatewayHostname,
          CREDENTIAL_SERVICE_UID: String(process.getuid?.() ?? 1000),
          CREDENTIAL_SERVICE_GID: String(process.getgid?.() ?? 1000),
        }),
      },
    );
    const composed = JSON.parse(result.stdout);
    // The client resolves the gateway to the private address publishing HTTPS.
    const ports = composed.services.service.ports;
    assert.equal(ports.length, 1);
    assert.equal(ports[0].host_ip, privateAddress);
    assert.equal(ports[0].target, 8443);
    assert.equal(ports[0].published, "443");
    assert.equal(ports[0].protocol, "tcp");
    assert.deepEqual(composed.services.client.extra_hosts, [
      `${gatewayHostname}=${privateAddress}`,
    ]);
    const volumes = composed.services.client.volumes;
    assert.deepEqual(
      volumes.map((volume) => volume.source).sort(),
      [paths.CREDENTIAL_CLIENT_SESSION, paths.CREDENTIAL_CLIENT_WORKSPACE].sort(),
    );
    assert.equal(volumes.find((volume) => volume.target === "/session").read_only, true);
    assert.ok(
      composed.services.service.volumes.some(
        (volume) => volume.source === paths.CREDENTIAL_SERVICE_INPUTS,
      ),
    );
    assert.ok(
      composed.services.service.volumes.some(
        (volume) => volume.source === paths.CREDENTIAL_SERVICE_CONTROL,
      ),
    );
  });
}
