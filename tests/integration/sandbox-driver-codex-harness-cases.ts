import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import {
  KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
  type OpenShellSandboxDriverSelection,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  AgentRevision,
  SandboxHarnessContext,
  SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { SandboxRevisionUnsupportedError } from "../../packages/occ/src/index.ts";
import { reservePort, reservedPortArgs } from "../helpers/available-port.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
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
  agentRuntimeEntrypoint: string;
  backendFor: (client: GatewayFixture) => Mutable<OpenShellSandboxDriverSelection["backend"]>;
  codexRequirements: (
    revision: Pick<AgentRevision, "id">,
    environment: Requirements["environment"],
  ) => Requirements;
  conformanceKubernetesOptions: (options: {
    gatewayTrustedProxyCidrs: string[];
  }) => KubernetesComputeDriverOptions;
  dedicatedRevision: (
    driver: OpenShellSandboxDriver,
    context: SandboxNamespaceContext,
    tail: string,
  ) => SandboxFixtureRevision;
  harnessRuntimeCommand: (program: string) => string[];
  namespaceContext: () => SandboxNamespaceContext;
  openShellDriver: (client: GatewayFixture) => OpenShellSandboxDriver;
  runtimeSandboxFixture: (driver: OpenShellSandboxDriver) => {
    context: SandboxNamespaceContext;
    revision: SandboxFixtureRevision;
    requirements: Requirements;
  };
  sandboxInstallation: () => {
    drivers: { sandbox: { configuration: OpenShellSandboxDriverOptions } };
  };
  workspaceGatewayClient: () => GatewayFixture;
};

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown): Record<string, string> {
  const fields = record(value);
  assert.ok(Object.values(fields).every((field) => typeof field === "string"));
  return fields as Record<string, string>;
}

function stringArray(value: unknown): string[] {
  assert.ok(Array.isArray(value) && value.every((item: unknown) => typeof item === "string"));
  return value;
}

