import assert from "node:assert/strict";
import type { OpenShellSandboxCreateRequest } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  HarnessWorkloadRequirements,
  SandboxHarnessContext,
} from "../../packages/contracts/src/index.ts";
import type { SandboxRevisionUnsupportedError } from "../../packages/occ/src/index.ts";

type Dependencies = {
  driver: OpenShellSandboxDriver;
  context: Omit<SandboxHarnessContext, "revision" | "requirements">;
  revision: SandboxHarnessContext["revision"];
  exposing: (
    environment: HarnessWorkloadRequirements["environment"],
  ) => HarnessWorkloadRequirements;
  requests: OpenShellSandboxCreateRequest[];
  unsupportedError: typeof SandboxRevisionUnsupportedError;
};

export async function verifyNativeExposureCredentialBoundary({
  driver,
  context,
  revision,
  exposing,
  requests,
  unsupportedError,
}: Dependencies): Promise<void> {
  // The exposure needs the verifier, and never the raw token, exactly like Codex.
  const invalidCredentials: [HarnessWorkloadRequirements["environment"], RegExp][] = [
    [[{ name: "APP_SERVER_PORT", value: "18790" }], /requires one literal APP_TOKEN_SHA verifier/],
    [
      [
        { name: "APP_SERVER_PORT", value: "18790" },
        { name: "APP_TOKEN_SHA", value: "b".repeat(64) },
        {
          name: "APP_SERVER_TOKEN",
          valueFrom: { secretKeyRef: { name: "agent-token", key: "token" } },
        },
      ],
      /cannot receive APP_SERVER_TOKEN/,
    ],
  ];
  for (const [environment, message] of invalidCredentials) {
    await assert.rejects(
      driver.provisionHarness({ ...context, revision, requirements: exposing(environment) }),
      (error) => {
        assert.ok(error instanceof unsupportedError, String(error));
        assert.equal(error.code, "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED");
        assert.match(error.message, message);
        return true;
      },
    );
  }
  assert.equal(requests.length, 0);
}
