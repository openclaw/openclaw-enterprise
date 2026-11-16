import { join } from "node:path";
import { chmod } from "node:fs/promises";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from "node:http";
import { request } from "node:https";
import { createControlledClock } from "./clock.mjs";
import { createTlsMaterial } from "./process.mjs";
import { startGitHubFixture } from "./github.ts";
import { startGitSmartHttpFixture } from "./git.mjs";
import { createResourceScope, createTestResourceScope, type FixtureOwner } from "./resources.ts";
import { socketDirectory } from "../../helpers/socket-directory.ts";
import { waitFor } from "../../helpers/wait-for.ts";
import { serviceConfigurationData } from "./builders.ts";
import { startStaticTokenService, writeSessionClientConfiguration } from "./service-resources.ts";

import type { Clock } from "../../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import type {
  ServiceConfig,
  ServiceLimits,
} from "../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import { appFunction } from "./app-functions.ts";

type ControlledClock = ReturnType<typeof createControlledClock>;
type TlsMaterial = Awaited<ReturnType<typeof createTlsMaterial>>;
type TokenConfiguration = NonNullable<
  Parameters<typeof startStaticTokenService>[1]["configuration"]
>;

export function validateFixtureServiceConfiguration(
  validateServiceConfig: typeof import("../../../apps/controller/src/drivers/repo/access/configuration.ts").validateServiceConfig,
  directory: string,
  {
    limits,
    sessionPolicy,
  }: {
    limits?: Partial<ServiceLimits> | undefined;
    sessionPolicy: Pick<ServiceConfig["sessionPolicy"], "maximumDurationSeconds">;
  },
  gateway?: Partial<ServiceConfig["gateway"]>,
) {
  const configured = validateServiceConfig(
    serviceConfigurationData({
      gateway: {
        publicOrigin: "https://credentials.example.test",
        listen: "0.0.0.0:443",
        controlSocket: join(directory, "control.sock"),
      },
      sessionPolicy,
      ...(limits === undefined ? {} : { limits }),
    }),
  );
  // Test listeners may request a kernel-assigned port after production validation.
  return gateway === undefined
    ? configured
    : { ...configured, gateway: { ...configured.gateway, ...gateway } };
}

export async function createServiceConfiguration(
  t: FixtureOwner,
  limits: Partial<ServiceLimits> = {},
  sessionPolicy = { maximumDurationSeconds: 172800 },
  gateway?: Partial<ServiceConfig["gateway"]>,
) {
  const validateServiceConfig = await appFunction(
    "drivers/repo/access/configuration",
    "validateServiceConfig",
  );
  const directory = await socketDirectory(t, "rcs-");
  await chmod(directory, 0o700);
  return validateFixtureServiceConfiguration(
    validateServiceConfig,
    directory,
    { limits, sessionPolicy },
    gateway,
  );
}

/** createServiceConfiguration with the gateway on an ephemeral loopback port. */
export async function createLoopbackServiceConfiguration(
  owner: FixtureOwner,
  limits?: Partial<ServiceLimits>,
) {
  const base = await createServiceConfiguration(owner, limits);
  return { ...base, gateway: { ...base.gateway, listen: "127.0.0.1:0" } };
}

/**
 * The shared setup of the token service suites: a resource scope that closes after `t`, a
 * clock (controlled, or `"system"`, or the caller's), TLS material, a loopback service
 * configuration with `limits`, and the fake GitHub unless `github` is false. Each step
 * registers its cleanup on the scope in this order, so teardown runs in reverse.
 */
type TokenScopeOptions = {
  clock?: Clock | "system" | undefined;
  limits?: Partial<ServiceLimits>;
  github?: boolean;
};
type TokenScope<C extends Clock> = {
  resources: ReturnType<typeof createTestResourceScope>;
  clock: C;
  tls: TlsMaterial;
  config: ServiceConfig;
  github: Awaited<ReturnType<typeof startGitHubFixture>> | undefined;
};

