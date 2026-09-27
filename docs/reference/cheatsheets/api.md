# API cheat sheet

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

## Operations

### Authentication accounts

- [`createAuthAccount`](../api.md#post-apiauthaccounts): Create an administrator-controlled local auth account.

### Authentication sessions

- [`getAuthSession`](../api.md#get-apiauthsession): Inspect authentication without revealing session tokens.
- [`signInEmail`](../api.md#post-apiauthsigninemail): Sign in with email and password.
- [`signOut`](../api.md#post-apiauthsignout): Sign out of the current session.

### Service API keys

- [`createServiceKey`](../api.md#post-apiauthservicekeys): Issue a service API key.
- [`revokeServiceKey`](../api.md#delete-apiauthservicekeyskeyid): Revoke a service API key.

### Installation

- [`getInstallation`](../api.md#get-installation): Get the singleton Installation.
- [`getInstallationDeploymentInventory`](../api.md#get-installationdeploymentinventory): Get the complete authorized Agent deployment inventory.
- [`bootstrapInstallation`](../api.md#post-installationbootstrap): Bootstrap the singleton Installation.

### Namespaces

- [`listNamespaces`](../api.md#get-namespaces): List authorized Namespaces.
- [`getNamespace`](../api.md#get-namespacesnamespaceid): Get an exact Installation-owned Namespace.
- [`createNamespace`](../api.md#post-namespaces): Create an Installation-owned Namespace.
- [`deleteNamespace`](../api.md#delete-namespacesnamespaceid): Begin deletion of an empty Installation-owned Namespace.

### Agents

- [`listAgents`](../api.md#get-namespacesnamespaceidagents): List authorized Agents in one exact Namespace.
- [`listRepositoryOptions`](../api.md#get-namespacesnamespaceidagentsrepositoryoptions): List approved repository choices for Agent creation in one Namespace.
- [`getAgent`](../api.md#get-namespacesnamespaceidagentsagentid): Get an exact Namespace-owned Agent.
- [`getAgentProvisioning`](../api.md#get-namespacesnamespaceidagentsprovisionworkid): Get first-time provisioning status for one exact work item.
- [`getAgentRuntimeImages`](../api.md#get-namespacesnamespaceidagentsagentidruntimeimages): Read observed images and source commits for an Agent's active runtime.
- [`getSavedAgentPluginPolicyCapabilities`](../api.md#get-namespacesnamespaceidagentsagentidpluginscapabilities): Read selected Plugin Driver policy capabilities for an active Agent with caller Agent read/update permission.
- [`createAgent`](../api.md#post-namespacesnamespaceidagents): Create a Namespace-owned Agent.
- [`provisionAgent`](../api.md#post-namespacesnamespaceidagentsprovision): Create a new Agent and queue first-time provisioning.
- [`updateAgent`](../api.md#patch-namespacesnamespaceidagentsagentid): Replace an exact Namespace-owned Agent's editable draft.
- [`deployAgent`](../api.md#post-namespacesnamespaceidagentsagentiddeploy): Admit an immutable revision from the Agent's saved draft.
- [`discoverAgentModels`](../api.md#post-namespacesnamespaceidagentsmodels): List provider models for Agent creation without storing the supplied credential.
- [`discoverAgentPluginDetails`](../api.md#post-namespacesnamespaceidagentspluginsdetails): Read plugin details using the selected Driver.
- [`discoverAgentPlugins`](../api.md#post-namespacesnamespaceidagentsplugins): List available plugins for Agent creation using the selected Driver.
- [`discoverSavedAgentPluginDetails`](../api.md#post-namespacesnamespaceidagentsagentidpluginsdetails): Read plugin details for an active Agent; caller needs Agent read/update. Curated discovery needs no Secret; hosted discovery needs the Agent's bound Service Accounts Secret with caller and Agent Secret operate grants.
- [`discoverSavedAgentPlugins`](../api.md#post-namespacesnamespaceidagentsagentidplugins): List plugins for an active Agent; caller needs Agent read/update. Curated discovery needs no Secret; hosted discovery needs the Agent's bound Service Accounts Secret with caller and Agent Secret operate grants.
- [`retryAgentProvisioning`](../api.md#post-namespacesnamespaceidagentsprovisionworkidretry): Retry failed first-time provisioning for one exact work item.
- [`stopAgent`](../api.md#post-namespacesnamespaceidagentsagentidstop): Stop one Agent while retaining its revision and persistent state.
- [`getAgentNativeAdmin`](../api.md#get-namespacesnamespaceidagentsagentidnativeadmin): Resolve native admin UI launch availability for one Agent.
- [`deleteAgent`](../api.md#delete-namespacesnamespaceidagentsagentid): Begin deletion of an exact Namespace-owned Agent and its AgentRevisions.

### Agent deployments

- [`getAgentDeployment`](../api.md#get-namespacesnamespaceidagentsagentiddeploymentsdeploymentid): Get the durable deployment status for one admitted Agent revision.
- [`diagnoseAgentDeployment`](../api.md#post-namespacesnamespaceidagentsagentiddeploymentsdeploymentiddiagnostics): Run explicit current-runtime diagnostics for one exact Agent revision.

### Agent revisions

- [`listAgentRevisions`](../api.md#get-namespacesnamespaceidagentsagentidrevisions): List authorized immutable revisions for one exact Agent.
- [`getAgentRevision`](../api.md#get-namespacesnamespaceidagentsagentidrevisionsrevisionid): Get an exact authorized immutable Agent revision.

### Agent runtime credentials

- [`getAgentRuntimeCredentials`](../api.md#get-namespacesnamespaceidagentsagentidruntimecredentials): Get metadata for one Agent's provisioned runtime credentials.
- [`provisionAgentRuntimeCredentials`](../api.md#post-namespacesnamespaceidagentsagentidruntimecredentials): Provision initial runtime credentials for one undeployed Agent.

### Agent workspace files

- [`getAgentWorkspaceFile`](../api.md#get-namespacesnamespaceidagentsagentidworkspacefilesname): Read an allowed workspace file from one active Agent.
- [`putAgentWorkspaceFile`](../api.md#put-namespacesnamespaceidagentsagentidworkspacefilesname): Create or replace an allowed workspace file for one active Agent.

### Configurations

- [`getConfiguration`](../api.md#get-namespacesnamespaceidconfigurationsconfigurationid): Get an exact Namespace-owned Configuration.
- [`createConfiguration`](../api.md#post-namespacesnamespaceidconfigurations): Create a native Namespace-owned Agent Configuration.
- [`updateConfiguration`](../api.md#patch-namespacesnamespaceidconfigurationsconfigurationid): Replace values and increment an exact Namespace-owned Configuration generation.
- [`deleteConfiguration`](../api.md#delete-namespacesnamespaceidconfigurationsconfigurationid): Delete an exact unreferenced Namespace-owned Configuration.

### IAM access bindings

- [`listIAMAccessBindings`](../api.md#get-namespacesnamespaceidiamaccessbindings): List exact Namespace IAM AccessBindings.
- [`getIAMAccessBinding`](../api.md#get-namespacesnamespaceidiamaccessbindingsbindingid): Get an exact Namespace IAM AccessBinding.
- [`createIAMAccessBinding`](../api.md#post-namespacesnamespaceidiamaccessbindings): Create an immutable exact-resource Namespace IAM AccessBinding.
- [`deleteIAMAccessBinding`](../api.md#delete-namespacesnamespaceidiamaccessbindingsbindingid): Delete one exact Namespace IAM AccessBinding.

### IAM roles

- [`listIAMRoles`](../api.md#get-namespacesnamespaceidiamroles): List exact Namespace IAM Roles.
- [`getIAMRole`](../api.md#get-namespacesnamespaceidiamrolesroleid): Get an exact Namespace IAM Role.
- [`createIAMRole`](../api.md#post-namespacesnamespaceidiamroles): Create an immutable Namespace IAM Role.
- [`deleteIAMRole`](../api.md#delete-namespacesnamespaceidiamrolesroleid): Delete an unreferenced exact Namespace IAM Role.

### Secrets

- [`listSecrets`](../api.md#get-namespacesnamespaceidsecrets): List readable Namespace-owned Secret metadata without revealing material.
- [`getSecret`](../api.md#get-namespacesnamespaceidsecretssecretid): Get exact Namespace-owned Secret metadata without revealing material.
- [`createSecret`](../api.md#post-namespacesnamespaceidsecrets): Create exact Namespace-owned Secret material and return metadata only.
- [`updateSecret`](../api.md#patch-namespacesnamespaceidsecretssecretid): Replace exact Namespace-owned Secret material and return stable metadata.
- [`deleteSecret`](../api.md#delete-namespacesnamespaceidsecretssecretid): Delete exact unbound Namespace-owned Secret material.

### Service accounts

- [`listServiceAccounts`](../api.md#get-namespacesnamespaceidserviceaccounts): List authorized Namespace-owned ServiceAccounts in one exact Namespace.
- [`getServiceAccount`](../api.md#get-namespacesnamespaceidserviceaccountsserviceaccountid): Get an exact Namespace-owned ServiceAccount.
- [`createServiceAccount`](../api.md#post-namespacesnamespaceidserviceaccounts): Create a native Namespace-owned ServiceAccount.
- [`deleteServiceAccount`](../api.md#delete-namespacesnamespaceidserviceaccountsserviceaccountid): Delete an exact unreferenced Namespace-owned ServiceAccount.

### Service account credentials

- [`createServiceAccountCredential`](../api.md#post-namespacesnamespaceidserviceaccountsserviceaccountidcredentials): Issue a managed credential for an exact Namespace-owned ServiceAccount.
- [`updateServiceAccountCredential`](../api.md#patch-namespacesnamespaceidserviceaccountsserviceaccountidcredential): Associate an exact Namespace-local credential reference with a ServiceAccount.

### Backends

- [`listBackends`](../api.md#get-backends): List configured Backends (experimental).

### Presets

- [`listPresets`](../api.md#get-namespacesnamespaceidpresets): List readable Presets in one Namespace.
- [`getPreset`](../api.md#get-namespacesnamespaceidpresetspresetid): Read one exact Namespace-owned Preset.
- [`createPreset`](../api.md#post-namespacesnamespaceidpresets): Create a reusable Namespace-owned Agent Preset.
- [`updatePreset`](../api.md#patch-namespacesnamespaceidpresetspresetid): Update a Preset without changing existing Agents.
- [`deletePreset`](../api.md#delete-namespacesnamespaceidpresetspresetid): Delete a Preset without changing existing Agents.
