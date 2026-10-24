# Breaking-change notices before 2026-10-13

These [breaking-change notices](breaking-changes.md) are dated 2026-10-12;
newer ones are on that page, in the
[notices before 2026-10-24](breaking-changes-before-2026-10-24.md), in the
[notices before 2026-10-23](breaking-changes-before-2026-10-23.md), in the
[notices before 2026-10-15](breaking-changes-before-2026-10-15.md) and in the
[notices from 2026-10-13](breaking-changes-archive.md), and older ones are in the
[notices before 2026-10-12](breaking-changes-before-2026-10-12.md). They still
apply when you upgrade from a source commit older than their date. Entries are
newest first. Steps marked _untested_ have not been run against a real
Installation.

## 2026-10-12: model credentials in provider headers and request auth

**What breaks.** On Kubernetes Compute, Configuration create and update,
provisioning, Preset saves, Agent create and update, and deployment answer
`400` naming the setting for any `models.providers.<provider>`, even one no
model setting selects, that has:

- a credential header in `headers` (on the provider or one of its `models`)
  or `request.headers`: a name whose last hyphen- or underscore-separated
  word, after any trailing number, is `auth`, `authorization`, `bearer`,
  `cookie`, `credential`, `passcode`, `passphrase`, `password`, `secret`,
  `signature` or `token` (or a plural), or that ends in `key` or `keys` except
  an idempotency or cache key, such as `Proxy-Authorization`, `x-goog-api-key`,
  `X-Auth-Key`, `x-auth-token` or `Cookie`
  ([widened on 2026-10-13](breaking-changes-archive.md#2026-10-13-more-model-credential-header-names-and-provider-models-lists));
- a header name that is not a valid HTTP field name (spaces, zero-width or
  non-ASCII characters);
- a `request.auth` other than exactly `{mode: "provider-default"}`.

Every Configuration Driver, on every Compute, also answers `400` for a literal
where a reference is required: those headers (on models too),
`request.auth.token` and `request.auth.value`, and the `cert`, `key` and
`passphrase` of `request.tls` and `request.proxy.tls`. It refuses a
`request.proxy.url` with a user name or password. Preset saves run the
Kubernetes rules before the Configuration Driver's, so a literal gets the
Kubernetes message.

**Who is affected.** Configurations that carry such headers, `request.auth`,
TLS client keys or proxy credentials. A stored Configuration still reads and
an edit can replace it; saving it unchanged and deployment refuse it with the
same message.

**How to tell.** Kubernetes Compute's `400` names
`models.providers.<provider>.headers`, `.request.headers` or `.request.auth`.
The Configuration Driver's names a JSON pointer, such as
`/models/providers/<provider>/request/auth/token holds a credential value inline`.

**Steps.** Read the Configuration, then save it without the refused setting.
The Agent's Harness authentication is the only supported path for model
credentials; select the credential there after that save, since an Agent save
that names the Configuration is refused with the same message until then.

- On Kubernetes Compute, remove every credential header and any `request.auth`
  other than `{mode: "provider-default"}`. A `${NAME}` reference is refused
  there too.
- On other Compute, the Configuration Driver accepts a `${NAME}` reference in
  those slots instead of a literal.
- For TLS client keys and proxy credentials, on any Compute, store the value
  as a Secret and write a `${NAME}` reference.

## 2026-10-12: repository credential images follow the control-plane image rule

**What breaks.** The chart (since #2221) and now profile preflight refuse a
`repositoryCredentials.image` or `repository.image` that does not start with a
letter or digit or that holds a character other than letters, digits, `.`,
`_`, `:`, `/` or `-` before the `@sha256:` digest, as for the controller image.

**Who is affected.** Hand-written values or profile inputs with such a
reference. Registry references rarely use such names.

**How to tell.** Rendering fails with `repositoryCredentials.image must be an
approved immutable SHA-256 image reference`; preflight names `repository.image`.

**Steps.** Use the image's registry reference with its digest.

## 2026-10-12: SSH Compute names its Harness authentication rule

**What breaks.** On SSH Compute, an embedded OpenClaw Agent whose
`harnessAuth.method` is not `runtime` gets `400` naming `harnessAuth.method`,
where it got a fixed `409`: at deployment, and at Agent create and update when
they check the binding. Nothing new is refused.

**Who is affected.** Clients that branch on the `409`.

**How to tell.** The `400` says the method must be `runtime`.

**Steps.** Set `harnessAuth` to `{ "method": "runtime" }`.

## 2026-10-12: demo NetworkPolicy ports must be canonical decimals

**What breaks.** `helm upgrade` of the observability demo fails when
`cluster.port` or `occ.metricsPort` is not a decimal integer from 1 through
65535 with no leading zero. A saved string `"010"` used to install, and
Kubernetes applied port 8. The upgrade now stops before it writes that policy.

**Who is affected.** Demo releases whose saved values use a leading zero or a
port outside that range. Defaults 443 and 9464, and an ordinary decimal such as
6443, upgrade unchanged.

**How to tell.** Helm stops in `prometheus.yaml` with
`cluster.port must be an integer TCP port from 1 to 65535`, or the same
sentence for `occ.metricsPort`.

**Steps.** Set the field to the decimal Kubernetes already applied (`8` for a
saved `"010"`) and upgrade again. The NetworkPolicy port stays that decimal.
The [demo install](../observability/demo.md#install-private-backends) states the
same contract.

## 2026-10-12: cluster and execution API ports must be canonical decimals

**What breaks.** Helm now refuses `cluster.port` and `executionCluster.apiPort`
values that are not a canonical decimal from 1 to 65535 with at most five
digits. `010` and integers Sprig cannot convert, such as
`9223372036854775808`, no longer render.

**Who is affected.** Installations that set either port with a leading zero.

**How to tell.** Helm names `cluster.port` or `executionCluster.apiPort` and
says it must be an integer TCP port from 1 to 65535.

**Steps.** Replace a leading-zero value with its effective decimal port (`010`
becomes `8`) before the next Helm upgrade. _untested_ against a live release.

## 2026-10-12: Sandbox workspace files and provisioning repository refusals

**What breaks.**

- With a Sandbox Driver selected (OpenShell), Agent create and provisioning with
  `initialWorkspaceFiles`, and Agent update and deployment while those files
  are pending, answer `409` naming the Sandbox. Before, dedicated Codex saved
  and its first deployment failed, and dedicated OpenClaw got a `400` naming
  `agents.defaults.workspace` or `agents.entries.main.workspace`, which the
  Sandbox had set.
- The Agent provisioning request, and its retry, answer `409` for
  `repositoryBindings` that the Compute topology cannot deliver, with Agent
  create's message. Before, the request answered `202` and the work failed.
- Newly accepted on Kubernetes and Docker Compute: an `agents.entries` roster
  key of `Main` (any letter case) with initial workspace files.

**Who is affected.** OpenShell Installations that create Agents with initial
workspace files, and provisioning clients that send repository bindings on a
topology without repository credential delivery.

**How to tell.** The `409` message names the Sandbox or repository credentials.

**Steps.** Create the Agent without `initialWorkspaceFiles`, or without
`repositoryBindings`.