export function startTokenServiceScope(
  t: FixtureOwner,
  options?: TokenScopeOptions & { clock?: undefined },
): Promise<TokenScope<ControlledClock>>;
export function startTokenServiceScope<C extends Clock>(
  t: FixtureOwner,
  options: TokenScopeOptions & { clock: C },
): Promise<TokenScope<C>>;
export function startTokenServiceScope(
  t: FixtureOwner,
  options: TokenScopeOptions,
): Promise<TokenScope<Clock>>;
export async function startTokenServiceScope(
  t: FixtureOwner,
  { clock, limits, github = true }: TokenScopeOptions = {},
): Promise<TokenScope<Clock>> {
  const resources = createTestResourceScope(t);
  const selectedClock =
    clock === "system"
      ? (await appFunction("drivers/repo/access/clock", "createSystemClock"))()
      : (clock ?? createControlledClock());
  const tls = await createTlsMaterial(resources);
  const config = await createLoopbackServiceConfiguration(resources, limits);
  const fakeGitHub = github
    ? await startGitHubFixture(resources, { clock: selectedClock, tls })
    : undefined;
  return { resources, clock: selectedClock, tls, config, github: fakeGitHub };
}

type ServiceFixtureOptions<C extends Clock> = {
  clock?: C | undefined;
  tls?: TlsMaterial;
  limits?: Partial<ServiceLimits>;
  gateway?: Partial<ServiceConfig["gateway"]>;
  configuration?: TokenConfiguration;
  profile?: string;
};

type ServiceFixture<C extends Clock> = Awaited<ReturnType<typeof startServiceFixture<C>>> & {
  clock: C;
};

export type DefaultServiceFixture = ServiceFixture<ControlledClock>;

export function startCredentialServiceFixture(
  t: FixtureOwner,
  options?: ServiceFixtureOptions<Clock> & { clock?: undefined },
): Promise<DefaultServiceFixture>;
export function startCredentialServiceFixture<C extends Clock>(
  t: FixtureOwner,
  options: ServiceFixtureOptions<C> & { clock: C },
): Promise<ServiceFixture<C>>;
export function startCredentialServiceFixture(
  t: FixtureOwner,
  options: ServiceFixtureOptions<Clock>,
): Promise<ServiceFixture<Clock>>;
export function startCredentialServiceFixture(
  t: FixtureOwner,
  options: ServiceFixtureOptions<Clock> = {},
) {
  return startServiceFixture(t, options);
}

async function startServiceFixture<C extends Clock>(
  t: FixtureOwner,
  options: ServiceFixtureOptions<C>,
) {
  const resources = createResourceScope();
  try {
    const clock = options.clock ?? createControlledClock();
    const tls = options.tls ?? (await createTlsMaterial(resources));
    const config = await createServiceConfiguration(
      resources,
      { gitPushInputBytes: 64 * 1024 * 1024, ...options.limits },
      { maximumDurationSeconds: 28_800 },
      options.gateway,
    );
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
    throw error;
  }
}

type GatewayFixture = {
  listeners: { address: { port: number } };
  tls: Pick<TlsMaterial, "ca">;
  config: Pick<ServiceConfig, "gateway">;
  opened: { bearer: string };
};
type GatewayRequestOptions = { method?: string; body?: unknown; headers?: OutgoingHttpHeaders };

export function gatewayRequest(
  fixture: GatewayFixture,
  target: string,
  { method = "GET", body, headers = {} }: GatewayRequestOptions = {},
) {
  return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject: (reason: unknown) => void) => {
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
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
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
    },
  );
}

/**
 * One JSON request to the service's Unix-socket control API. `value` is the JSON body (none
 * when undefined); `headers` adds or replaces headers, such as x-admission-id. Resolves to
 * `{ status, body }` with the parsed JSON answer.
 */
export function controlRequest(
  socketPath: string,
  method: string,
  path: string,
  value?: unknown,
  headers: OutgoingHttpHeaders = {},
) {
  const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
  return new Promise<{ status: number | undefined; body: unknown }>(
    (resolve, reject: (reason: unknown) => void) => {
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
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.once("error", reject);
          incoming.once("end", () => {
            try {
              const answer: unknown = JSON.parse(Buffer.concat(chunks).toString());
              resolve({ status: incoming.statusCode, body: answer });
            } catch (error) {
              // A non-JSON answer rejects the request instead of throwing from the stream.
              reject(error);
            }
          });
        },
      );
      outgoing.once("error", reject);
      outgoing.end(body);
    },
  );
}

// Polls `check` every 10 ms until it returns a truthy value, and returns that value.
export function eventually<T>(
  check: () => T | undefined,
  {
    timeoutMs = 3000,
    description = "the expected fixture state",
  }: { timeoutMs?: number; description?: string } = {},
) {
  return waitFor(description, () => check() || undefined, { timeoutMs, intervalMs: 10 });
}
