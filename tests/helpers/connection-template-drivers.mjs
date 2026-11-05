import { randomUUID } from "node:crypto";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/google-workspace/install.ts";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import { OpenShellProviderAlreadyExistsError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

const clientWorkspace = "oce-oauth-clients";

/** Records the OpenShell RPCs the Drivers send; never mints or substitutes credentials. */
function recordingOpenShell() {
  const providers = new Map();
  const createdProviders = [];
  const profiles = new Map();
  const key = (workspace, name) => `${workspace}/${name}`;
  const client = {
    async getProviderProfile(workspace, id) {
      return profiles.get(key(workspace, id));
    },
    async importProviderProfile(workspace, profile) {
      profiles.set(key(workspace, profile.id), structuredClone(profile));
    },
    async updateProviderProfile(workspace, profile) {
      profiles.set(key(workspace, profile.id), structuredClone(profile));
    },
    async deleteProviderProfile(workspace, id) {
      profiles.delete(key(workspace, id));
    },
    async createProvider(input) {
      createdProviders.push(input.name);
      const id = key(input.workspace, input.name);
      if (providers.has(id)) {
        throw new OpenShellProviderAlreadyExistsError();
      }
      providers.set(id, {
        ...structuredClone(input),
        config: input.config ?? {},
        uid: randomUUID(),
        resourceVersion: "1",
      });
      return providers.get(id);
    },
    async getProvider(workspace, name) {
      return providers.get(key(workspace, name));
    },
    async deleteProvider(workspace, name) {
      providers.delete(key(workspace, name));
    },
    async updateProviderCredentialsConditionally(request, resourceVersion, _signal, clearKeys) {
      const current = providers.get(key(request.workspace, request.name));
      if (!current || current.resourceVersion !== resourceVersion) {
        throw new Error("stale provider version");
      }
      Object.assign(current.credentials, request.credentials);
      current.credentialExpirationTimes = {
        ...current.credentialExpirationTimes,
        ...request.credentialExpirationTimes,
      };
      for (const key of clearKeys ?? []) {
        delete current.credentials[key];
        delete current.credentialExpirationTimes[key];
      }
      current.resourceVersion = String(Number(resourceVersion) + 1);
      // This recording transport has no Sandbox recipients. Native installation is verified separately.
      return { ...current, targetReceipts: [], mutationId: randomUUID() };
    },
    async getProviderCredential(workspace, name, credentialKey) {
      return { value: providers.get(key(workspace, name)).credentials[credentialKey] };
    },
    close() {},
  };
  return { client, providers, createdProviders };
}

export function selectTemplateDrivers(controller, { selectGateway = true } = {}) {
  const openShell = recordingOpenShell();
  const backend = createOpenShellBackend(
    {
      id: "openshell-test",
      type: "openshell",
      configuration: { endpoint: "http://127.0.0.1:1" },
      drivers: {
        credential_gateway: "openshell-credentials",
        sandbox: "openshell-sandbox",
        credential_refresh: "openshell-refresh",
      },
    },
    { gatewayClient: openShell.client },
  );
  const gateway = new OpenShellCredentialGatewayDriver(
    {
      binaries: ["/app/bin/codex"],
      toolBinaries: [managedGoogleInstall.binaryPath, "/usr/local/bin/node"],
    },
    { id: "openshell-credentials", backend },
  );
  const refresh = new OpenShellCredentialRefreshDriver(
    { clientWorkspace },
    { id: "openshell-refresh", backend },
  );
  if (selectGateway) {
    controller.registerDriver(gateway);
    controller.selectDriver("credential_gateway", gateway.id);
  }
  controller.registerDriver(refresh);
  controller.selectDriver("credential_refresh", refresh.id);
  return {
    gateway,
    providers: openShell.providers,
    createdProviders: openShell.createdProviders,
    refresh,
    transport: openShell.client,
  };
}
