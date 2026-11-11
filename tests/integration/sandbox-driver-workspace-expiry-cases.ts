import assert from "node:assert/strict";
import test from "node:test";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  OpenShellSandboxCreateRequest,
  OpenShellSandboxResponse,
  OpenShellServiceResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  HarnessWorkloadRequirements,
  SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  completeWorkspaceRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type Gateway = Omit<ReturnType<typeof workspaceGatewayClient>, "createSandbox" | "getService"> & {
  createSandbox: (request: OpenShellSandboxCreateRequest) => Promise<OpenShellSandboxResponse>;
  getService: (
    workspace: string,
    sandbox: string,
    name: string,
  ) => Promise<OpenShellServiceResponse | undefined>;
};
type RuntimeFixture = {
  context: SandboxNamespaceContext & {
    kubernetes: { read: (request: { kind?: string }) => Promise<unknown> };
  };
  revision: SandboxFixtureRevision;
  requirements: HarnessWorkloadRequirements;
  nodeSetup: { url: string; bootstrapToken: string; expiresAtMs: number; tlsFingerprint: string };
};
type Fixtures = {
  openShellDriver: (gateway: Gateway) => OpenShellSandboxDriver;
  runtimeSandboxFixture: (
    driver: OpenShellSandboxDriver,
    options?: { harnessId?: string },
  ) => RuntimeFixture;
  storedSandbox: (
    request: OpenShellSandboxCreateRequest,
    fields?: Partial<OpenShellSandboxResponse>,
  ) => OpenShellSandboxResponse;
  harnessService: (
    sandbox: string,
    name: string,
    url: string,
  ) => OpenShellServiceResponse | undefined;
  callCount: (gateway: Gateway, operation: string) => number;
};
type SetupScenario = {
  name: string;
  setup?: {
    url: string;
    bootstrapToken: string;
    expiresAtMs: number | null;
    tlsFingerprint?: string;
    unsupported?: boolean;
  };
  deviceId?: string | undefined;
  foreignOwner?: boolean;
  malformed?: boolean;
  invalidUtf8?: boolean;
  expected: RegExp;
};
export function registerSandboxDriverWorkspaceExpiryCases({
  openShellDriver,
  runtimeSandboxFixture,
  storedSandbox,
  harnessService,
  callCount,
}: Fixtures): void {
  for (const harnessId of ["codex", "openclaw"]) {
    test(`OpenShell preserves expired ${harnessId} setup for a recorded workspace node`, async () => {
      const gatewayClient: Gateway = workspaceGatewayClient();
      let sandboxName: string | undefined;
      const serviceUrl = "http://codex.example.test:8080/";
      gatewayClient.createSandbox = async (request) => {
        sandboxName = request.name;
        const sandbox = storedSandbox(request, {
          serviceUrls: harnessId === "codex" ? { "": serviceUrl } : {},
        });
        gatewayClient.sandboxes.set(request.name, sandbox);
        return sandbox;
      };
      gatewayClient.getService = async () => {
        assert.ok(sandboxName);
        return harnessService(sandboxName, "", serviceUrl);
      };
      const driver = openShellDriver(gatewayClient);
      const {
        context,
        revision: fixtureRevision,
        requirements,
        nodeSetup,
      } = runtimeSandboxFixture(driver, {
        harnessId,
      });
      const revision = completeWorkspaceRevision(fixtureRevision, requirements);
      const expiredSetup = { ...nodeSetup, expiresAtMs: Date.now() - 1 };
      const setupCode = Buffer.from(JSON.stringify(expiredSetup)).toString("base64url");
      const originalRead = context.kubernetes.read;
      context.kubernetes.read = async (request) => {
        const resource = await originalRead(request);
        if (request.kind !== "Secret") {
          return resource;
        }
        const record = asRecord(resource);
        assert.ok(record);
        return {
          ...record,
          data: {
            setupCode: Buffer.from(setupCode).toString("base64"),
            deviceId: Buffer.from("recorded-node:1").toString("base64"),
          },
        };
      };

      // A replacement Harness must receive the retained envelope so native can
      // verify its saved identity and device token. This is provider planning,
      // not proof that the native runtime accepts those credentials.
      const provision = () => driver.provisionHarness({ ...context, revision, requirements });
      await provision();
      const [provider] = [...gatewayClient.providers.values()];
      assert.ok(provider);
      const setupJson = provider.config.node_setup_json;
      assert.ok(typeof setupJson === "string");
      const parsedSetup: unknown = JSON.parse(setupJson);
      assert.deepEqual(parsedSetup, expiredSetup);
      assert.equal(callCount(gatewayClient, "createProvider"), 1);

      // Reconciliation of that exact expired envelope must not rotate a provider
      // or rewrite its setup merely because the original bootstrap has expired.
      await provision();
      assert.equal(callCount(gatewayClient, "createProvider"), 1);
      assert.equal(callCount(gatewayClient, "updateProviderConfig"), 0);
      assert.equal(callCount(gatewayClient, "updateProviderCredentials"), 0);
    });
  }

  for (const harnessId of ["codex", "openclaw"]) {
    test(`OpenShell rejects malformed or unpaired expired ${harnessId} setup before gateway mutation`, async (t) => {
      const encode = (value: string) => Buffer.from(value).toString("base64");
      const recordedDevice = encode("recorded-node:1");
      const expiredSetup = {
        url: "wss://gateway.example.test/node",
        bootstrapToken: "expired-token",
        expiresAtMs: Date.now() - 1,
      };
      const scenarios: SetupScenario[] = [
        {
          name: "malformed envelope",
          malformed: true,
          deviceId: recordedDevice,
          expected: /malformed setup envelope/,
        },
        { name: "expired without a recorded device", expected: /expired or has no bounded expiry/ },
        {
          name: "expired with an empty device",
          deviceId: "",
          expected: /workspace node device ID is invalid/,
        },
        {
          name: "expired with malformed device encoding",
          deviceId: `${recordedDevice}!`,
          expected: /workspace node device ID is invalid/,
        },
        {
          name: "expired with invalid device content",
          deviceId: encode("bad/id"),
          expected: /workspace node device ID is invalid/,
        },
        {
          name: "invalid UTF-8 inside encoded envelope",
          invalidUtf8: true,
          deviceId: recordedDevice,
          expected: /malformed setup envelope/,
        },
        ...[
          "wss:gateway.example.test/node",
          "wss://gateway.example.test/no\tde",
          "wss://gateway.example.test/\\node",
        ].map((url) => ({
          name: `malformed URL ${JSON.stringify(url)}`,
          setup: { ...expiredSetup, url },
          deviceId: recordedDevice,
          expected: /workspace node setup URL is invalid/,
        })),
        ...[
          "sha256:test",
          `sha256: ${"ab".repeat(32)}`,
          `${"ab".repeat(32)}!`,
          "ab:".repeat(32),
        ].map((tlsFingerprint) => ({
          name: `malformed fingerprint ${JSON.stringify(tlsFingerprint)}`,
          setup: { ...expiredSetup, tlsFingerprint },
          deviceId: recordedDevice,
          expected: /workspace node setup TLS fingerprint is invalid/,
        })),
        ...[false, true].map((recorded) => ({
          name: `plaintext URL with a TLS pin ${recorded ? "with" : "without"} a recorded device`,
          setup: {
            ...expiredSetup,
            url: "ws://gateway.example.test/node",
            tlsFingerprint: "ab".repeat(32),
            expiresAtMs: recorded ? expiredSetup.expiresAtMs : Date.now() + 600_000,
          },
          deviceId: recorded ? recordedDevice : undefined,
          expected: /workspace node setup TLS fingerprint requires a wss endpoint/,
        })),
        {
          name: "unbounded expiry with a recorded device",
          setup: { ...expiredSetup, expiresAtMs: null },
          deviceId: recordedDevice,
          expected: /expired or has no bounded expiry/,
        },
        {
          name: "nonpositive expiry with a recorded device",
          setup: { ...expiredSetup, expiresAtMs: 0 },
          deviceId: recordedDevice,
          expected: /expired or has no bounded expiry/,
        },
        {
          name: "unsupported envelope field with a recorded device",
          setup: { ...expiredSetup, unsupported: true },
          deviceId: recordedDevice,
          expected: /unsupported fields/,
        },
        {
          name: "foreign Secret with a recorded device",
          deviceId: recordedDevice,
          foreignOwner: true,
          expected: /without exact Agent ownership/,
        },
      ];
      for (const {
        name,
        setup = expiredSetup,
        deviceId,
        foreignOwner,
        malformed,
        invalidUtf8,
        expected,
      } of scenarios) {
        await t.test(name, async () => {
          const gatewayClient: Gateway = workspaceGatewayClient();
          const driver = openShellDriver(gatewayClient);
          const {
            context,
            revision: fixtureRevision,
            requirements,
          } = runtimeSandboxFixture(driver, { harnessId });
          const revision = completeWorkspaceRevision(fixtureRevision, requirements);
          const envelope = Buffer.from(JSON.stringify(setup));
          if (invalidUtf8) {
            // Invalid inner bytes must not become replacement characters in a new credential.
            envelope[envelope.indexOf(setup.bootstrapToken)] = 0xff;
          }
          const setupCode = malformed ? "not-a-setup-code" : envelope.toString("base64url");
          const originalRead = context.kubernetes.read;
          context.kubernetes.read = async (request) => {
            const secret = asRecord(await originalRead(request));
            assert.ok(secret);
            const metadata = asRecord(secret.metadata);
            assert.ok(metadata);
            const labels = asRecord(metadata.labels);
            assert.ok(labels);
            return {
              ...secret,
              metadata: {
                ...metadata,
                labels: {
                  ...labels,
                  ...(foreignOwner ? { "openclaw.dev/agent": "other-agent" } : {}),
                },
              },
              data: {
                setupCode: encode(setupCode),
                ...(deviceId === undefined ? {} : { deviceId }),
              },
            };
          };

          // A recorded identifier permits only the expired-envelope handoff; it
          // cannot excuse malformed setup or another Agent's Secret ownership.
          await assert.rejects(
            driver.provisionHarness({ ...context, revision, requirements }),
            expected,
          );
          assert.deepEqual(gatewayClient.calls, []);
        });
      }
    });
  }
}
