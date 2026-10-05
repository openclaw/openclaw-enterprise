import { join } from "node:path";
import { appModule } from "./runtime.mjs";
import { chmod } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request } from "node:https";
import { createControlledClock } from "./clock.mjs";
import { createTlsMaterial, temporaryDirectory } from "./process.mjs";
import { startGitHubFixture } from "./github.mjs";
import { startGitSmartHttpFixture } from "./git.mjs";
import { createResourceScope } from "./resources.mjs";
import { serviceConfigurationData } from "./builders.mjs";
import {
  createGitHubServiceFactory,
  startServiceListeners,
  writeSessionClientConfiguration,
} from "./service-resources.mjs";

export {
  appModule,
  appRoot,
  appExtension,
  credentialDriverModule,
  githubProviderModule,
  credentialClientPath,
  repositoryRoot,
} from "./runtime.mjs";

export async function createServiceConfiguration(t, limits = {}) {
  const { validateServiceConfig } = await appModule("drivers/repo/credentials/configuration");
  const directory = await temporaryDirectory(t, "rcs-");
  await chmod(directory, 0o700);
  return validateServiceConfig(
    serviceConfigurationData({
      gateway: {
        publicOrigin: "https://credentials.example.test",
        listen: "0.0.0.0:443",
        controlSocket: join(directory, "control.sock"),
      },
      sessionPolicy: { maximumDurationSeconds: 172800 },
      limits,
    }),
  );
}

export async function startCredentialServiceFixture(t, options = {}) {
  const resources = createResourceScope();
  try {
    const clock = options.clock ?? createControlledClock();
    const tls = await createTlsMaterial(resources);
    const configured = await createServiceConfiguration(resources, options.limits);
    const config =
      options.gateway === undefined
        ? configured
        : { ...configured, gateway: { ...configured.gateway, ...options.gateway } };
    const github = await startGitHubFixture(resources, {
      clock,
      tls,
      tokenLifetimeMs: options.tokenLifetimeMs,
    });
    const git = await startGitSmartHttpFixture(resources, { authorize: github.authorize, tls });
    const factory = await createGitHubServiceFactory(resources, {
      config,
      clock,
      privateKey: github.privateKey,
      trustedEndpoints: { apiOrigin: github.origin, gitOrigin: git.origin, ca: tls.ca },
    });
    const { service, listeners } = await startServiceListeners(resources, {
      config,
      factory,
      clock,
      tls,
      upstreamOrigins: [github.origin, git.origin],
    });
    const opened = service.open({ durationSeconds: 86400, profile: options.profile ?? "git-full" });
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

export async function eventually(
  check,
  { timeoutMs = 3000, message = "expected fixture state was not observed" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
