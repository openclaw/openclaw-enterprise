import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { inflateRawSync } from "node:zlib";
import { ComputeGatewaySettingError } from "../../packages/occ/src/index.ts";
import type {
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "../../packages/contracts/src/index.ts";
import { unreadableGatewayPasswordRefusal } from "../helpers/refusal-text.mjs";
import {
  dockerDriver,
  dockerGatewayRevision,
  installDockerFixture,
  namespaceLabels,
  parseJson,
  prepareDockerRevision,
  readContainerCreate,
  readRecord,
  splitEnvironment,
  tenant,
  withModelKey,
  type ContainerCreate,
} from "./docker-compute-fixture.ts";

export function registerGatewayLaunchCases() {
  test("Docker Compute gateway containers use password auth by default and preserve trusted proxy auth", async () => {
    const defaultLaunch = await gatewayContainerLaunch();
    assert.match(defaultLaunch.environment.OPENCLAW_GATEWAY_PASSWORD ?? "", /^[0-9a-f]{64}$/);
    assert.equal(defaultLaunch.environment.OPENCLAW_GATEWAY_PORT, "8080");
    assert.equal(defaultLaunch.gateway.auth.mode, "password");
    assert.equal(defaultLaunch.gateway.auth.password, "${OPENCLAW_GATEWAY_PASSWORD}");
    assert.equal(defaultLaunch.revision.configuration.gateway, undefined);

    const passwordLaunch = await gatewayContainerLaunch({
      gateway: {
        tls: { enabled: false },
        auth: { password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" } },
      },
    });
    assert.match(passwordLaunch.environment.OPENCLAW_GATEWAY_PASSWORD ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(passwordLaunch.gateway.tls, {
      enabled: false,
    });
    assert.equal(passwordLaunch.gateway.auth.mode, "password");
    assert.deepEqual(passwordLaunch.gateway.auth.password, {
      source: "env",
      provider: "default",
      id: "OPENCLAW_GATEWAY_PASSWORD",
    });
    assert.equal(
      readRecord(readRecord(passwordLaunch.revision.configuration.gateway).auth).mode,
      undefined,
    );

    const staticPasswordLaunch = await gatewayContainerLaunch({
      gateway: { auth: { mode: "password", password: "static-gateway-password" } },
    });
    assert.equal(staticPasswordLaunch.environment.OPENCLAW_GATEWAY_PASSWORD, undefined);
    assert.equal(staticPasswordLaunch.gateway.auth.mode, "password");
    assert.equal(staticPasswordLaunch.gateway.auth.password, "static-gateway-password");

    const trustedProxyLaunch = await gatewayContainerLaunch({
      gateway: { auth: { mode: "trusted-proxy" } },
    });
    assert.equal(trustedProxyLaunch.environment.OPENCLAW_GATEWAY_PASSWORD, undefined);
    assert.equal(trustedProxyLaunch.gateway.auth.mode, "trusted-proxy");

    const trustedProxyWithPasswordLaunch = await gatewayContainerLaunch({
      gateway: {
        auth: {
          mode: "trusted-proxy",
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
    });
    assert.match(
      trustedProxyWithPasswordLaunch.environment.OPENCLAW_GATEWAY_PASSWORD ?? "",
      /^[0-9a-f]{64}$/,
    );
    assert.equal(trustedProxyWithPasswordLaunch.gateway.auth.mode, "trusted-proxy");
    assert.deepEqual(trustedProxyWithPasswordLaunch.gateway.auth.password, {
      source: "env",
      provider: "default",
      id: "OPENCLAW_GATEWAY_PASSWORD",
    });
  });

  const generatedPassword = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" };
  const passwordAuth = (password: OpenClawConfigurationValue, mode = "password") => ({
    gateway: { auth: { mode, password } },
  });
  const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

  test("Docker Compute rejects unsupported native gateway settings at admission and before Docker engine access", async () => {
    const driver = dockerDriver();

    const refusals: [OpenClawConfigurationDocument, string, RegExp][] = [
      [{ gateway: { auth: { mode: "oauth" } } }, "gateway.auth.mode", /password or trusted-proxy/i],
      [{ gateway: { auth: { mode: "token" } } }, "gateway.auth.mode", /password or trusted-proxy/i],
      [{ gateway: { auth: { mode: "none" } } }, "gateway.auth.mode", /password or trusted-proxy/i],
      [
        { gateway: { auth: { token: "gateway-token" } } },
        "gateway.auth.token",
        /gateway\.auth\.token is not a supported native gateway authentication field/,
      ],
      [
        { gateway: { auth: { unsupportedField: true } } },
        "gateway.auth.unsupportedField",
        /gateway\.auth\.unsupportedField is not a supported/,
      ],
      [{ gateway: { auth: null } }, "gateway.auth", /gateway\.auth must be an object/],
      [
        { gateway: { tls: { enabled: true } } },
        "gateway.tls.enabled",
        /gateway\.tls\.enabled must be omitted or false/i,
      ],
      // The published port forwards to the container IP while the healthcheck probes
      // loopback, so a loopback-only listener would pass readiness and serve nothing.
      [
        { gateway: { bind: "loopback" } },
        "gateway.bind",
        /gateway\.bind must listen on all interfaces/,
      ],
      [
        { gateway: { bind: "tailnet" } },
        "gateway.bind",
        /gateway\.bind must listen on all interfaces/,
      ],
      [
        { gateway: { bind: "custom", customBindHost: "127.0.0.1" } },
        "gateway.customBindHost",
        /gateway\.customBindHost must be 0\.0\.0\.0/,
      ],
      [
        { gateway: { tailscale: { mode: "serve" } } },
        "gateway.tailscale.mode",
        /gateway\.tailscale\.mode must be off/,
      ],
      [
        {
          plugins: {
            entries: { codex: { config: { appServer: { approvalPolicy: "untrusted" } } } },
          },
        },
        "plugins.entries.codex.config.appServer.approvalPolicy",
        /appServer\.approvalPolicy must not be "untrusted"/,
      ],
      // OpenClaw resolves the password in both auth modes, with the Configuration's own secrets: its
      // schema refuses an object without a text provider or with other keys (exit 78), and the
      // Gateway exits on a provider or allowlist that cannot serve it (finding 3061).
      ...(
        [
          [passwordAuth({ source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" }), "providerless"],
          [
            passwordAuth({ source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" }, "trusted-proxy"),
            "providerless",
          ],
          [
            {
              ...passwordAuth({ source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" }),
              secrets: { defaults: { env: "custom" } },
            },
            "providerless",
            "env",
            "custom",
          ],
          [
            passwordAuth({ source: "env", provider: null, id: "OPENCLAW_GATEWAY_PASSWORD" }),
            "providerless",
          ],
          [passwordAuth({ ...generatedPassword, note: "x" }), "keys"],
          [passwordAuth({ ...generatedPassword, provider: "vault" }), "provider", "vault"],
          [
            {
              ...passwordAuth(generatedPassword),
              secrets: { providers: { default: { source: "env", allowlist: ["OTHER"] } } },
            },
            "allowlist",
            "OPENCLAW_GATEWAY_PASSWORD",
          ],
          [passwordAuth({ source: "vault", provider: "default", id: "X" }), "shape"],
        ] satisfies [OpenClawConfigurationDocument, string, ...string[]][]
      ).map(([configuration, held, ...shown]): [OpenClawConfigurationDocument, string, RegExp] => [
        configuration,
        "gateway.auth.password",
        exactly(unreadableGatewayPasswordRefusal(held, ...shown)),
      ]),
    ];
    for (const [configuration, setting, expected] of refusals) {
      const revision = dockerGatewayRevision(driver, configuration);
      let networkAccesses = 0;
      let dockerRequests = 0;
      installDockerFixture(driver, {
        network: async () => {
          networkAccesses += 1;
          throw new Error("network access must not occur");
        },
        request: async () => {
          dockerRequests += 1;
          throw new Error("Docker API access must not occur");
        },
      });

      let preparationMessage: string | undefined;
      await assert.rejects(
        () => prepareDockerRevision(driver, revision),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          preparationMessage = error.message;
          return expected.test(error.message);
        },
      );
      assert.equal(networkAccesses, 0);
      assert.equal(dockerRequests, 0);
      // Deployment admission refuses every setting preparation refuses, with the same message and a
      // 409, because the deploy stops the running revision before preparation (finding 2352).
      assert.throws(
        () => driver.validateGatewaySettings(configuration),
        (error) =>
          error instanceof ComputeGatewaySettingError &&
          error.setting === setting &&
          error.message === preparationMessage,
      );
    }
    assert.doesNotThrow(() => driver.validateGatewaySettings({ gateway: { bind: "lan" } }));
    for (const auth of [
      { mode: "password", password: "static-gateway-password" },
      { mode: "trusted-proxy" },
    ]) {
      assert.doesNotThrow(() => driver.validateGatewaySettings({ gateway: { auth } }));
    }
    // References OpenClaw reads: the alias secrets.defaults.env names, a configured env provider
    // whose allowlist lists the name, and another variable the Configuration's bindings may set.
    for (const configuration of [
      {
        ...passwordAuth({ ...generatedPassword, provider: "custom" }),
        secrets: { defaults: { env: "custom" } },
      },
      {
        ...passwordAuth({ ...generatedPassword, provider: "vault" }),
        secrets: {
          providers: { vault: { source: "env", allowlist: ["OPENCLAW_GATEWAY_PASSWORD"] } },
        },
      },
      passwordAuth(
        { source: "env", provider: "default", id: "MY_GATEWAY_PASSWORD" },
        "trusted-proxy",
      ),
    ]) {
      assert.doesNotThrow(
        () => driver.validateGatewaySettings(configuration),
        JSON.stringify(configuration),
      );
    }
  });

  test("Docker prepares configuration before starting a managed Gateway", async () => {
    const { body, environment } = await gatewayContainerLaunch();
    const program = inflateRawSync(Buffer.from(body.Cmd.slice(2).join(""), "base64")).toString();
    const nativeRequire: (specifier: string) => unknown = createRequire(import.meta.url);
    const runProgram: (program: string, context: object) => void = runInNewContext;
    const events: (
      { kind: "write"; path: string } | { kind: "spawn"; args: string[]; env: NodeJS.ProcessEnv }
    )[] = [];
    runProgram(program, {
      process: { env: { ...environment }, on() {} },
      require(specifier: string): unknown {
        if (specifier === "node:fs") {
          return {
            chmodSync() {},
            // This fresh Gateway has no pending maintenance marker.
            lstatSync() {
              throw Object.assign(new Error("File not found"), { code: "ENOENT" });
            },
            mkdirSync() {},
            readdirSync: () => [],
            writeFileSync(path: string) {
              events.push({ kind: "write", path });
            },
          };
        }
        if (specifier === "node:child_process") {
          return {
            spawn(_command: string, args: string[], { env }: { env: NodeJS.ProcessEnv }) {
              events.push({ kind: "spawn", args: [...args], env });
              return { on() {} };
            },
          };
        }
        return nativeRequire(specifier);
      },
    });
    assert.equal(events.length, 2);
    const [configWrite, gatewayLaunch] = events;
    assert.ok(configWrite?.kind === "write" && gatewayLaunch?.kind === "spawn");
    assert.equal(configWrite.path, environment.OPENCLAW_CONFIG_PATH);
    assert.deepEqual(gatewayLaunch.args, [
      "/app/openclaw.mjs",
      "gateway",
      "--port",
      environment.OPENCLAW_GATEWAY_PORT,
    ]);
    assert.equal(gatewayLaunch.env.OPENCLAW_CONFIG_READONLY, "1");
    assert.equal(gatewayLaunch.env.OPENCLAW_DISABLE_GATEWAY_LOCAL_TERMINALS, "1");
    assert.equal(gatewayLaunch.env.OPENCLAW_DISABLE_CRON_HOST_EXECUTION, "1");
    // OCE replaces the Gateway image to upgrade it: OpenClaw runs no update check or
    // install count request of its own (finding 2779).
    assert.equal(gatewayLaunch.env.OPENCLAW_NO_AUTO_UPDATE, "1");
  });
}

export function registerGatewayPolicyCase() {
  test("Docker rejects an invalid dedicated Gateway tool policy before engine access", async () => {
    const driver = dockerDriver();
    let requests = 0;
    installDockerFixture(driver, {
      network: async () => {
        requests += 1;
        return undefined;
      },
    });
    const refusals: [OpenClawConfigurationDocument, RegExp][] = [
      [{ allow: ["plugins"] }, /Gateway administrative tools/],
      [{ allow: ["message"], actions: { message: ["set-profile"] } }, /reviewed task actions/],
      [{ allow: ["automations"] }, /actions.automations must list/],
    ];
    for (const [gatewayPolicy, expected] of refusals) {
      assert.throws(
        () =>
          driver.validateWorkspaceSetup(
            { id: "codex", version: "1.0.0", mode: "dedicated" },
            { tools: { gatewayPolicy } },
          ),
        expected,
        "Agent admission checks policy when initial workspace files are supplied",
      );
      await assert.rejects(
        () =>
          prepareDockerRevision(driver, {
            ...dockerGatewayRevision(driver, { tools: { gatewayPolicy } }),
            harness: {
              id: "codex",
              version: "1.0.0",
              mode: "dedicated",
              overrides: {},
              configuration: {},
            },
          }),
        expected,
      );
    }
    assert.equal(requests, 0);
    await prepareDockerRevision(driver, {
      ...dockerGatewayRevision(driver, { tools: { gatewayPolicy: { allow: [] } } }),
      harness: {
        id: "codex",
        version: "1.0.0",
        mode: "dedicated",
        overrides: {},
        configuration: {},
      },
    });
    assert.equal(requests, 1, "an explicit empty policy is a supported ceiling");
  });
}

async function gatewayContainerLaunch(configuration: OpenClawConfigurationDocument = {}) {
  const driver = dockerDriver();
  const revision = dockerGatewayRevision(driver, configuration);
  const createdContainers: ContainerCreate[] = [];
  installDockerFixture(driver, {
    network: async () => ({ Labels: namespaceLabels }),
    container: async () => {
      const latest = createdContainers.at(-1);
      if (latest === undefined) {
        return undefined;
      }
      return {
        Config: { Labels: latest.Labels },
        State: { Running: true, Health: { Status: "healthy" } },
      };
    },
    request: async (method, path, body) => {
      if (method === "POST" && path.startsWith("/containers/create?")) {
        createdContainers.push(readContainerCreate(structuredClone(body)));
        return "";
      }
      if (method === "POST" && path.startsWith("/containers/") && path.endsWith("/start")) {
        return "";
      }
      throw new Error(`Unexpected Docker API request ${method} ${path}`);
    },
  });
  await withModelKey(async () => {
    assert.deepEqual(await prepareDockerRevision(driver, revision), {
      namespaceId: tenant.id,
      agentId: revision.agentId,
      revisionId: revision.id,
      ready: true,
    });
  });

  assert.equal(createdContainers.length, 1);
  const body = createdContainers[0];
  assert.ok(body);
  const environment: Record<string, string> = Object.fromEntries(body.Env.map(splitEnvironment));
  const config = environment.OPENCLAW_CONFIG_JSON;
  assert.ok(config);
  const gateway = readRecord(readRecord(parseJson(config)).gateway);
  return {
    body,
    environment,
    gateway: { tls: gateway.tls, auth: readRecord(gateway.auth) },
    revision,
  };
}
