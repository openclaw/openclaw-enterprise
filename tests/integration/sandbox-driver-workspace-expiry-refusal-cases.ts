import assert from "node:assert/strict";
import test from "node:test";
import { asRecord } from "../../packages/utils/src/index.ts";
import { completeWorkspaceRevision } from "./sandbox-driver-revision-fixture.ts";
import type { Fixtures } from "./sandbox-driver-workspace-expiry-cases.ts";
import { overrideWorkspaceSetupSecretRead } from "./sandbox-driver-workspace-expiry-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

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
export function registerSandboxDriverWorkspaceExpiryRefusalCases({
  openShellDriver,
  runtimeSandboxFixture,
}: Pick<Fixtures, "openShellDriver" | "runtimeSandboxFixture">): void {
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
          const gatewayClient = workspaceGatewayClient();
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
          overrideWorkspaceSetupSecretRead(
            context.kubernetes,
            {
              setupCode: encode(setupCode),
              ...(deviceId === undefined ? {} : { deviceId }),
            },
            {
              overrideNonSecretReads: true,
              rewriteMetadata: (value) => {
                const metadata = asRecord(value);
                assert.ok(metadata);
                const labels = asRecord(metadata.labels);
                assert.ok(labels);
                return {
                  ...metadata,
                  labels: {
                    ...labels,
                    ...(foreignOwner ? { "openclaw.dev/agent": "other-agent" } : {}),
                  },
                };
              },
            },
          );

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
