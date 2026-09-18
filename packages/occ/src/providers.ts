import { isAbsolute } from "node:path";
import type { Driver, ProviderDefinition, ProviderRef } from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import { DriverSelectionError, ResourceConflictError, ScopeViolationError } from "./errors.ts";

const PROVIDER_ID = /^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).{1,200}$/;
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CHATGPT_CREDENTIAL_TTL_SECONDS = 30 * 24 * 60 * 60;

type ProviderMap = ReadonlyMap<string, ProviderDefinition>;

function path(value: string, key: string): string {
  return `provider[${value}].${key}`;
}

function providerId(value: unknown, label = "Provider ID"): string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) {
    throw new ScopeViolationError(`${label} must be a nonempty string.`);
  }
  return value;
}

function validateProviderDefinition(value: unknown, index: number): ProviderDefinition {
  const candidate = asRecord(value);
  if (candidate === undefined) {
    throw new ScopeViolationError(`provider[${index}] must be one object.`);
  }
  for (const key of Object.keys(candidate)) {
    if (!["id", "type", "configuration", "drivers"].includes(key)) {
      throw new ScopeViolationError(`provider[${index}] contains unsupported option ${key}.`);
    }
  }
  const id = providerId(candidate.id, `provider[${index}].id`);
  if (candidate.type !== "chatgpt") {
    throw new ScopeViolationError(path(id, "type") + " must be chatgpt.");
  }

  const configuration = asRecord(candidate.configuration);
  if (configuration === undefined) {
    throw new ScopeViolationError(path(id, "configuration") + " must be one object.");
  }
  for (const key of Object.keys(configuration)) {
    if (!["workspaceId", "apiKeyPath", "credentialTtlSeconds"].includes(key)) {
      throw new ScopeViolationError(path(id, `configuration.${key}`) + " is unsupported.");
    }
  }
  const workspaceId = configuration.workspaceId;
  if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) {
    throw new ScopeViolationError(path(id, "configuration.workspaceId") + " is invalid.");
  }
  const apiKeyPath = configuration.apiKeyPath;
  if (typeof apiKeyPath !== "string" || apiKeyPath.trim().length === 0 || !isAbsolute(apiKeyPath)) {
    throw new ScopeViolationError(
      path(id, "configuration.apiKeyPath") + " must be an absolute mounted file path.",
    );
  }
  const credentialTtlSeconds = configuration.credentialTtlSeconds;
  if (
    credentialTtlSeconds !== undefined &&
    (!Number.isSafeInteger(credentialTtlSeconds) ||
      (credentialTtlSeconds as number) < 1 ||
      (credentialTtlSeconds as number) > MAX_CHATGPT_CREDENTIAL_TTL_SECONDS)
  ) {
    throw new ScopeViolationError(
      path(id, "configuration.credentialTtlSeconds") + " must be between 1 and 2592000.",
    );
  }

  const drivers = asRecord(candidate.drivers);
  if (drivers === undefined) {
    throw new ScopeViolationError(path(id, "drivers") + " must be one object.");
  }
  for (const key of Object.keys(drivers)) {
    if (key !== "service_account") {
      throw new ScopeViolationError(path(id, `drivers.${key}`) + " is unsupported.");
    }
  }
  const serviceAccount = drivers.service_account;
  if (!isNonEmptyString(serviceAccount)) {
    throw new ScopeViolationError(path(id, "drivers.service_account") + " is required.");
  }

  return immutableCopy({
    id,
    type: "chatgpt",
    configuration: {
      workspaceId,
      apiKeyPath,
      ...(credentialTtlSeconds === undefined
        ? {}
        : { credentialTtlSeconds: credentialTtlSeconds as number }),
    },
    drivers: { service_account: serviceAccount },
  });
}

export function validateProviderDefinitions(value: unknown = []): readonly ProviderDefinition[] {
  if (!Array.isArray(value)) {
    throw new ScopeViolationError("provider must be an array.");
  }
  const providers = value.map((entry, index) => validateProviderDefinition(entry, index));
  const ids = new Set<string>();
  const serviceAccountDrivers = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.id)) {
      throw new ScopeViolationError("Provider IDs must be unique.");
    }
    ids.add(provider.id);
    const driverId = provider.drivers.service_account;
    if (serviceAccountDrivers.has(driverId)) {
      throw new ScopeViolationError("A ServiceAccount Driver cannot belong to multiple Providers.");
    }
    serviceAccountDrivers.add(driverId);
  }
  if (providers.filter((provider) => provider.type === "chatgpt").length > 1) {
    throw new ScopeViolationError("Only one bundled ChatGPT Provider can be configured.");
  }
  return Object.freeze(providers);
}

export function providerDefinitionMap(providers: readonly ProviderDefinition[]): ProviderMap {
  return new Map(validateProviderDefinitions(providers).map((provider) => [provider.id, provider]));
}

export function assertConfiguredProvider(
  providers: ProviderMap,
  value: string | null,
  label = "Provider",
): ProviderDefinition | undefined {
  if (value === null) {
    return undefined;
  }
  const id = providerId(value, label);
  const provider = providers.get(id);
  if (provider === undefined) {
    throw new ScopeViolationError(`${label} does not match a configured Provider.`);
  }
  return provider;
}

export function validateSelectedProviderDrivers(
  providers: readonly ProviderDefinition[],
  selectedServiceAccountDriver: Driver | undefined,
): void {
  for (const provider of providers) {
    if (
      selectedServiceAccountDriver === undefined ||
      selectedServiceAccountDriver.id !== provider.drivers.service_account
    ) {
      throw new DriverSelectionError("The configured Provider requires its ServiceAccount Driver.");
    }
  }
}

export function validateServiceAccountProviderBinding(
  providers: ProviderMap,
  providerIdValue: string | null,
  binding:
    | Readonly<{
        readonly providerId: string;
        readonly driverId: string;
        readonly workspaceId: string;
        readonly credentialIssued: boolean;
      }>
    | undefined,
): void {
  const provider = assertConfiguredProvider(providers, providerIdValue, "Agent Provider");
  if (provider === undefined || binding === undefined) {
    throw new ResourceConflictError(
      "The managed ServiceAccount credential has no Provider binding.",
    );
  }
  if (
    binding.providerId !== provider.id ||
    binding.driverId !== provider.drivers.service_account ||
    binding.workspaceId !== provider.configuration.workspaceId ||
    !binding.credentialIssued
  ) {
    throw new ResourceConflictError(
      "The managed ServiceAccount credential does not match its Provider.",
    );
  }
}
