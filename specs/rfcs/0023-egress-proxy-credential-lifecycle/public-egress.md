---
rfc: ./index.md
---

# Public egress with external credential custody

## Proposed decision

Let an Agent download a package or contact a new public service without asking
an operator to add each destination. The proposed default for new protected
installations is public IPv4 TCP through OpenShell. The Agent can send workspace
data to a public service. Platform-managed model and repository credentials must
remain outside the workload, and a public connection must never bypass a denial
on a managed host.

Use the existing protected Kubernetes quickstart and the protected `occdev`
setup for this default. Both use a dedicated Sandbox and external credential
owners. Operators can select restricted mode on those paths. The ordinary
installation renderer that delivers Secrets directly to workloads must select
restricted mode explicitly.

## Admission and credential delivery

The Installation selects `networkEgressMode: public` or
`networkEgressMode: restricted`. Omission means restricted, including for
existing saved installations. OpenClaw Control Plane (OCC) freezes the mode in
each AgentRevision separately from named Sandbox rules. A configuration change
takes effect on the next admitted revision.

Compute and Sandbox may advertise `publicNetworkEgress` only when the selected
composition can enforce it. OCC must refuse an unsupported combination before
admitting the revision. Kubernetes Compute checks its selected Sandbox and
rechecks support before preparing or activating a saved revision.

In public mode, OCC must refuse Harness authentication that delivers an API key
or PAT directly to the workload. A supported authenticated Harness uses a ready
CredentialSource through the paired Sandbox and Credential Gateway. The
Credential Proxy owns protected repository access. On replay, Compute must
enforce the same delivery boundary, including any Configuration Secret binding
that would expose a Secret to a public embedded workload. Dedicated channel
credentials stay in the separate Gateway. The Agent can still receive its
scoped transport identity. These requirements govern OCE-managed credentials;
users remain responsible for secrets they put in workspace files.

## Enforcement and startup

OpenShell's public fallback uses policy DNS for unclaimed hostnames that resolve
to public IPv4 addresses, on any TCP port. It does not add fallback for raw IP
targets or explicit proxy commands. A managed hostname stays reserved across
ports. If its policy denies a binary, path or method, that denial is final.
The public rule grants no general UDP, IPv6, private-network, metadata or
control-plane access.

The OpenShell adapter requests `allow_unconfigured_public_tcp`. Before declaring
the Agent ready or a live policy update applied, it must verify that the
supervisor reports public TCP active. The report must match the loaded policy
version and hash, the supervisor instance, and the effective configuration and
provider-environment revisions.

A supervisor can accept its initial configuration before its network engine
starts. While applied evidence is pending, preserve the workload and wait for
the same instance to report under the existing deployment deadline. Waiting
must neither consume deployment retries nor trigger workload-stop cleanup.
Refuse release on contradictory evidence or expiry of the deadline. A
replacement supervisor must supply fresh evidence. Failure must never select
unmediated networking or silently change the admitted mode.

## Release and qualification

The currently pinned OpenShell v0.1.6 Gateway and supervisor cannot deliver this
default. Ship it only with a qualified pair that implements both the mediated
fallback and the applied-mode report.

Qualify a regular protected Agent against a restricted control. Verify revision
readback, public HTTPS and a controlled nonstandard TCP port, managed-host
denials, real model and authenticated Git operations, and absence of platform
credentials from the workload. Verify delayed startup confirmation and refusal
when evidence never arrives. For a development workflow, also install the
locked dependencies and run the repository formatter and tests. Record those
results separately from package-manager bootstrap. Use the existing
[Kubernetes test environment](../../../docs/testing/kubernetes.md).