export function createSandboxCodexHarnessChecks({
  agentRuntimeEntrypoint,
  backendFor,
  codexRequirements,
  conformanceKubernetesOptions,
  dedicatedRevision,
  harnessRuntimeCommand,
  namespaceContext,
  openShellDriver,
  runtimeSandboxFixture,
  sandboxInstallation,
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
        const backend = backendFor(gatewayClient);
        backend.client = new OpenShellGateway(
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
        const driver = new OpenShellSandboxDriver(
          sandboxInstallation().drivers.sandbox.configuration,
          {
            id: "openshell-sandbox",
            implementation: "openshell",
            backend,
          },
        );
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
    async holdWithdrawnCodexAuthentication(t: TestContext): Promise<void> {
      const gatewayClient = workspaceGatewayClient();
      let sandbox: OpenShellSandboxResponse | undefined;
      gatewayClient.createSandbox = async (request) => {
        sandbox = {
          ...structuredClone(request),
          phase: "SANDBOX_PHASE_READY",
          serviceUrls: { "": "http://codex.example.test" },
        };
        return sandbox;
      };
      gatewayClient.getSandbox = async () => sandbox;
      const driver = openShellDriver(gatewayClient);
      const { context, revision: fixtureRevision, requirements } = runtimeSandboxFixture(driver);
      const compute = new KubernetesComputeDriver(
        conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["127.0.0.1/32"] }),
        { sandboxDriver: driver },
      );
      assert.ok(requirements.credentialAttachments[0]);
      requirements.credentialAttachments[0] = {
        ...requirements.credentialAttachments[0],
        sourceId: "cs_00000000-0000-4000-8000-000000000001",
        externalChatgptAuth: {
          accessTokenPlaceholder: "openshell:resolve:env:CODEX_ACCESS_TOKEN",
          accountId: "withdrawn-account",
          planType: "business",
        },
      };
      const transportToken = "withdrawn-harness-transport";
      // The held Harness serves its failure on this port. Hold it until the Harness answers there,
      // so a test running in parallel cannot take it first.
      const reservation = await reservePort({ host: "0.0.0.0" });
      t.after(() => reservation.release());
      const port: number = reservation.port;
      requirements.loginMode = "chatgptAuthTokens";
      const revision = completeWorkspaceRevision(fixtureRevision, requirements);
      requirements.command = harnessRuntimeCommand(agentRuntimeEntrypoint);
      requirements.workspaceMounts = requirements.workspaceMounts.slice(0, 1);
      requirements.environment.push(
        { name: "CODEX_LOGIN_MODE", value: requirements.loginMode },
        ...compute["credentialSourceEnvironment"](revision, requirements.credentialAttachments),
      );
      const appServerPort = requirements.environment.find(({ name }) => name === "APP_SERVER_PORT");
      assert.ok(appServerPort && "value" in appServerPort);
      appServerPort.value = String(port);
      const appTokenSha = requirements.environment.find(({ name }) => name === "APP_TOKEN_SHA");
      assert.ok(appTokenSha && "value" in appTokenSha);
      appTokenSha.value = createHash("sha256").update(transportToken).digest("hex");
      await driver.provisionHarness({ ...context, revision, requirements });

      const root = await mkdtemp(join(tmpdir(), "openshell-withdrawn-auth-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const codexHome = join(root, "codex");
      await mkdir(codexHome);
      const authPath = join(codexHome, "auth.json");
      const previousAuth = JSON.stringify({
        auth_mode: "chatgptAuthTokens",
        OPENAI_API_KEY: null,
        tokens: {
          access_token: "withdrawn-placeholder",
          id_token: "fixture-account-metadata",
          refresh_token: "",
          account_id: "withdrawn-account",
        },
        last_refresh: new Date().toISOString(),
      });
      await writeFile(authPath, previousAuth, { mode: 0o600 });

      // Exercise the actual Driver command and launcher. The upstream client only
      // captures provisioning. Compute supplies the normal generic placeholder, but
      // a withdrawn OpenShell provider supplies no override. Retaining that placeholder
      // in the Sandbox spec would make this real command exit before its held failure.
      // Private paths substitute for the Sandbox's writable mounts.
      assert.ok(sandbox);
      const spec = record(sandbox.spec);
      const sandboxEnvironment = stringRecord(spec.environment);
      const sandboxCommand = stringArray(spec.command);
      const environment = {
        ...sandboxEnvironment,
        PATH: dirname(process.execPath),
        HOME: root,
        CODEX_HOME: codexHome,
        OPENCLAW_WORKSPACE_DIR: join(root, "workspace"),
      };
      const command = [
        ...reservedPortArgs(reservation),
        "-e",
        ...sandboxCommand.slice(RUNTIME_WRAPPER_COMMAND.length),
      ];
      const child = spawn(process.execPath, command, {
        env: environment,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors += chunk;
      });
      const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      t.after(async () => {
        child.kill("SIGTERM");
        await exited;
      });
      const statusUrl = `http://127.0.0.1:${port}/openclaw/runtime/status`;
      const deadline = Date.now() + 5_000;
      let unauthenticated: Response | undefined;
      // The failure log precedes the asynchronous listen callback. Wait for an actual
      // HTTP response before asserting the held endpoint's authentication behavior.
      while (unauthenticated === undefined) {
        assert.equal(
          child.exitCode,
          null,
          `Harness exited instead of holding authentication: ${errors}`,
        );
        assert.ok(
          Date.now() < deadline,
          `Harness did not expose authentication failure: ${errors}`,
        );
        if (errors.includes("Harness model authentication probe failed.")) {
          unauthenticated = await fetch(statusUrl, {
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          }).catch(() => undefined);
        }
        if (unauthenticated === undefined) {
          await delay(20);
        }
      }
      assert.equal(unauthenticated.status, 401);
      // The Harness answered, so it listens: free the reservation, which would reset a connection
      // the kernel hands it.
      await reservation.release();
      const response = await fetch(statusUrl, {
        headers: { Authorization: `Bearer ${transportToken}` },
      });
      assert.equal(response.status, 200);
      const statusBody: unknown = await response.json();
      const runtimeFailure = record(record(statusBody).runtimeFailure);
      assert.equal(runtimeFailure.component, "agent");
      assert.equal(runtimeFailure.check, "login");
      assert.equal(runtimeFailure.code, "AUTHENTICATION_FAILED");
      assert.equal(sandboxEnvironment.CODEX_ACCESS_TOKEN, undefined);
      const accountJson = sandboxEnvironment.OCE_CODEX_CHATGPT_ACCOUNT;
      assert.ok(accountJson);
      const accountMetadata: unknown = JSON.parse(accountJson);
      assert.deepEqual(accountMetadata, {
        accountId: "withdrawn-account",
        planType: "business",
      });
      assert.equal(
        child.exitCode,
        null,
        "A withdrawal must hold the Harness, not restart its canonical process.",
      );
      assert.equal(
        await readFile(authPath, "utf8"),
        previousAuth,
        "Cached authentication must not be rewritten or used.",
      );
      assert.doesNotMatch(
        errors,
        /codex\.model_probe|withdrawn-placeholder|withdrawn-harness-transport/,
      );

      // Only absent material is recoverable by holding. A supplied unbound alias
      // or invalid account metadata remains an explicit startup configuration error.
      for (const [invalid, expected] of [
        [
          { CODEX_ACCESS_TOKEN: "openshell:resolve:env:CODEX_ACCESS_TOKEN" },
          /refresh-managed credential binding/,
        ],
        [
          {
            CODEX_ACCESS_TOKEN: `openshell:resolve:env:s${"1".repeat(64)}_CODEX_ACCESS_TOKEN`,
            OCE_CODEX_CHATGPT_ACCOUNT: "{}",
          },
          /account metadata is unavailable/,
        ],
      ] as const) {
        const rejected = spawnSync(process.execPath, command, {
          env: { ...environment, ...invalid },
          encoding: "utf8",
          timeout: 5_000,
        });
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, expected);
        assert.equal(await readFile(authPath, "utf8"), previousAuth);
      }
    },
  };
}
