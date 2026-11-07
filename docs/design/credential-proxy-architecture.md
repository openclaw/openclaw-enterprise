# Credential Proxy architecture

A user asks an Agent, “Implement a feature and push a branch.” OpenClaw Enterprise (OCE) runs the Agent in a sandbox. The Agent runs ordinary Git commands. OCE keeps the GitHub App signing key and the installation token outside that sandbox.

## From the user to GitHub

![An Agent with a selected-repository grant is asked to implement a feature and push a branch. The Agent runs git push. The Credential Proxy asks the OCE control plane whether the Agent may push and forwards the request to GitHub only on allow.](../assets/credential-proxy/platform-roles.png)

This example uses the selected-repository profile (`github-repository`). The operator chooses which repositories the Agent can use. The Credential Proxy checks the request against that grant through the control plane. If OCE denies the push, the proxy stops it. If OCE allows it, the proxy adds the credential and GitHub applies its own repository rules.

<a id="how-does-openshell-authorize-a-git-request"></a>

## How does the Credential Proxy authorize a Git request?

![The Agent runs git push. The Credential Proxy asks the Git transport adapter about the push. The adapter calls the Repository Git authority to check the grant and returns allow or deny. Only on allow does the proxy add the installed token and send.](../assets/credential-proxy/current-git.png)

In the OpenShell implementation shown here, the supervisor acts as the Credential Proxy. Its `EvaluateHttpRequest` hook sends the attempted request to the OCE worker. The worker checks who called, which credential version the proxy loaded, and whether the grant covers this operation.

For selected repositories, the grant names repositories on one GitHub App installation. GitHub enforces the token's permissions and branch rules. An exact-ref write grant also checks the pushed ref. The opt-in installation-wide preview can accept a registration without the required binding fields. In that case, the startup probe shows that the hook ran once. It cannot establish that every later request must use it. The hook's allow reply authorizes the observed request. To find out whether a push succeeded, read back the ref from GitHub. See [OpenShell repository access](../reference/repository-credentials/protected-openshell-git.md).

## How does the token get there?

![The worker signs an App JWT, exchanges it at GitHub for an installation token, and commits the validated token. The adapter installs the token and verifies the loaded generation.](../assets/credential-proxy/current-git-setup.png)

One OpenShell Backend supplies both `SandboxDriver` and `CredentialProxyDriver`. The worker binds its `ProtectedRepositoryGitAuthority` through `bindRepositoryGit`. See the [Driver contract](../reference/drivers/credential-proxy.md).

The worker signs an App JWT and sends it to GitHub in a `POST /app/installations/{installation_id}/access_tokens` request. GitHub returns an installation token. The worker validates its scope and expiry before committing it to the store. The transport adapter reads that committed token through the Repository Git authority. Preparation and refresh run separately from Git requests. On the selected-repository path, OCE checks the held launcher's request against an authenticated middleware denial before issuing credentials. Credential installation and signed release precede Agent startup. See [OpenShell enrollment](../guides/repository-credentials/openshell-enrollment.md) and [token renewal](../guides/repository-credentials/openshell-git-renewal.md).

## Who controls a generic API request and its reply?

![The sender captures the request, calls the OCC exchange through the Driver listener, sends an authorized request and holds the reply for filtering.](../assets/credential-proxy/generic-exchange.png)

The generic `CredentialProxyExchange` also governs what comes back. A qualified sender can ask OCC to resolve a credential, recheck permission just before sending, and protect the complete response before releasing it to the caller. The OpenShell Git hook above authorizes a different protocol. Its allow reply establishes neither exact dispatch nor response filtering. [Walk through a GitHub metadata request](credential-proxy.md#read-one-repositorys-identity).

<a id="proposed-change-pull-the-git-credential-at-the-supervisor"></a>
<a id="proposed-git-credential-pull"></a>
<a id="what-changes-for-git"></a>

For the proposed alternative to installing Git credentials through the Gateway, see the [Git credential pull design discussion](../../specs/rfcs/0023-egress-proxy-credential-lifecycle/git-credential-pull.md).
