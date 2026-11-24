# Enroll repositories for OpenShell Agents

Use OCC TokenService and the paired OpenShell Sandbox and Credential Proxy to
give a dedicated Agent Git access to specific GitHub repositories. The steps
below use the [cutover candidate](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/guides/repository-credentials.md#set-github-app-access-for-an-openshell-agent).
For an existing installation that uses a Worker signer with Credential
Gateway, use the [pre-cutover Helm walkthrough](https://github.com/openclaw/openclaw-enterprise/blob/a0d583bb7bdb4c2dd5ae43897926c037acfbf0be/docs/guides/repository-credentials/openshell-enrollment.md).

Use an approved GitHub App already installed for the repositories. Have its App
ID, installation ID, and private PEM signing key ready for Client enrollment.

### Identify the Namespace for the registry

Use a ready Namespace and record its ID. You need Installation administration
to register or change a GitHub App Client, and permission to create a Source
in the Namespace or use an eligible existing Source.

### Register the Harness model source first

Set up the Agent's model credential independently of Git. Use
[OCC TokenService with native Proxy delivery](../deploy/deploy-first-agent.md#evaluate-the-tokenservice-and-credential-proxy-cutover)
and save a ready Source for the dedicated Harness.

### Prepare an authenticated local Gateway

Select the [candidate OpenShell Backend and Sandbox settings](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/reference/drivers/selection.md#supported-selections)
with a matching Gateway, runtime, and supervisor. Verify management access and
the [OpenShell qualification requirements](../../reference/drivers/openshell-sandbox.md#qualification-contract).
The [candidate Git guide](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/guides/repository-credentials.md#set-github-app-access-for-an-openshell-agent)
describes operator-managed and service-mode Sandbox use for dedicated Codex.

### Configure authorized repositories

1. Configure the GitHub Backend and its approved registry. Each entry grants
   the target Namespace access to the repository at an explicit level. Use the
   [candidate registry and network policy example](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/reference/repository-credentials/access-levels.md#tokenservice-registry-example).
2. In Helm, set `repositoryCredentials.registryConfigMapName` to the approved
   registry ConfigMap and set the GitHub Backend's `registryPath` to
   `/etc/openclaw/repository-registry/registry.json`.
3. In the OCC Console, open **Credentials → Credential clients → Register
   client**. Choose **GitHub App** and select Installation-wide availability or
   the Agent's Namespace. Provide the App ID and PEM signing key. TokenService
   verifies the key and stores it in private custody.

<a id="allow-the-worker-to-reach-github"></a>
<a id="allow-the-supervisor-to-reach-the-authority"></a>

Allow the API to reach GitHub over HTTPS for App setup and token renewal.
Use the Namespace's approved Git request path for the Sandbox.

### Select repositories and deploy

1. In the Agent's **Repositories** settings, choose the approved repositories,
   access levels, and a GitHub App Client available in that Namespace.
2. Select its model Source and save. If the Agent is already running,
   stop it and wait until it has no active revision before deploying the draft.
   TokenService reuses or
   mints a GitHub installation token for the approved repository scope.
   Credential Proxy injects it on admitted Git requests.
3. Confirm that the deployment succeeds and its revision becomes active. In
   the running Agent, use `git ls-remote https://github.com/example/project.git HEAD`
   with an approved repository and verify the returned commit ID. Check that
   an ungranted repository is refused.

The [candidate live results](https://github.com/openclaw/openclaw-enterprise/pull/7224)
cover a Codex model turn and native Git reads, including denial on an ungranted
repository. Live native push still needs qualification. See
[Git access levels](../../reference/repository-credentials/access-levels.md)
for GitHub permissions and the Agent's policy.

### Work with GitHub issues and pull requests

TokenService-backed Git admits Git transport requests. For GitHub issue or
pull request API operations in an Installation using a qualified prepared
sender, see its [GitHub REST access reference](../../reference/repository-credentials/protected-openshell-git.md#use-the-admitted-repository).

### Plan for request limits

For the pre-cutover protected sender, check the complete request size before
pushing. OpenShell 0.1.6 buffers the whole request, including pack bytes,
commands, and framing, and permits up to 4 MiB for a Git push. The pre-cutover
Helm walkthrough above lists the other request limits. For a TokenService
Agent, keep Git requests within the limits of its selected OpenShell runtime.
