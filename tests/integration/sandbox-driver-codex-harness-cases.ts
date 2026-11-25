import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { OpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  AgentRevision,
  SandboxHarnessContext,
  SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { SandboxRevisionUnsupportedError } from "../../packages/occ/src/index.ts";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import { openShellWorkspaceHarnessConfiguration } from "./sandbox-driver-installation-fixture.ts";
import { backendFor, openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import {
  completeSandboxRevision,
  completeWorkspaceRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";
import type { workspaceGatewayClient as createWorkspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Requirements = Omit<
  Mutable<SandboxHarnessContext["requirements"]>,
  "credentialAttachments" | "environment"
> & {
  credentialAttachments: SandboxHarnessContext["requirements"]["credentialAttachments"][number][];
  environment: Mutable<SandboxHarnessContext["requirements"]["environment"][number]>[];
};
type GatewayFixture = OpenShellGatewayClient &
  Pick<ReturnType<typeof createWorkspaceGatewayClient>, "calls">;
type FixtureDependencies = {
  codexRequirements: (
    revision: Pick<AgentRevision, "id">,
    environment: Requirements["environment"],
  ) => Requirements;
  dedicatedRevision: (
    driver: OpenShellSandboxDriver,
    context: SandboxNamespaceContext,
    tail: string,
  ) => SandboxFixtureRevision;
  namespaceContext: () => SandboxNamespaceContext;
  runtimeSandboxFixture: (driver: OpenShellSandboxDriver) => {
    context: SandboxNamespaceContext;
    revision: SandboxFixtureRevision;
    requirements: Requirements;
  };
  workspaceGatewayClient: () => GatewayFixture;
};

export function createSandboxCodexHarnessChecks({
  codexRequirements,
  dedicatedRevision,
  namespaceContext,
  runtimeSandboxFixture,
  workspaceGatewayClient,
}: FixtureDependencies) {
  return {
    async rejectRawAppServerTokens(): Promise<void> {
      const gatewayClient = workspaceGatewayClient();
      gatewayClient.createSandbox = async () => {
        throw new Error("OpenShell must not receive a Sandbox it cannot configure.");
      };
      const driver = openShellDriver(gatewayClient);
      const context = namespaceContext();
      const revision = completeSandboxRevision(dedicatedRevision(driver, context, "000000000002"));
      const provision = (harness: AgentRevision["harness"]) =>
        driver.provisionHarness({
          ...context,
          revision: { ...revision, harness },
          requirements: codexRequirements(revision, [
            {
              name: "APP_SERVER_TOKEN",
              valueFrom: { secretKeyRef: { name: "agent-codex-token", key: "token" } },
            },
          ]),
        });

      await assert.rejects(provision(revision.harness), (error) => {
        assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
        assert.equal(error.code, "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED");
        assert.match(error.message, /cannot receive APP_SERVER_TOKEN/);
        return true;
      });
      await assert.rejects(
        provision({ ...revision.harness, id: "codex", version: "1.0.0", mode: "embedded" }),
        (error) => {
          assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
          assert.equal(error.code, "SANDBOX_HARNESS_UNSUPPORTED");
          return true;
        },
      );
    },
    async rejectProjectedAgentIdentity(): Promise<void> {
      const gatewayClient = workspaceGatewayClient();
      const driver = openShellDriver(gatewayClient);
      const { context, revision: fixtureRevision, requirements } = runtimeSandboxFixture(driver);
      const revision = completeWorkspaceRevision(fixtureRevision, requirements);
      requirements.workloadIdentity = {
        serviceAccountName: "agent-codex",
        token: {
          audience: "openclaw-enterprise",
          expirationSeconds: 900,
          mountPath: "/var/run/secrets/openclaw-enterprise",
          path: "token",
          readOnly: true,
        },
      };

      await assert.rejects(
        driver.provisionHarness({ ...context, revision, requirements }),
        (error) => {
          assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
          assert.equal(error.code, "SANDBOX_HARNESS_UNSUPPORTED");
          assert.match(error.message, /cannot preserve an Agent ServiceAccount/);
          return true;
        },
      );
      assert.deepEqual(gatewayClient.calls, []);
    },
    async exposeOnlyBackendPublicCa(t: TestContext): Promise<void> {
      const tls = await harnessTlsFixture(t);
      const gatewayClient = workspaceGatewayClient();
      gatewayClient.getService = async (_workspace, sandbox, name) => ({
        sandbox,
        name,
        targetPort: 8080,
        authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
        advertisedUrl: "https://harness.example.test:8080/",
        url: "https://harness.example.test:8080/",
      });
      const endpoint = async (rootCertificatePath?: string) => {
        const client = new OpenShellGateway(
          {
            endpoint: "https://gateway.example.test:8080/",
            // Endpoint trust never reads or exports administrator authentication.
            auth: {
              mode: "bearerTokenFile",
              path: join(tls.directory, "not-readable-admin-token"),
            },
            ...(rootCertificatePath === undefined ? {} : { rootCertificatePath }),
          },
          { gatewayClient },
        );
        const driver = new OpenShellSandboxDriver(openShellWorkspaceHarnessConfiguration(), {
          id: "openshell-sandbox",
          implementation: "openshell",
          backend: { ...backendFor(gatewayClient), client },
        });
        const { context, revision, requirements } = runtimeSandboxFixture(driver);
        return driver.harnessEndpoint({
          ...context,
          revision: completeWorkspaceRevision(revision, requirements),
          requirements,
        });
      };
      assert.deepEqual(await endpoint(tls.rootCertificatePath), {
        url: "wss://harness.example.test:8080/",
        workspaceRoot: "/sandbox/enterprise",
        codexPermissionProfile: ":danger-full-access",
        tls: { caBundle: tls.caBundle },
      });
      assert.equal((await endpoint()).tls, undefined, "unconfigured roots keep system trust");
      const invalidRoot = join(tls.directory, "invalid-root.pem");
      const begin = "-----BEGIN CERTIFICATE-----";
      const end = "-----END CERTIFICATE-----";
      for (const content of [
        "",
        tls.cert,
        tls.caBundle + tls.key,
        `${begin}\ninvalid\n${end}`,
        `garbage\n${tls.caBundle}`,
        `${tls.caBundle}\ngarbage`,
        `${begin}\n${tls.caBundle}`,
        `${tls.caBundle}\n${end}`,
        // A valid first CA must not hide a malformed or unterminated second block.
        `${tls.caBundle}\n${begin.repeat(1000)}`,
        begin.repeat(1000),
      ]) {
        await writeFile(invalidRoot, content);
        await assert.rejects(endpoint(invalidRoot), /readable public PEM CA certificate bundle/);
      }
      // Rotation bundles preserve canonical PEM, accepting whitespace and CRLF.
      await writeFile(
        invalidRoot,
        ` \t\r\n${tls.caBundle.replaceAll("\n", "\r\n")}\n${tls.caBundle}\t`,
      );
      assert.equal((await endpoint(invalidRoot)).tls?.caBundle, tls.caBundle + tls.caBundle);

      // Bound this synchronous-parser regression in a child: a test timeout cannot interrupt ReDoS.
      const parserUrl = new URL("../../packages/utils/src/tls.ts", import.meta.url).href;
      const repeatedMarkers = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import assert from "node:assert/strict";
       import { publicCaBundle } from ${JSON.stringify(parserUrl)};
       assert.throws(() => publicCaBundle(${JSON.stringify(begin)}.repeat(100_000)),
         /TLS trust must contain only PEM CA certificates/);`,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(
        repeatedMarkers.error,
        undefined,
        "unterminated CA markers must reject promptly",
      );
      assert.equal(repeatedMarkers.status, 0, repeatedMarkers.stderr);
      await assert.rejects(endpoint("relative-ca.pem"), /absolute path/);
      await assert.rejects(
        endpoint(join(tls.directory, "missing-root.pem")),
        /readable public PEM CA/,
      );
    },
  };
}
