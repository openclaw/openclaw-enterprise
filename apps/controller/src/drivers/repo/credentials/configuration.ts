import { isAbsolute, resolve } from "node:path";
import type { ServiceConfig, ServiceLimits } from "./service-contracts.ts";
import { hasControlCharacter } from "./client-contracts.ts";

const defaults: ServiceLimits = Object.freeze({
  sessions: 16,
  credentialSlotsPerSession: 2,
  providerActions: 1,
  providerQueue: 64,
  sockets: 64,
  exchanges: 32,
  exchangesPerSession: 4,
  headerBytes: 32768,
  headerPairs: 64,
  targetBytes: 8192,
  gitFetchInputBytes: 1048576,
  gitPushInputBytes: 268435456,
  gitResponseBytes: 268435456,
  apiInputBytes: 1048576,
  apiResponseBytes: 8388608,
  controlBodyBytes: 16384,
  headerMs: 5000,
  connectMs: 5000,
  stallMs: 5000,
  inputMs: 30000,
  firstHeaderMs: 30000,
  exchangeMs: 300000,
  providerActionMs: 30000,
  shutdownGraceMs: 60000,
  credentialMarginMs: 60000,
  accessTokenBytes: 16384,
  renewalBytesPerSession: 16384,
  privateKeyBytes: 65536,
});
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-configuration");
  }
  return value as Record<string, unknown>;
}
export function string(value: unknown, maximum = 4096): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    hasControlCharacter(value)
  ) {
    throw new Error("invalid-configuration");
  }
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("invalid-configuration");
  }
  return value;
}
function validateGateway(gateway: Record<string, unknown>): ServiceConfig["gateway"] {
  const publicOrigin = string(gateway.publicOrigin, 2048);
  const url = new URL(publicOrigin);
  if (
    url.protocol !== "https:" ||
    url.origin !== publicOrigin ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("invalid-configuration");
  }
  const listen = string(gateway.listen, 256);
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/.exec(listen);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new Error("invalid-configuration");
  }
  const controlSocket = string(gateway.controlSocket, 104);
  if (!isAbsolute(controlSocket) || resolve(controlSocket) !== controlSocket) {
    throw new Error("invalid-configuration");
  }
  return Object.freeze({ publicOrigin, listen, controlSocket });
}

function validateSessionPolicy(policy: Record<string, unknown>): ServiceConfig["sessionPolicy"] {
  const maximumDurationSeconds = positive(policy.maximumDurationSeconds);
  if (maximumDurationSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
    throw new Error("invalid-configuration");
  }
  const defaultProfile = string(policy.defaultProfile, 128);
  if (
    !Array.isArray(policy.allowedProfiles) ||
    policy.allowedProfiles.length < 1 ||
    policy.allowedProfiles.length > 16
  ) {
    throw new Error("invalid-configuration");
  }
  const allowedProfiles = policy.allowedProfiles.map((value) => string(value, 128));
  if (
    new Set(allowedProfiles).size !== allowedProfiles.length ||
    !allowedProfiles.includes(defaultProfile)
  ) {
    throw new Error("invalid-configuration");
  }
  return Object.freeze({
    maximumDurationSeconds,
    defaultProfile,
    allowedProfiles: Object.freeze(allowedProfiles),
  });
}

function validateLimits(value: unknown): ServiceLimits {
  const override = value === undefined ? {} : record(value);
  if (Object.keys(override).some((key) => !Object.hasOwn(defaults, key))) {
    throw new Error("invalid-configuration");
  }
  const limits = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof ServiceLimits)[]) {
    limits[key] = override[key] === undefined ? defaults[key] : positive(override[key]);
  }
  if (
    limits.providerActions !== 1 ||
    limits.credentialSlotsPerSession < 2 ||
    limits.accessTokenBytes > 16384 ||
    limits.privateKeyBytes > 65536 ||
    limits.providerActionMs > 30000
  ) {
    throw new Error("invalid-configuration");
  }
  return Object.freeze(limits);
}

export function validateServiceConfig(input: unknown): ServiceConfig {
  const root = record(input);
  const gateway = record(root.gateway);
  const policy = record(root.sessionPolicy);
  if (
    Object.keys(root).some(
      (key) => !["gateway", "sessionPolicy", "limits", "backend"].includes(key),
    ) ||
    Object.keys(gateway).some(
      (key) =>
        !["publicOrigin", "listen", "controlSocket", "tlsCertFile", "tlsKeyFile"].includes(key),
    ) ||
    Object.keys(policy).some(
      (key) => !["maximumDurationSeconds", "defaultProfile", "allowedProfiles"].includes(key),
    )
  ) {
    throw new Error("invalid-configuration");
  }
  return Object.freeze({
    gateway: validateGateway(gateway),
    sessionPolicy: validateSessionPolicy(policy),
    limits: validateLimits(root.limits),
  });
}
