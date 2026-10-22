# Protected repository access with OpenShell

**Release remains blocked.** A registered middleware and loaded policy do not establish that
the supervisor must invoke authorization before sending or that an execution identity cannot be
reused. Qualify the public online profile on released OpenShell, including the actual TLS path.
Stock OpenShell 0.1.5 is not qualified. The proposed way to require that binding is still a draft;
see the [online authorization release requirements](../../../specs/rfcs/0023-egress-proxy-credential-lifecycle/online-authorization.md).

For ordinary unprotected development, finish the
[database and control-plane upgrade](../../guides/deploy/protected-egress-development.md#upgrade-an-existing-development-installation)
and stop there. Leave your Installation and Helm configuration as they are, and keep new protected
Git admissions closed. Migration does not change a running Agent or its grant.

## Configuration for a qualified release

A new protected revision would use the same installed OpenShell Driver’s Sandbox and
`credential_proxy` capabilities, GitHub repository policy, and its prepared Git and OpenShell
authority configuration. The policy configuration needs the session duration and registry, not a
broker control socket or broker CA. The worker verifies the installed policy, prepares short-lived
GitHub tokens, and requires the sender to obtain current authorization before each new Git request. The Agent
receives neither a session bearer nor a GitHub token. An explicitly approved standing grant can
outlive each finite session. A finite grant keeps its original deadline.

### Install without the repository broker

The Installation would select Sandbox and Credential Proxy from the same Driver, as in the
[OpenShell configuration example](../../../deploy/examples/repository-credentials/openshell.fragment.yaml).
Keep `repository.preparedGitHub`, `repository.openShell` and the session duration; omit
`controlSocket` and `publicCaPath`. The GitHub Backend uses
`/etc/openclaw/repository-registry/registry.json`. Do not select `repository.nativeSender`.

The corresponding Helm values would be `openshellGit.enabled: true`, `openshellGit.mode: protected`,
`repositoryCredentials.enabled: false` and `repositoryCredentials.authority: prepared-git`.
The `repositoryCredentials` settings identify the registry ConfigMap, App key Secret, existing
custody Secret and approved issuer CIDRs. Only the worker mounts the signing and custody keys.
The [middleware certificate, public issuer key and trusted callers](openshell-git.md#prepare-the-request-phase-service)
are for TCP 8445. This configuration has no broker listener, control socket or broker CA.

### Grant access to a GitHub App installation

Keep this scope closed until the installed Driver is qualified for `github_installation`.
GitHub sets the ceiling: the Agent can act on the repositories
(including private ones) and with the permissions available to that App installation. If GitHub
limits the installation to selected repositories, that limit still applies. OCE neither changes
installation membership nor adds permissions. Keep repository-scoped Git when that is sufficient.

Apply the database migration first. Upgrade all controllers, workers and the paired Sandbox and
Credential Proxy Driver before enabling the policy. Let the previous owner close its session and
settle its tokens when changing scope. An upgrade leaves existing grants and approvals unchanged.

1. In the GitHub registry, set `installationAccess.repositoryRef` to a distinct name such as
   `team-installation`. In its `namespaces` list, set the intended `namespaceId` and
   `accessMode: installation`. This makes the scope available in that Namespace.
2. In the Agent's `repositoryBindings`, select `repositoryRef: team-installation` and
   `profile: github-installation` together. No default profile or wildcard selects this scope.

Access is finite by default. Standing access requires a separate approval of this exact scope
and permission for standing approvals in both the installation and Namespace policies. Each
credential and session still expires. Removing approval denies the next request; a send that
already passed authorization can finish. The Agent never receives the GitHub token.
Before a registry edit changes the paired Driver’s identity, withdraw live access in OCE and let
the original owner settle credentials even for Namespaces whose policy is unchanged.

## Move from the earlier trial

Stop new admissions and drain the trial on its original owner before updating the control plane.
This release rejects the trial’s Installation `drivers.repo` selection and Helm `broker-trial` mode;
it cannot restart that owner. Keep the database, registry, custody key and issuer access that the
original owner needs to settle issued, retiring or uncertain credentials. Helm cannot settle custody
or migrate a grant.

Only after the original owner has settled custody and the replacement sender and release are
qualified, change the Installation and Helm values together.
That change restarts the worker and removes the broker Service and access policy. A new revision
must not reuse an old receipt or reset a possibly spent draft allowance.
[Native Git](prepared-native-git.md) remains a separate explicit choice.
