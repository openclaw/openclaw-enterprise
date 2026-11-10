import assert from "node:assert/strict";
import type {
  Clock,
  RepositoryBackend,
  RepositoryBackendFactory,
} from "../../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import { createAlternateDriverFactory } from "./alternate.mjs";

export type AlternateFixtureOptions = {
  origin: string;
  gatewayOrigin: string;
  clock: Clock;
  accepted?: Map<string, number>;
  lifetimeMs?: number;
  operationMs?: number;
  controls?: {
    beforeSend?: () => Promise<void>;
    lateCapture?: Promise<void>;
    waitForAcquisitionAbort?: boolean;
    rejectScope?: boolean;
    observe?: (event: unknown) => void;
  };
};

export type AlternateFixtureFactory = RepositoryBackendFactory & {
  events: readonly unknown[];
  drivers: readonly unknown[];
};

export function isBackendFactory(value: unknown): value is RepositoryBackendFactory {
  return (
    typeof value === "object" &&
    value !== null &&
    "create" in value &&
    typeof value.create === "function" &&
    "resolve" in value &&
    typeof value.resolve === "function" &&
    "parseAuthentication" in value &&
    typeof value.parseAuthentication === "function" &&
    "unauthenticated" in value &&
    typeof value.unauthenticated === "function"
  );
}

function isAlternateFixtureFactory(value: unknown): value is AlternateFixtureFactory {
  return (
    isBackendFactory(value) &&
    "events" in value &&
    Array.isArray(value.events) &&
    "drivers" in value &&
    Array.isArray(value.drivers)
  );
}

export function createAlternateFixtureFactory(
  options: AlternateFixtureOptions,
): AlternateFixtureFactory {
  const value: unknown = createAlternateDriverFactory(options);
  assert.ok(isAlternateFixtureFactory(value));
  return value;
}

function hasSettlement(value: unknown): value is Pick<RepositoryBackend, "settle"> {
  return (
    typeof value === "object" &&
    value !== null &&
    "settle" in value &&
    typeof value.settle === "function"
  );
}

export function requireFixtureDriver(value: unknown): Pick<RepositoryBackend, "settle"> {
  assert.ok(hasSettlement(value));
  return value;
}
