import assert from "node:assert/strict";

type ProtectedStartupConfiguration = {
  drivers: {
    compute: { configuration: { network: { repositoryCredentials?: unknown } } };
  };
  repository: { preparedGitHub?: unknown };
  backend: { configuration: unknown }[];
};

export async function verifyProtectedStartupRefusals(
  configuration: ProtectedStartupConfiguration,
  load: (candidate: ProtectedStartupConfiguration) => Promise<unknown>,
  formatFailure: (error: unknown) => string | undefined,
): Promise<void> {
  const brokerPeer = structuredClone(configuration);
  brokerPeer.drivers.compute.configuration.network.repositoryCredentials = {
    namespace: "openclaw-system",
    podLabels: { "app.kubernetes.io/component": "worker" },
    port: 8443,
  };
  await assert.rejects(
    load(brokerPeer),
    /drivers\.compute\.configuration\.network\.repositoryCredentials requires repository\.nativeSender/,
  );
  // Each unmet repository.openShell requirement names its own field in the startup log and
  // the upgrade check, never its value (finding 2216): one message used to cover all of them.
  const unprepared = structuredClone(configuration);
  delete unprepared.repository.preparedGitHub;
  // A plaintext, unauthenticated gateway the Backend admits only behind a NetworkPolicy.
  const backend = unprepared.backend[0];
  assert.ok(backend);
  backend.configuration = {
    endpoint: "http://sentinel-5b9d.example.test:8080",
    auth: { mode: "unauthenticated" },
    insecureTransport: "network-policy",
  };
  await assert.rejects(load(unprepared), (error: unknown) => {
    const failure = formatFailure(error);
    const prefix = "DRIVER_CONFIGURATION_INVALID: ";
    assert.ok(typeof failure === "string" && failure.startsWith(prefix), String(error));
    const parsed: unknown = JSON.parse(failure.slice(prefix.length));
    assert.ok(Array.isArray(parsed), failure);
    const details: readonly unknown[] = parsed;
    const pairs = details.map((detail) => {
      assert.ok(typeof detail === "object" && detail !== null, failure);
      assert.ok("path" in detail && typeof detail.path === "string", failure);
      assert.ok("code" in detail && typeof detail.code === "string", failure);
      return [detail.path, detail.code];
    });
    assert.deepEqual(
      pairs,
      [
        ["/repository/preparedGitHub", "REQUIRED"],
        ["/backend/0/configuration/endpoint", "INVALID_VALUE"],
        ["/backend/0/configuration/auth/mode", "INVALID_VALUE"],
      ],
      failure,
    );
    assert.ok(!failure.includes("sentinel-5b9d"), failure);
    return true;
  });
}

export async function verifyProtectedChartListenerRefusals(
  port: number,
  loadDeclared: (declared: string) => Promise<unknown>,
): Promise<void> {
  for (const [declared, message] of [
    [String(port), /repository\.openShell\.authority\.host is 127\.0\.0\.1, but the chart's/],
    [
      String(port + 1),
      /repository\.openShell\.authority\.port is \d+, but Helm openshellGit\.port is \d+\./,
    ],
    ["disabled", /but Helm openshellGit\.enabled is false/],
  ] satisfies [string, RegExp][]) {
    await assert.rejects(loadDeclared(declared), {
      name: "ChartListenerMismatchError",
      code: "CHART_LISTENER_MISMATCH",
      message,
    });
  }
}
