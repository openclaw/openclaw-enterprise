import type {
  BackendDefinitionValidator,
  GitLabRepositoryCredentialBackendDefinition,
} from "@openclaw-enterprise/contracts";
import { ScopeViolationError } from "@openclaw-enterprise/occ";
import { asRecord, deepFreeze, isNonEmptyString } from "@openclaw-enterprise/utils";
import { BACKEND_ID_MAX_CHARACTERS, isBackendId } from "@openclaw-enterprise/contracts";
import { isAbsolute, resolve } from "node:path";

/** GitLab configuration belongs to the Repo owner, independently of platform validation. */
export const gitLabBackendDefinitionValidator: BackendDefinitionValidator = Object.freeze({
  type: "gitlab",
  validate(value: unknown): GitLabRepositoryCredentialBackendDefinition {
    const input = asRecord(value);
    const configuration = asRecord(input?.configuration);
    const drivers = asRecord(input?.drivers);
    if (
      !input ||
      input.type !== "gitlab" ||
      !isBackendId(input.id) ||
      input.id.length > BACKEND_ID_MAX_CHARACTERS ||
      Object.keys(input).some((key) => !["id", "type", "configuration", "drivers"].includes(key)) ||
      !configuration ||
      Object.keys(configuration).some((key) => key !== "registryPath") ||
      typeof configuration.registryPath !== "string" ||
      !isAbsolute(configuration.registryPath) ||
      resolve(configuration.registryPath) !== configuration.registryPath ||
      configuration.registryPath.length > 4096 ||
      configuration.registryPath.includes("\0") ||
      !drivers ||
      Object.keys(drivers).some((key) => key !== "repo") ||
      !isNonEmptyString(drivers.repo)
    ) {
      throw new ScopeViolationError(
        "The GitLab Backend requires a registryPath and one Repo Driver.",
      );
    }
    return deepFreeze({
      id: input.id,
      type: "gitlab",
      configuration: { registryPath: configuration.registryPath },
      drivers: { repo: drivers.repo },
    });
  },
});
