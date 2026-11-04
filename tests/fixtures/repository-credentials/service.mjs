import { join } from "node:path";
import { appModule } from "./runtime.mjs";
import { chmod } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request } from "node:https";
import { createControlledClock } from "./clock.mjs";
import { createTlsMaterial } from "./process.mjs";
import { startGitHubFixture } from "./github.mjs";
import { startGitSmartHttpFixture } from "./git.mjs";
import { createResourceScope, createTestResourceScope } from "./resources.mjs";
import { socketDirectory } from "../../helpers/socket-directory.mjs";
import { waitFor } from "../../helpers/wait-for.mjs";
import { serviceConfigurationData } from "./builders.mjs";
import { startStaticTokenService, writeSessionClientConfiguration } from "./service-resources.mjs";

export {
  appModule,
  appRoot,
  appExtension,
  credentialDriverModule,
  githubProviderModule,
  credentialClientPath,
  repositoryRoot,
} from "./runtime.mjs";

export async function createServiceConfiguration(
  t,
  limits = {},
  sessionPolicy = { maximumDurationSeconds: 172800 },
) {
  const { validateServiceConfig } = await appModule("drivers/repo/credentials/configuration");
  const directory = await socketDirectory(t, "rcs-");
  await chmod(directory, 0o700);
  return validateServiceConfig(
    serviceConfigurationData({
      gateway: {
        publicOrigin: "https://credentials.example.test",
        listen: "0.0.0.0:443",
        controlSocket: join(directory, "control.sock"),
      },
      sessionPolicy,
      limits,
    }),
  );
}

/** createServiceConfiguration with the gateway on an ephemeral loopback port. */
export async function createLoopbackServiceConfiguration(owner, limits) {
  const base = await createServiceConfiguration(owner, limits);
  return { ...base, gateway: { ...base.gateway, listen: "127.0.0.1:0" } };
}

/**
 * The shared setup of the token service suites: a resource scope that closes after `t`, a
 * clock (controlled, or `"system"`, or the caller's), TLS material, a loopback service
 * configuration with `limits`, and the fake GitHub unless `github` is false. Each step
 * registers its cleanup on the scope in this order, so teardown runs in reverse.
 */
export async function startTokenServiceScope(t, { clock, limits, github = true } = {}) {
  const resources = createTestResourceScope(t);
  const selectedClock =
    clock === "system"
      ? (await appModule("drivers/repo/credentials/clock")).createSystemClock()
      : (clock ?? createControlledClock());
  const tls = await createTlsMaterial(resources);
  const config = await createLoopbackServiceConfiguration(resources, limits);
  const fakeGitHub = github
    ? await startGitHubFixture(resources, { clock: selectedClock, tls })
    : undefined;
  return { resources, clock: selectedClock, tls, config, github: fakeGitHub };
}

export async function startCredentialServiceFixture(t, options = {}) {
  const resources = createResourceScope();
  try {
    const clock = options.clock ?? createControlledClock();
    const tls = options.tls ?? (await createTlsMaterial(resources));
    const configured = await createServiceConfiguration(
      resources,
      { gitPushInputBytes: 64 * 1024 * 1024, ...options.limits },
      { maximumDurationSeconds: 28_800 },
    );
    const config =
      options.gateway === undefined
        ? configured
        : { ...configured, gateway: { ...configured.gateway, ...options.gateway } };
    const github = await startGitHubFixture(resources, { clock, tls });
    const git = await startGitSmartHttpFixture(resources, { authorize: github.authorize, tls });
    const { factory, service, listeners } = await startStaticTokenService(resources, {
      config,
      clock,
      tls,
      github,
      gitOrigin: git.origin,
      token: `github_pat_${"t".repeat(36)}`,
      configuration: { pushRefAllowlist: ["refs/heads/agent-feature"], ...options.configuration },
    });
    const opened = service.open({ durationSeconds: 3600, profile: options.profile ?? "git-full" });
    const clientDirectory = await writeSessionClientConfiguration(resources, {
      opened,
      ca: tls.ca,
    });
    t.after(() => resources.close());
    return {
      clock,
      tls,
      config,
      factory,
      service,
      listeners,
      opened,
      clientDirectory,
      github,
      git,
    };
  } catch (error) {
    await resources.close(error);
  }
}

export function gatewayRequest(fixture, target, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: fixture.listeners.address.port,
        path: target,
        method,
        ca: fixture.tls.ca,
        headers: {
          host: new URL(fixture.config.gateway.publicOrigin).host,
          authorization: `Bearer ${fixture.opened.bearer}`,
          ...(encoded
            ? { "content-type": "application/json", "content-length": encoded.length }
            : {}),
          ...headers,
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.once("end", () =>
          resolve({
            status: incoming.statusCode,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        incoming.once("error", reject);
      },
    );
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error("fixture request timeout")));
    outgoing.once("error", reject);
    outgoing.end(encoded);
  });
}

/**
 * One JSON request to the service's Unix-socket control API. `value` is the JSON body (none
 * when undefined); `headers` adds or replaces headers, such as x-admission-id. Resolves to
 * `{ status, body }` with the parsed JSON answer.
 */
export function controlRequest(socketPath, method, path, value, headers = {}) {
  const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        socketPath,
        method,
        path,
        agent: false,
        headers: {
          host: "localhost",
          "content-type": "application/json",
          "content-length": body.length,
          ...headers,
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("end", () => {
          try {
            resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
          } catch (error) {
            // A non-JSON answer rejects the request instead of throwing from the stream.
            reject(error);
          }
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

// Polls `check` every 10 ms until it returns a truthy value, and returns that value.
export function eventually(
  check,
  { timeoutMs = 3000, description = "the expected fixture state" } = {},
) {
  return waitFor(description, () => check() || undefined, { timeoutMs, intervalMs: 10 });
}
