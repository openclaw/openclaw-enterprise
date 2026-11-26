import assert from "node:assert/strict";
import test from "node:test";
import { runLauncher } from "./k3d-launcher-fixture.ts";

export function registerLauncherStateCases() {
  test("k3d get prints one selected demo or cluster value without preparing resources", async (context) => {
    assert.equal(
      await runLauncher(context, "docker", ["get", "kubeconfig"]),
      "/private/demo/kubeconfig\n",
    );
    assert.equal(
      await runLauncher(context, "docker", ["get", "occ-console"]),
      "http://127.0.0.1:18889/console/agents?namespace=demo\n",
    );
    assert.equal(
      await runLauncher(context, "docker", ["get", "openclaw-control-ui"]),
      "http://127.0.0.1:18888/\n",
    );
  });

  test("k3d copy sends sensitive values only to the clipboard", async (context) => {
    const password = await runLauncher(context, "docker", ["copy", "occ-password"]);
    assert.equal(password.stdout, "Copied occ-password to the clipboard.\n");
    assert.equal(password.clipboard, "development-password");
    assert.doesNotMatch(password.stdout, /development-password/);

    const gatewayPassword = await runLauncher(context, "docker", ["copy", "openclaw-password"]);
    assert.equal(gatewayPassword.stdout, "Copied openclaw-password to the clipboard.\n");
    assert.equal(gatewayPassword.clipboard, "gateway-development-password");
    assert.doesNotMatch(gatewayPassword.stdout, /gateway-development-password/);
  });

  test("k3d password copy discovers an active native OpenClaw demo without a Harness flag", async (context) => {
    const gatewayPassword = await runLauncher(context, "docker", ["copy", "openclaw-password"], {
      preparedHarness: "openclaw",
    });
    assert.equal(gatewayPassword.stdout, "Copied openclaw-password to the clipboard.\n");
    assert.equal(gatewayPassword.clipboard, "gateway-development-password");

    const consolePassword = await runLauncher(context, "docker", ["copy", "occ-password"], {
      preparedHarness: "openclaw",
    });
    assert.equal(consolePassword.stdout, "Copied occ-password to the clipboard.\n");
    assert.equal(consolePassword.clipboard, "development-password");
  });

  test("k3d copy requires a Harness flag when multiple demos are active", async (context) => {
    await assert.rejects(
      runLauncher(context, "docker", ["copy", "occ-password"], { ambiguousDemo: true }),
      /multiple active k3d demos have passwords/,
    );
  });

  test("k3d copy supports a Linux Wayland clipboard", async (context) => {
    const password = await runLauncher(context, "docker", ["copy", "occ-password"], {
      platform: "Linux",
      clipboardCommand: "wl-copy",
    });
    assert.equal(password.stdout, "Copied occ-password to the clipboard.\n");
    assert.equal(password.clipboard, "development-password");
  });

  test("k3d get rejects sensitive fields", async (context) => {
    await assert.rejects(
      runLauncher(context, "docker", ["get", "occ-password"]),
      /unknown field 'occ-password'/,
    );
  });

  test("k3d info reports local state and non-secret connection values", async (context) => {
    const output = await runLauncher(context, "docker", ["info"]);
    assert.match(output, /^k3d$/m);
    assert.match(output, /Engine:\s+Docker/);
    assert.match(output, /Prepared state:\s+ready/);
    assert.match(output, /Demo:\s+ready/);
    assert.match(output, /^OpenClaw$/m);
    assert.match(output, /^OpenClaw Control Plane \(OCC\)$/m);
    assert.match(output, /^Kubernetes$/m);
    assert.match(output, /^Outside Kubernetes$/m);
    assert.match(output, /Control UI:\s+http:\/\/127\.0\.0\.1:18888\//);
    assert.match(output, /Console:\s+http:\/\/127\.0\.0\.1:18889\//);
    assert.match(output, /Username:\s+admin@openclaw\.local/);
    assert.match(output, /Namespace:\s+demo-namespace/);
    assert.match(output, /Kubeconfig:\s+\/private\/demo\/kubeconfig/);
    assert.match(output, /Demo coordinator, worker, and port-forwards:\s+running \(PID \d+\)/);
    assert.match(output, /PostgreSQL container:\s+openclaw_ci_pg_test-postgres-1 \(Up 1 minute/);
    assert.match(output, /k3d containers:\s+k3d-openclaw-k8s-test-server-0 \(Up 1 minute\)/);
    assert.match(output, /\.\/scripts\/k3d copy openclaw-password/);
    assert.match(output, /\.\/scripts\/k3d copy occ-password/);
    assert.doesNotMatch(output, /development-password|gateway-development-password/);
  });
}
