import assert from "node:assert/strict";
import test from "node:test";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxCreateRequest,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import { completeSandboxRevision } from "./sandbox-driver-revision-fixture.ts";
import { runtimeSandboxFixture } from "./sandbox-driver-startup-orchestration.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { buildSandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type GatewayFixture = Omit<ReturnType<typeof workspaceGatewayClient>, "createSandbox"> &
  Pick<OpenShellGatewayClient, "createSandbox">;
function recordAt(value: unknown, ...path: string[]): Record<string, unknown> {
  let record = asRecord(value);
  assert.ok(record, "expected a wire record");
  for (const key of path) {
    record = asRecord(record[key]);
    assert.ok(record, `expected wire record ${path.join(".")}`);
  }
  return record;
}

function wireString(value: unknown, key: string): string {
  const field = recordAt(value, key).stringValue;
  assert.ok(typeof field === "string", `expected ${key}.stringValue`);
  return field;
}

export function registerSandboxDriverScratchStorageCase(): void {
  test("OpenShell keeps scratch separate from its durable data mount", async () => {
    const scratch = {
      claimName: "operator-scratch",
      subPath: "scratch",
      mountPath: "/sandbox/scratch",
      readOnly: false,
    };
    for (const dataMount of [
      { claimName: scratch.claimName, subPath: scratch.subPath },
      { mountPath: "/sandbox/scratch" },
      { mountPath: "/sandbox/scratch/workspace" },
      { mountPath: "/sandbox/enterprise/.." },
      { mountPath: "/sandbox/enterprise/../scratch" },
      {},
    ]) {
      const gateway: GatewayFixture = workspaceGatewayClient();
      const requests: OpenShellSandboxCreateRequest[] = [];
      gateway.createSandbox = async (request) => {
        requests.push(request);
        return storedSandbox(request);
      };
      const options = buildSandboxInstallation().drivers.sandbox.configuration;
      Object.assign(options.kubernetes.sandboxDataMount, dataMount);
      const driver = openShellDriver(gateway, options);
      const { context, revision, requirements } = runtimeSandboxFixture(driver);
      const provision = () =>
        driver.provisionHarness({
          ...context,
          revision: completeSandboxRevision(revision),
          requirements: {
            ...requirements,
            workspaceMounts: [...requirements.workspaceMounts, scratch],
          },
        });
      if (Object.keys(dataMount).length > 0) {
        await assert.rejects(
          provision(),
          /sandboxDataMount must preserve durable storage separately/,
        );
        assert.equal(requests.length, 0, "invalid storage must not reach Sandbox creation");
        continue;
      }
      await provision();
      const request = requests[0];
      assert.ok(request, "admitted storage must reach Sandbox creation");
      const { spec } = request;
      const kubernetes = recordAt(
        spec,
        "template",
        "driver_config",
        "fields",
        "kubernetes",
        "structValue",
        "fields",
      );
      const values = recordAt(
        kubernetes,
        "containers",
        "structValue",
        "fields",
        "agent",
        "structValue",
        "fields",
        "volume_mounts",
        "listValue",
      ).values;
      assert.ok(Array.isArray(values), "expected volume mounts");
      const mounts = values.map((value: unknown) => recordAt(value, "structValue", "fields"));
      const durable = mounts.find(
        (mount) => wireString(mount, "mount_path") === "/sandbox/enterprise",
      );
      const selected = mounts.find(
        (mount) => wireString(mount, "mount_path") === scratch.mountPath,
      );
      assert.ok(durable);
      assert.ok(selected);
      assert.notEqual(wireString(selected, "name"), wireString(durable, "name"));
      assert.equal(wireString(selected, "sub_path"), scratch.subPath);
      assert.equal(recordAt(selected, "read_only").boolValue, false);
      assert.equal(recordAt(spec, "environment").OPENCLAW_WORKSPACE_DIR, "/sandbox/enterprise");
    }
  });
}
