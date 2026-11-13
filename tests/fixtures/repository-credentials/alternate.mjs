import { createHash } from "node:crypto";
import { createServer } from "node:https";
import { createTlsMaterial, listen } from "./process.mjs";
import { createAlternateDriver } from "./alternate/driver.ts";
import { createAlternateUpstreamHandler } from "./alternate/upstream.ts";
import { denied, resolveAlternateProfile } from "./alternate/policy.ts";

/** @param {string} bytes */
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * @param {Pick<import("node:test").TestContext, "after">} t
 * @param {{ tls?: Awaited<ReturnType<typeof createTlsMaterial>>,
 *   clock?: Pick<import("../../../apps/controller/src/drivers/repo/access/backend-contracts.ts").Clock, "wallNow">,
 *   controls?: { beforeWriteChunk?: () => void | Promise<void> } }} options
 */
export async function startAlternateUpstream(
  t,
  { tls, clock = { wallNow: Date.now }, controls = {} } = {},
) {
  tls ??= await createTlsMaterial(t);
  /** @type {Map<string, number>} */
  const accepted = new Map();
  /** @type {import("./alternate/upstream.ts").AlternateTraceEntry[]} */
  const trace = [];
  const handleRequest = createAlternateUpstreamHandler({
    authorize: (key) =>
      typeof key === "string" && !((accepted.get(digest(key)) ?? 0) <= clock.wallNow()),
    observe: (entry) => trace.push(entry),
    beforeWriteChunk: () => controls.beforeWriteChunk?.(),
    revision: () => trace.length,
  });
  const server = createServer(tls, handleRequest);
  return { origin: await listen(t, server), tls, trace, accepted };
}

// This adapter intentionally uses a different identity, permission vocabulary,
// authentication header and rotation model. Custody, leases and dispatch are
// supplied by the production common owner, never reimplemented here.
/**
 * @param {Pick<import("./alternate/driver.ts").AlternateDriverOptions, "origin" | "clock"> &
 *   Partial<Pick<import("./alternate/driver.ts").AlternateDriverOptions,
 *     "accepted" | "lifetimeMs" | "operationMs" | "controls">> & { gatewayOrigin: string }} options
 */
export function createAlternateDriverFactory({
  origin,
  gatewayOrigin,
  clock,
  accepted = new Map(),
  lifetimeMs = 90000,
  operationMs = 1000,
  controls = {},
}) {
  const binding = Object.freeze({
    providerInstanceId: "forge-fixture",
    repositoryId: "repo:team/nested/project",
    grantId: "forge-config-v7:source-update",
  });
  /** @type {import("./alternate/driver.ts").AlternateDriverEvent[]} */
  const events = [];
  /** @type {import("../../../apps/controller/src/drivers/repo/access/backend-contracts.ts").RepositoryBackend[]} */
  const drivers = [];
  /** @satisfies {import("../../../apps/controller/src/drivers/repo/access/backend-contracts.ts").RepositoryBackendFactory & { events: typeof events, drivers: typeof drivers }} */
  const factory = {
    events,
    drivers,
    resolve(profile) {
      return resolveAlternateProfile(profile, { binding, gatewayOrigin });
    },
    parseAuthentication(_head, authorization) {
      return authorization.startsWith("Bearer ") ? authorization.slice(7) : denied;
    },
    unauthenticated() {
      return denied;
    },
    create({ authority, custody }) {
      const driver = createAlternateDriver({
        binding,
        authority,
        custody,
        origin,
        clock,
        accepted,
        lifetimeMs,
        operationMs,
        controls,
        events,
      });
      drivers.push(driver);
      return driver;
    },
  };
  return Object.freeze(factory);
}
