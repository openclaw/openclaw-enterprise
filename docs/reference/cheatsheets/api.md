# API cheat sheet

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

## Operations

### Authentication accounts

- [`getAuthAccount`](../api.md#get-apiauthaccountsuserid): Inspect current human account state.
- [`createAuthAccount`](../api.md#post-apiauthaccounts): Create an administrator-controlled local auth account.
- [`attachGitHubIdentity`](../api.md#post-apiauthaccountsuseridprovidersgithub): Attach an exact GitHub identity to an existing account.
- [`attachGoogleIdentity`](../api.md#post-apiauthaccountsuseridprovidersgoogle): Attach an exact Google identity to an existing account.
- [`attachOidcIdentity`](../api.md#post-apiauthaccountsuseridprovidersoidc): Attach an exact OIDC identity to an existing account.
- [`detachAuthMethod`](../api.md#post-apiauthaccountsuseridmethodsmethodiddetach): Detach an external sign-in identity from an account.
- [`disableAuthAccount`](../api.md#post-apiauthaccountsuseriddisable): Disable a human account.
- [`enableAuthAccount`](../api.md#post-apiauthaccountsuseridenable): Re-enable a disabled human account.
- [`enrolAuthAccount`](../api.md#post-apiauthaccountsuseridenrol): Enrol an existing account that activation skipped.
- [`revokeAuthAccountSessions`](../api.md#post-apiauthaccountsuseridrevoke): Revoke all sessions for a human account.

### Authentication sessions

- [`getAuthSession`](../api.md#get-apiauthsession): Inspect authentication without revealing session tokens.
- [`signInEmail`](../api.md#post-apiauthsigninemail): Sign in with email and password.
- [`signOut`](../api.md#post-apiauthsignout): Sign out of the current session.

### Service API keys

- [`createServiceKey`](../api.md#post-apiauthservicekeys): Issue a service API key.
- [`revokeServiceKey`](../api.md#delete-apiauthservicekeyskeyid): Revoke a service API key.

### Authentication

- [`completeGitHubSignIn`](../api.md#get-apiauthprovidersgithubcallback): Complete an enrolled GitHub sign-in.
- [`completeGoogleSignIn`](../api.md#get-apiauthprovidersgooglecallback): Complete an enrolled Google sign-in.
- [`completeOidcSignIn`](../api.md#get-apiauthprovidersoidccallback): Complete an enrolled OIDC sign-in.
- [`getAuthProviders`](../api.md#get-apiauthproviders): List configured browser sign-in methods.
- [`getAuthRecovery`](../api.md#get-apiauthrecovery): Inspect the recovery account designation.
- [`confirmGitHubSignIn`](../api.md#post-apiauthprovidersgithubresult): Confirm which session a GitHub sign-in created.
- [`confirmGoogleSignIn`](../api.md#post-apiauthprovidersgoogleresult): Confirm which session a Google sign-in created.
- [`confirmOidcSignIn`](../api.md#post-apiauthprovidersoidcresult): Confirm which session an OIDC sign-in created.
- [`replaceAuthRecovery`](../api.md#post-apiauthrecovery): Move the recovery designation to another administrator.
- [`startGitHubSignIn`](../api.md#post-apiauthprovidersgithubstart): Start GitHub sign-in for an enrolled account.
- [`startGoogleSignIn`](../api.md#post-apiauthprovidersgooglestart): Start Google sign-in for an enrolled account.
- [`startOidcSignIn`](../api.md#post-apiauthprovidersoidcstart): Start OIDC sign-in for an enrolled account.

### Installation

- [`getInstallation`](../api.md#get-installation): Get the singleton Installation.
- [`getInstallationDeploymentInventory`](../api.md#get-installationdeploymentinventory): Get the complete authorized Agent deployment inventory.
- [`getObservability`](../api.md#get-observability): Get the configured external observability destination.
- [`bootstrapInstallation`](../api.md#post-installationbootstrap): Bootstrap the singleton Installation.

### Namespaces

- [`listNamespaces`](../api.md#get-namespaces): List authorized Namespaces.
- [`getNamespace`](../api.md#get-namespacesnamespaceid): Get an exact Installation-owned Namespace.
- [`createNamespace`](../api.md#post-namespaces): Create an Installation-owned Namespace.
- [`deleteNamespace`](../api.md#delete-namespacesnamespaceid): Begin or retry deletion of an empty Installation-owned Namespace.

### Agents

- [`listAgentRepositoryOptions`](../api.md#get-namespacesnamespaceidagentsagentidrepositoryoptions): List approved repository choices for updating one Agent.
- [`listAgentRuntimeRoles`](../api.md#get-namespacesnamespaceidagentsagentidruntimeroles): List configured runtime roles and deployed permission summaries for an Agent.
- [`listAgents`](../api.md#get-namespacesnamespaceidagents): List authorized Agents in one exact Namespace.
- [`listRepositoryOptions`](../api.md#get-namespacesnamespaceidagentsrepositoryoptions): List approved repository choices for Agent creation in one Namespace.
- [`getAgent`](../api.md#get-namespacesnamespaceidagentsagentid): Get an exact Namespace-owned Agent.
- [`getAgentCredentialWithdrawal`](../api.md#get-namespacesnamespaceidagentsagentidcredentialsourcescredentialsourceidwithdrawal): Get the withdrawal state of a credential source for an Agent's active revision.
- [`getAgentProvisioning`](../api.md#get-namespacesnamespaceidagentsprovisionworkid): Get first-time provisioning status for one exact work item.
- [`getAgentRuntimeImages`](../api.md#get-namespacesnamespaceidagentsagentidruntimeimages): Read observed images and source commits for an Agent's active runtime.
- [`getSavedAgentPluginPolicyCapabilities`](../api.md#get-namespacesnamespaceidagentsagentidpluginscapabilities): Read selected Plugin Driver policy capabilities for an active Agent with caller Agent read/update permission.
- [`createAgent`](../api.md#post-namespacesnamespaceidagents): Create a Namespace-owned Agent.
- [`provisionAgent`](../api.md#post-namespacesnamespaceidagentsprovision): Create a new Agent and queue first-time provisioning.
- [`updateAgent`](../api.md#patch-namespacesnamespaceidagentsagentid): Replace an exact Namespace-owned Agent's editable draft.
- [`deployAgent`](../api.md#post-namespacesnamespaceidagentsagentiddeploy): Admit an immutable revision from the Agent's saved draft.
- [`discoverAgentModels`](../api.md#post-namespacesnamespaceidagentsmodels): List provider models for Agent creation without storing the supplied credential.
- [`discoverAgentPluginDetails`](../api.md#post-namespacesnamespaceidagentspluginsdetails): Read plugin details using the selected Driver.
- [`discoverAgentPlugins`](../api.md#post-namespacesnamespaceidagentsplugins): List or search available plugins for Agent creation using the selected Driver.
- [`discoverSavedAgentPluginDetails`](../api.md#post-namespacesnamespaceidagentsagentidpluginsdetails): Read plugin details for an active Agent; caller needs Agent read/update. Curated discovery needs no Secret; hosted discovery needs the Agent's bound Service Accounts Secret with caller and Agent Secret operate grants.
- [`discoverSavedAgentPlugins`](../api.md#post-namespacesnamespaceidagentsagentidplugins): List or search plugins for an active Agent; caller needs Agent read/update. Curated discovery needs no Secret; hosted discovery needs the Agent's bound Service Accounts Secret with caller and Agent Secret operate grants.
- [`lookupChannelDirectory`](../api.md#post-namespacesnamespaceidchanneldirectorylookup): Search a channel directory using an authorized Namespace Secret.
- [`pollAgentDeviceAuthorization`](../api.md#post-namespacesnamespaceidagentsdeviceauthorizationssecretidpoll): Experimental: Complete device login without returning credential material.
- [`pollSavedAgentDeviceAuthorization`](../api.md#post-namespacesnamespaceidagentsagentiddeviceauthorizationssecretidpoll): Experimental: Complete device login without returning credential material.
- [`retryAgentProvisioning`](../api.md#post-namespacesnamespaceidagentsprovisionworkidretry): Retry failed first-time provisioning for one exact work item.
- [`startAgentDeviceAuthorization`](../api.md#post-namespacesnamespaceidagentsdeviceauthorizations): Experimental: Start a private device login for Agent configuration.
- [`startSavedAgentDeviceAuthorization`](../api.md#post-namespacesnamespaceidagentsagentiddeviceauthorizations): Experimental: Start a private device login for Agent configuration.
- [`stopAgent`](../api.md#post-namespacesnamespaceidagentsagentidstop): Stop one Agent while retaining its revision and persistent state.
- [`withdrawAgentCredentialSource`](../api.md#post-namespacesnamespaceidagentsagentidcredentialsourcescredentialsourceidwithdraw): Revoke one credential source from an Agent's active revision.
- [`getAgentNativeAdmin`](../api.md#get-namespacesnamespaceidagentsagentidnativeadmin): Resolve OpenClaw launch availability with an assigned runtime role.
- [`cancelAgentDeviceAuthorization`](../api.md#delete-namespacesnamespaceidagentsdeviceauthorizationssecretid): Experimental: Discard a local device login without upstream revocation.
- [`cancelSavedAgentDeviceAuthorization`](../api.md#delete-namespacesnamespaceidagentsagentiddeviceauthorizationssecretid): Experimental: Discard a local device login without upstream revocation.
- [`deleteAgent`](../api.md#delete-namespacesnamespaceidagentsagentid): Begin or retry deletion of an exact Namespace-owned Agent and its AgentRevisions.

### Agent deployments

- [`getAgentDeployment`](../api.md#get-namespacesnamespaceidagentsagentiddeploymentsdeploymentid): Get the durable deployment status for one admitted Agent revision.
- [`getAgentDeploymentRuntime`](../api.md#get-namespacesnamespaceidagentsagentiddeploymentsdeploymentidruntime): Read Pod status, restarts, Events and log sources for one exact Agent revision.
- [`getAgentDeploymentRuntimeLogs`](../api.md#get-namespacesnamespaceidagentsagentiddeploymentsdeploymentidruntimelogs): Read one bounded, redacted page of container output for one exact Agent revision.
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
- [`updateIAMRuntimeRole`](../api.md#patch-namespacesnamespaceidiamaccessbindingsbindingidruntimerole): Change the runtime role on an exact human Agent access grant.
- [`deleteIAMAccessBinding`](../api.md#delete-namespacesnamespaceidiamaccessbindingsbindingid): Delete one exact Namespace IAM AccessBinding.

### IAM roles

- [`listIAMRoles`](../api.md#get-namespacesnamespaceidiamroles): List exact Namespace IAM Roles.
- [`getIAMRole`](../api.md#get-namespacesnamespaceidiamrolesroleid): Get an exact Namespace IAM Role.
- [`createIAMRole`](../api.md#post-namespacesnamespaceidiamroles): Create an immutable Namespace IAM Role.
- [`deleteIAMRole`](../api.md#delete-namespacesnamespaceidiamrolesroleid): Delete an unreferenced exact Namespace IAM Role.

### IAM service principals

- [`listIAMServicePrincipals`](../api.md#get-namespacesnamespaceidiamserviceprincipals): List the Namespace's non-Agent ServicePrincipals.
- [`getIAMServicePrincipal`](../api.md#get-namespacesnamespaceidiamserviceprincipalsserviceprincipalid): Get an exact Namespace ServicePrincipal.
- [`createIAMServicePrincipal`](../api.md#post-namespacesnamespaceidiamserviceprincipals): Create a Namespace ServicePrincipal with no grants for automation or CLI keys.

### Secrets

- [`listSecrets`](../api.md#get-namespacesnamespaceidsecrets): List readable Namespace-owned Secret metadata without revealing material.
- [`getSecret`](../api.md#get-namespacesnamespaceidsecretssecretid): Get exact Namespace-owned Secret metadata and its readable consumers.
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

### Credential sources

- [`listCredentialSources`](../api.md#get-namespacesnamespaceidcredentialsources): List readable credential sources without revealing credential values.
- [`getCredentialSource`](../api.md#get-namespacesnamespaceidcredentialsourcescredentialsourceid): Get one credential source and its live Credential Gateway status.
- [`createCredentialSource`](../api.md#post-namespacesnamespaceidcredentialsources): Register a credential source with the selected Credential Gateway.
- [`updateCredentialSource`](../api.md#patch-namespacesnamespaceidcredentialsourcescredentialsourceid): Push current or replacement Secret values to the Credential Gateway copy.
- [`deleteCredentialSource`](../api.md#delete-namespacesnamespaceidcredentialsourcescredentialsourceid): Remove an unreferenced credential source from the Credential Gateway.

### Presets

- [`listPresets`](../api.md#get-namespacesnamespaceidpresets): List readable Presets in one Namespace.
- [`getPreset`](../api.md#get-namespacesnamespaceidpresetspresetid): Read one exact Namespace-owned Preset.
- [`createPreset`](../api.md#post-namespacesnamespaceidpresets): Create a reusable Namespace-owned Agent Preset.
- [`updatePreset`](../api.md#patch-namespacesnamespaceidpresetspresetid): Update a Preset without changing existing Agents.
- [`deletePreset`](../api.md#delete-namespacesnamespaceidpresetspresetid): Delete a Preset without changing existing Agents.
