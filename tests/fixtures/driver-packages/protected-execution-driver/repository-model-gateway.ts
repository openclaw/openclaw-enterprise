import type { DriverRegistration } from "@openclaw-enterprise/contracts";
import { withCredentialGateway } from "./model-gateway.ts";
import { createDriver as createRepositoryDriver } from "./repository-git.ts";

export { configurationSchema, validateConfiguration } from "./repository-git.ts";

/** The protected repository Git package that also supplies its own Credential Gateway view. */
export function createDriver(
  options: Parameters<typeof createRepositoryDriver>[0],
): DriverRegistration {
  return withCredentialGateway(createRepositoryDriver(options), options);
}
