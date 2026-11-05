import {
  BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  type OpenClawController,
} from "@openclaw-enterprise/occ";

import { discoverMcpAuthorization } from "../connections/mcp-discovery.ts";
import { googleWorkspaceDestinations } from "../drivers/plugin/google-workspace/operations.ts";

/** HTTP bootstrap provisions the same initial resources as a migrated PostgreSQL Installation. */
export async function createBootstrapResources(controller: OpenClawController, actorId: string) {
  await controller.createNamespace(actorId, { name: BOOTSTRAP_DEFAULT_NAMESPACE_NAME });
  await controller.createConnectionTemplate(
    actorId,
    {
      displayName: "Google OAuth",
      mode: "manual",
      issuer: "https://accounts.google.com",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revocationUrl: "https://oauth2.googleapis.com/revoke",
      destinations: googleWorkspaceDestinations,
      authorizationParameters: { access_type: "offline", prompt: "consent" },
      scopes: [],
    },
    discoverMcpAuthorization,
  );
}
