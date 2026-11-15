import { createHash } from "node:crypto";
import { createServer } from "node:https";
import type {
  Clock,
  RepositoryBackend,
  RepositoryBackendFactory,
} from "../../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import type { FixtureOwner } from "./registry/material.ts";
import { createTlsMaterial, listen } from "./process.mjs";
import {
  createAlternateDriver,
  type AlternateDriverEvent,
  type AlternateDriverOptions,
} from "./alternate/driver.ts";
import { createAlternateUpstreamHandler, type AlternateTraceEntry } from "./alternate/upstream.ts";
import { denied, resolveAlternateProfile } from "./alternate/policy.ts";

const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

type AlternateUpstreamOptions = {
  tls?: Awaited<ReturnType<typeof createTlsMaterial>>;
  clock?: Pick<Clock, "wallNow">;
  controls?: { beforeWriteChunk?: () => void | Promise<void> };
};

export async function startAlternateUpstream(
  t: FixtureOwner,
  { tls, clock = { wallNow: Date.now }, controls = {} }: AlternateUpstreamOptions = {},
) {
  tls ??= await createTlsMaterial(t);
  const accepted = new Map<string, number>();
  const trace: AlternateTraceEntry[] = [];
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

type AlternateFactoryOptions = Pick<AlternateDriverOptions, "origin" | "clock"> &
  Partial<Pick<AlternateDriverOptions, "accepted" | "lifetimeMs" | "operationMs" | "controls">> & {
    gatewayOrigin: string;
  };

// This adapter intentionally uses a different identity, permission vocabulary,
// authentication header and rotation model. Custody, leases and dispatch are
// supplied by the production common owner, never reimplemented here.
export function createAlternateDriverFactory({
  origin,
  gatewayOrigin,
  clock,
  accepted = new Map<string, number>(),
  lifetimeMs = 90000,
  operationMs = 1000,
  controls = {},
}: AlternateFactoryOptions) {
  const binding = Object.freeze({
    providerInstanceId: "forge-fixture",
    repositoryId: "repo:team/nested/project",
    grantId: "forge-config-v7:source-update",
  });
  const events: AlternateDriverEvent[] = [];
  const drivers: RepositoryBackend[] = [];
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
  } satisfies RepositoryBackendFactory & { events: typeof events; drivers: typeof drivers };
  return Object.freeze(factory);
}
