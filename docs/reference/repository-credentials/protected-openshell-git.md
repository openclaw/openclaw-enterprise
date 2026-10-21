# Protected repository access with OpenShell

For a **new protected revision**, select the same installed OpenShell Driver's Sandbox and
`credential_proxy` capabilities, the GitHub Repo Driver, and its prepared Git and OpenShell
authority configuration. The Repo configuration needs the session duration and registry, not a
broker control socket or broker CA. The worker verifies the installed policy, prepares short-lived
GitHub tokens, and authorizes each Git request against the exact installed version. The Agent
receives neither a session bearer nor a GitHub token. An explicitly approved standing grant can
outlive each finite session. A finite grant keeps its original deadline.

**Release remains blocked.** A registered middleware and loaded policy do not establish that
the supervisor must invoke authorization before sending or that an execution identity cannot be
reused. Qualify the public online profile on released OpenShell, including the actual TLS path.
The stronger installation-exchange profile cannot qualify this path. An older controller cannot
read the new admission. Upgrade controllers and workers together, settle previous custody before
issuing, and preserve any spent or possibly spent draft allowance. Nothing migrates an existing
team's grant or changes its running Agent.

## Install without the repository broker

In the Installation, select Sandbox and Credential Proxy from the same Driver. For the
bundled OpenShell Driver, use the [middleware and prepared GitHub settings](../../../deploy/examples/repository-credentials/openshell.fragment.yaml).
Set the GitHub Backend's registry path to `/etc/openclaw/repository-registry/registry.json`;
omit `controlSocket` and `publicCaPath` from `drivers.repo.configuration`.
OCE still needs a qualified sender before it can admit protected Git.

In Helm, select `openshellGit.enabled: true`, `openshellGit.mode: protected`,
`repositoryCredentials.enabled: false` and `repositoryCredentials.authority: prepared-git`.
Under `repositoryCredentials`, supply the registry ConfigMap, App key Secret, existing
custody Secret and approved issuer CIDRs. Only the worker mounts the signing and custody
keys. Configure the [middleware certificate, public issuer key and trusted callers](openshell-git.md#maintain-the-earlier-git-trial)
for TCP 8445. This installation has no broker listener, control socket or broker CA.

## Move from the earlier trial

Keep `openshellGit.mode: broker-trial` and the broker enabled while its original owner
drains sessions and settles issued, retiring or uncertain credentials. An upgrade with
the old trial values and no explicit mode stops at render time. Helm cannot settle
custody, migrate a grant or determine when it is safe to remove the broker. Preserve
the database, registry, custody key and any issuer access still needed for retirement.

Once the old owner is fenced and custody is settled, change the Installation and Helm
values together. Expect a worker restart and removal of the broker Service and access
policy. Admit a new protected revision, without reusing an old receipt or resetting
a draft allowance. [Native Git](prepared-native-git.md) remains a separate explicit choice.
