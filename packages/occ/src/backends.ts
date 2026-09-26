import { isAbsolute } from "node:path";
import type { Driver, BackendDefinition, BackendRef } from "@openclaw-enterprise/contracts";
import { asRecord, deepFreeze, isNonEmptyString } from "@openclaw-enterprise/utils";
import { DriverSelectionError, ResourceConflictError, ScopeViolationError } from "./errors.ts";

const BACKEND_ID = /^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).{1,200}$/;
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CHATGPT_CREDENTIAL_TTL_SECONDS = 30 * 24 * 60 * 60;

type BackendMap = ReadonlyMap<string, BackendDefinition>;

function path(value: string, key: string): string {
  return `backend[${value}].${key}`;
}

function backendId(value: unknown, label = "Backend ID"): string {
  if (typeof value !== "string" || !BACKEND_ID.test(value)) {
    throw new ScopeViolationError(`${label} must be a nonempty string.`);
  }
  return value;
}

function validateBackendDefinition(value: unknown, index: number): BackendDefinition {
  const candidate = asRecord(value);
  if (candidate === undefined) {
    throw new ScopeViolationError(`backend[${index}] must be one object.`);
  }
  for (const key of Object.keys(candidate)) {
    if (!["id", "type", "configuration", "drivers"].includes(key)) {
      throw new ScopeViolationError(`backend[${index}] contains unsupported option ${key}.`);
    }
  }
  const id = backendId(candidate.id, `backend[${index}].id`);
  if (candidate.type !== "chatgpt" && candidate.type !== "github") {
    throw new ScopeViolationError(path(id, "type") + " must be chatgpt or github.");
  }

  const configuration = asRecord(candidate.configuration);
  if (configuration === undefined) {
    throw new ScopeViolationError(path(id, "configuration") + " must be one object.");
  }
  const drivers = asRecord(candidate.drivers);
  if (drivers === undefined) {
    throw new ScopeViolationError(path(id, "drivers") + " must be one object.");
  }
  if (candidate.type === "github") {
    for (const key of Object.keys(configuration)) {
      if (key !== "registryPath") {
        throw new ScopeViolationError(path(id, `configuration.${key}`) + " is unsupported.");
      }
    }
    const registryPath = configuration.registryPath;
    if (!isNonEmptyString(registryPath) || !isAbsolute(registryPath)) {
      throw new ScopeViolationError(
        path(id, "configuration.registryPath") + " must be an absolute mounted file path.",
      );
    }
    for (const key of Object.keys(drivers)) {
      if (key !== "repo") {
        throw new ScopeViolationError(path(id, `drivers.${key}`) + " is unsupported.");
      }
    }
    const repo = drivers.repo;
    if (!isNonEmptyString(repo)) {
      throw new ScopeViolationError(path(id, "drivers.repo") + " is required.");
    }
    return deepFreeze({
      id,
      type: "github",
      configuration: { registryPath },
      drivers: { repo },
    });
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

  for (const key of Object.keys(drivers)) {
    if (key !== "service_account") {
      throw new ScopeViolationError(path(id, `drivers.${key}`) + " is unsupported.");
    }
  }
  const serviceAccount = drivers.service_account;
  if (!isNonEmptyString(serviceAccount)) {
    throw new ScopeViolationError(path(id, "drivers.service_account") + " is required.");
  }

  return deepFreeze({
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

export function validateBackendDefinitions(value: unknown = []): readonly BackendDefinition[] {
  if (!Array.isArray(value)) {
    throw new ScopeViolationError("backend must be an array.");
  }
  const backends = value.map((entry, index) => validateBackendDefinition(entry, index));
  const ids = new Set<string>();
  const members = new Set<string>();
  for (const backend of backends) {
    if (ids.has(backend.id)) {
      throw new ScopeViolationError("Backend IDs must be unique.");
    }
    ids.add(backend.id);
    const member =
      backend.type === "chatgpt"
        ? `service_account:${backend.drivers.service_account}`
        : `repo:${backend.drivers.repo}`;
    if (members.has(member)) {
      throw new ScopeViolationError(
        backend.type === "chatgpt"
          ? "A ServiceAccount Driver cannot belong to multiple Backends."
          : "A repository credential Driver cannot belong to multiple Backends.",
      );
    }
    members.add(member);
  }
  if (backends.filter((backend) => backend.type === "chatgpt").length > 1) {
    throw new ScopeViolationError("Only one bundled ChatGPT Backend can be configured.");
  }
  if (backends.filter((backend) => backend.type === "github").length > 1) {
    throw new ScopeViolationError("Only one bundled GitHub Backend can be configured.");
  }
  return Object.freeze(backends);
}

export function backendDefinitionMap(backends: readonly BackendDefinition[]): BackendMap {
  return new Map(validateBackendDefinitions(backends).map((backend) => [backend.id, backend]));
}

export function assertConfiguredBackend(
  backends: BackendMap,
  value: string | null,
  label = "Backend",
): BackendDefinition | undefined {
  if (value === null) {
    return undefined;
  }
  const id = backendId(value, label);
  const backend = backends.get(id);
  if (backend === undefined) {
    throw new ScopeViolationError(`${label} does not match a configured Backend.`);
  }
  return backend;
}

export function validateSelectedBackendDrivers(
  backends: readonly BackendDefinition[],
  selectedServiceAccountDriver: Driver | undefined,
  selectedRepoDriver?: Driver,
): void {
  for (const backend of backends) {
    if (backend.type === "github") {
      if (
        selectedRepoDriver?.capability !== "repo" ||
        selectedRepoDriver.id !== backend.drivers.repo
      ) {
        throw new DriverSelectionError(
          "The configured Backend requires its repository credential Driver.",
        );
      }
      continue;
    }
    if (
      selectedServiceAccountDriver?.capability !== "service_account" ||
      selectedServiceAccountDriver.id !== backend.drivers.service_account
    ) {
      throw new DriverSelectionError("The configured Backend requires its ServiceAccount Driver.");
    }
  }
}

export function validateServiceAccountBackendBinding(
  backends: BackendMap,
  backendIdValue: string | null,
  binding:
    | Readonly<{
        readonly backendId: string;
        readonly driverId: string;
        readonly workspaceId: string;
        readonly credentialIssued: boolean;
      }>
    | undefined,
): void {
  const backend = assertConfiguredBackend(backends, backendIdValue, "Agent Backend");
  if (backend === undefined || backend.type !== "chatgpt" || binding === undefined) {
    throw new ResourceConflictError(
      "The managed ServiceAccount credential has no Backend binding.",
    );
  }
  if (
    binding.backendId !== backend.id ||
    binding.driverId !== backend.drivers.service_account ||
    binding.workspaceId !== backend.configuration.workspaceId ||
    !binding.credentialIssued
  ) {
    throw new ResourceConflictError(
      "The managed ServiceAccount credential does not match its Backend.",
    );
  }
}
