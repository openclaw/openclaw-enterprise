# Earlier breaking-change notices

These [breaking-change notices](breaking-changes.md) are older than the ones
on that page, in the
[notices before 2026-10-26](breaking-changes-before-2026-10-26.md), in the
[later notices from 2026-10-24](breaking-changes-later-2026-10-24.md), in the
[earlier notices from 2026-10-24](breaking-changes-earlier-2026-10-24.md), in the
[notices before 2026-10-24](breaking-changes-before-2026-10-24.md), in the
[notices before 2026-10-23](breaking-changes-before-2026-10-23.md) and in the
[notices before 2026-10-15](breaking-changes-before-2026-10-15.md), and newer than the
[notices before 2026-10-13](breaking-changes-before-2026-10-13.md). They still
apply when you upgrade from a source commit older than their date. Entries are
newest first. Steps marked _untested_ have not been run against a real
Installation. When this page nears the word limit, its oldest notices move to a
new page named for the date they precede.

## 2026-10-13: image repository paths must be lowercase; no @ before URL hosts

**What breaks.** Profile preflight refuses an uppercase letter in the repository
path of `controlPlane.controllerImage`, `runtime.image` or `repository.image`,
which Kubernetes refused to pull; an uppercase registry host or tag still
passes. The chart (`images.*`, `repositoryCredentials.image`,
`logging.collector.image`),
`prepare-bootstrap-volume`, `upgrade-production-images`, and API and worker
startup for the Compute gateway and Agent images refuse it too, and any other
reference Kubernetes cannot parse (`..` or an empty path component, a tag over
128 characters, non-ASCII letters); all of them accept an IPv6 registry host
(`[fd00::1]:5000/...`). Preflight, the chart, API
startup and the bootstrap Job also refuse any `@` before the `auth.baseUrl`
host (`https://@host`), which Node silently dropped; preflight refuses it in
`controlPlane.observabilityUrl`, and API and worker startup in
`observability.url`.

**Who is affected.** Profiles, values, tool flags or Installation YAML that use
those spellings.

**How to tell.** Preflight, the chart and the tools report `... repository path
must be lowercase`, the field's image reference message, or the URL field's
absolute-URL message. API startup logs
`AUTH_BASE_URL_INVALID` or `OBSERVABILITY_URL_INVALID`. Current API and worker
startup report `DRIVER_CONFIGURATION_INVALID` with `/images/gateway` or
`/images/agent` details for a refused runtime image; see the
[production startup flow](../../flows/production-startup.md).

**Steps.** Fix the image reference (lowercase its repository path, drop what
Kubernetes cannot parse), or delete the `@`, then render or restart again.

## 2026-10-13: channel proxy hosts must name one proxy address

**What breaks.** Startup refuses a channel proxy IPv4 host that is not four
decimal octets from 0 to 255 with no leading zeros. Shorthand, a single
integer, hex, and leading zeros used to allow egress to a different address.
Startup also refuses an unspecified host (`0.0.0.0`, `[::]`), which names no
destination, and an IPv4-mapped IPv6 host (`[::ffff:10.42.0.15]`), whose egress
never reached the proxy. Profile preflight refuses `0.0.0.0` in
`channels.runtimeProxyUrl`. Preflight, the chart and API startup also refuse it in the
Slack directory proxy (`channels.directoryProxyUrl`, `api.channelDirectoryProxyUrl`) with
`... must not use host 0.0.0.0, which names no proxy address`.

**Who is affected.** Installations whose `channels.proxyUrl` uses one of those
spellings. Canonical decimals, other IPv6 literals, and a managed Service proxy URL
still start.

**How to tell.** Startup fails with
`Channel proxy URL IPv4 host must be four decimal octets from 0 to 255 with no leading zeros; other spellings parse as a different address.`
or `Channel proxy URL host must not be an unspecified or IPv4-mapped IPv6 address; write the proxy's own IPv4 or IPv6 address.`

**Steps.** Write the proxy's own address, an IPv4 host as four decimal octets
(`127.0.0.1` for `0177.0.0.1`, `10.42.0.15` for `[::ffff:10.42.0.15]`), and
restart.

## 2026-10-13: shorthand observability IPv4 hosts are refused

**What breaks.** An observability URL whose IPv4 host is not four decimal
octets from 0 to 255, with no leading zeros, is refused. Shorthand, hex, a
single integer, and leading zeros used to be stored as a different address
(`192.168.1` became `192.168.0.1`; `2130706433` became `127.0.0.1`).

**Who is affected.** Profiles with `controlPlane.observabilityUrl`, and
Installations whose startup `observability.url` uses one of those spellings.
A canonical host such as `192.168.1.1`, and any DNS name, still loads.

**How to tell.** The profile reports `controlPlane.observabilityUrl IPv4 host
must be four decimal octets from 0 to 255 with no leading zeros; other
spellings parse as a different address.` API and worker startup log
`OBSERVABILITY_URL_INVALID`.

**Steps.** Write the four decimal octets you mean, then render or restart.

## 2026-10-13: IP database hosts are verified against the certificate

**What breaks.** A PostgreSQL URL whose host is an IP literal and whose TLS
mode verifies the server (`sslmode=verify-full`; without `uselibpqcompat=true`
also `prefer`, `require` and `verify-ca`; or `PGSSLMODE` set to one of those)
now requires the server certificate to list that IP as an IP subjectAltName, as
libpq does. Before, the check ran against the name `localhost`, so any
certificate for `localhost` signed by the database CA was accepted.

**Who is affected.** Installations that reach PostgreSQL by IP with a
certificate issued only for DNS names. DNS hosts, Unix sockets,
`sslmode=disable`, `no-verify`, and libpq-compatible `prefer`, `require` and
`verify-ca` are unchanged.

**How to tell.** The API logs `startup-error` and the worker logs
`worker.startup-error`, both with code `DATABASE_TLS_CERTIFICATE_INVALID` and
reason `ERR_TLS_CERT_ALTNAME_INVALID`. Bootstrap logs `PERSISTENCE_UNAVAILABLE`
and the migrator `MIGRATION_FAILED`.

**Steps.** Reissue the server certificate with `IP:<address>` in its
subjectAltName, or connect by a DNS name the certificate carries, then restart
the API and worker.

## 2026-10-13: more model credential header names and provider models lists

**What breaks.** The 2026-10-12
[model credential rules](breaking-changes-before-2026-10-13.md#2026-10-12-model-credentials-in-provider-headers-and-request-auth)
match more header names: every name ending in `key` or `keys` except an
idempotency or cache key, a last word of `bearer`, `credential`, `passcode`,
`passphrase` or `signature`, and plurals, such as `X-Auth-Key`,
`DD-APPLICATION-KEY` or `X-Hub-Signature-256`. Configuration create and update
and provisioning, and on Kubernetes Compute also Preset saves, Agent saves and
deployment, answer `400` for a `models.providers.<provider>.models` that is
not a list, which OpenClaw refused only when the Gateway started.
A later change also matches the words `authentication`, `assertion`, `hmac`,
`jwt`, `license`, `otp`, `pass`, `pin` and `pwd`, suffixes such as `-v2` and
`.` separators, but saves partition, shard, sort and dedup keys; on every
Compute, Configuration and Preset saves refuse a header name that is not a
valid HTTP field name, and Preset saves check `models`, `baseUrl` and `api`
(a variable without a default is checked once filled). A later change skips
a trailing algorithm word such as `-sha256` or `-ed25519` and a digit glued
to `key`, and matches `protection-bypass`. A later change quotes the header in
the Kubernetes message instead of a word list: `must not set the credential
header "X-Upstream-Pwd" (its name marks a credential)`; on Kubernetes a Preset
header name that waits on a variable saves, checked once filled. A later change
checks an escaped token (`\{{ vars.name }}`), or a default that reads like a
token, as written: it stays literal once filled, so such a header name,
`baseUrl` or `api` is refused at save instead of failing every launch. The
invalid header name refusal now quotes the header up to its first invalid
character: `must use valid HTTP header names, not "Bad…"`. A later change
refuses, on every Compute, a provider or model `baseUrl` with a user name or
password, like `request.proxy.url`, and checks a `baseUrl` or `api` that holds
only a `$${VAR}` escape as written: it is no reference. Preset saves match a
header name as the text around its variables (`Authorization{{ vars.suffix }}`)
and refuse a literal `baseUrl` scheme other than `http` or `https` however many
variables follow. A later change finds a user name or password in a `baseUrl`
or `request.proxy.url` whose host or port is a variable or `${VAR}` (or in its
`:-` fallback), refuses a variable as the whole user name, and names an invalid
first header character by code point: `not one that starts with U+007B`. A
Preset saved with one still reads but cannot launch: edit it. A later change
refuses one in `proxy.proxyUrl`, a channel or channel account `proxy`, an MCP
server `url` and any URL in an `env` map (skill, hook, sandbox, ...),
whatever the name (`HTTPS_PROXY`, `GOPROXY`); a `baseUrl` with an empty host
(`https:///v1`, as an empty variable leaves it);
and a number or boolean variable as the whole `baseUrl` or `api`. A later
change refuses a `baseUrl` without exactly `//` after `http:` or `https:`
(`https:/v1`, `https:${HOST}`, `https:{{ vars.host }}`), and a user name or
password in Codex's network proxy URLs and speech and Talk provider `proxy`
settings. A later change applies the header rule to MCP server `headers`
(also under `nodeHost`), and reads `GIT_CONFIG_VALUE_<n>` and
`GIT_CONFIG_PARAMETERS` values as proxies when their key names one, such as
`http.proxy`.

**Who is affected.** Configurations with such a header, such a URL with a
user name or password, or a `models` record, `null` or string on any provider.
A stored Configuration with such a user name or password, or with a `baseUrl`,
`api`, `models` or header name these rules refuse, does not deploy on any
Compute until it is edited (since 2026-10-16): deployment answers `400` with
the save's message.

**How to tell.** The 2026-10-12 messages,
`Configuration setting models.providers.<provider>.models must be an array of model entries.`,
`Configuration field <field> carries a user name or password in the URL.`,
`... must be an absolute http or https URL.`
or `... must start with https:// or http:// (the // after the scheme is missing).`

**Steps.** Follow the 2026-10-12 steps for the header. Write `models` as a
list of model objects, or remove it. Remove the user name and password from
the URL, or make the whole URL a `${NAME}` reference. Give a `baseUrl` its host
and write `//` after its scheme, and use a string variable for a whole `baseUrl`
or `api`.

## 2026-10-13: sign-in and repository CIDRs must be canonical decimals

**What breaks.** `helm upgrade` fails when a saved `auth.github.egressCidrs`,
`auth.google.egressCidrs`, `auth.oidc.egressCidrs`, or
`repositoryCredentials.upstreamCidrs` entry has a leading-zero octet, such as
`140.82.112.08/20`. That value used to render, and the apiserver accepted it
with a warning. The upgrade now stops before it writes that policy.

**Who is affected.** Saved releases that use a leading-zero octet in one of
those lists. A canonical decimal such as `140.82.112.0/20` or `140.82.112.8/20`
still upgrades.

**How to tell.** Helm stops with
`auth.github.egressCidrs requires explicit IPv4 CIDRs with prefixes 1 through 32`,
or the same sentence for `auth.google.egressCidrs`, `auth.oidc.egressCidrs`, and
`repositoryCredentials.upstreamCidrs`.

**Steps.** Write the canonical decimal (`140.82.112.8/20` for
`140.82.112.08/20`) and upgrade again.

## 2026-10-13: remote node CIDRs must be canonical

**What breaks.** `helm upgrade` fails when a saved
`gatewayRouting.remoteNodeCidrs` entry uses a leading zero, such as
`010.0.0.1/32` or `::ffff:010.0.0.1/128`. Those values used to render, and the
apiserver accepted them with a warning. The upgrade now stops before it writes
that policy.

**Who is affected.** Saved releases that use a leading-zero spelling. Canonical
values still upgrade, including `10.0.0.1/32`, `0.0.0.0/0`, `::/64`, and
`::ffff:10.0.0.0/120`. An empty list and `null` still omit the ingress block.

**How to tell.** Helm stops with
`gatewayRouting.remoteNodeCidrs requires an IPv4 or IPv6 CIDR` for
`010.0.0.1/32`, and with
`gatewayRouting.remoteNodeCidrs contains an invalid IPv6 address` for
`::ffff:010.0.0.1/128`.

**Steps.** Write the canonical value (`10.0.0.1/32` for `010.0.0.1/32`, and
`::ffff:10.0.0.1/128` for `::ffff:010.0.0.1/128`) and upgrade again.

## 2026-10-13: execution API CIDRs must be explicit and nonzero

**What breaks.** `helm upgrade` fails when a saved `executionCluster.apiCidrs`
entry is `0.0.0.0/0`, `::/0`, or a leading-zero address such as `010.44.0.2/32`.
Those values used to render. A `/0` became egress to any address on the
execution API port, and the apiserver accepted the leading-zero form with a
warning. The upgrade now stops before it writes that policy.

**Who is affected.** Saved releases that use one of those spellings. A canonical
IPv4 CIDR with prefix 1 through 32, such as `192.0.2.0/28`, and a canonical
IPv6 CIDR with a nonzero prefix, such as `2001:db8::/64`, still upgrade. A
disabled execution cluster is not checked.

**How to tell.** Helm stops with
`executionCluster.apiCidrs requires an explicit IPv4 or IPv6 CIDR with a nonzero prefix`.

**Steps.** Replace `0.0.0.0/0` or `::/0` with the execution API addresses you
mean to allow. Rewrite `010.44.0.2/32` as `10.44.0.2/32`. Upgrade again.

## 2026-10-13: OpenShell gateway readiness requires timeoutMs

**What breaks.** Controller startup fails when `gateway.readiness` is set and
`timeoutMs` is omitted. That configuration starts today. The field must be a
positive safe integer. Omitted readiness is unchanged.

**Who is affected.** Installations, and the real k3d helper, that set
`gateway.readiness` with only `serviceName` and `podSelector`.

**How to tell.** Startup logs `startup-error` with code `STARTUP_FAILED`. The
Installation loader reports `OpenShell gateway readiness timeout must be a
positive safe integer.` The message does not name `timeoutMs`.

**Steps.** Set `gateway.readiness.timeoutMs` to a positive millisecond window.
The real helper uses 120000. Then start again.

## 2026-10-13: demo cluster CIDRs must be one canonical IPv4 host

**What breaks.** The observability demo `helm upgrade` fails when
`cluster.cidrs` is not one canonical IPv4 `/32`.

**Who is affected.** Demo releases whose saved `cluster.cidrs` are not that
form.

**How to tell.** Helm stops in `prometheus.yaml` with `cluster.cidrs requires
exact IPv4 /32 endpoints`.

**Steps.** Write the canonical spelling (`010.0.0.1/32` becomes `10.0.0.1/32`)
and upgrade again.

## 2026-10-13: OpenShell network policy names must be unique

**What breaks.** Controller startup refuses an Installation whose
`policy.networkPolicies` repeat a name, or name a policy
`workspace-node-enrollment`. Those configurations start today. A duplicate name
keeps only the last rule. A policy named `workspace-node-enrollment` is replaced
when a workspace-node binding exists.

**Who is affected.** Installations with duplicate policy names, or with a policy
named `workspace-node-enrollment`.

**How to tell.** Startup logs `startup-error` with code
`OPENSHELL_NETWORK_POLICY_NAME_REJECTED` and reason `rename-or-merge`. The log
does not include the policy name. Loading the Installation configuration names
the duplicate or reserved policy.

**Steps.** Rename or merge duplicate `policy.networkPolicies` names. Rename a
policy called `workspace-node-enrollment`. Keep each policy's binaries and
endpoints. _untested_ against a live Installation.

## 2026-10-13: OpenShell `openai` credential sources need replacing

**What breaks.** Each OpenShell credential source now owns its provider profile.
An `openai` source registered by an earlier build points its provider at the
shared `oce-openai` profile, so OCC no longer treats that provider as the
source's. A deployment that lists the source fails. Deleting the source through
OCC leaves it `deleting` until its provider is removed by hand.

**Who is affected.** Installations with OpenShell `openai` credential sources.
`bearer-token` and OAuth2 sources already owned their profiles and are
unaffected.

**How to tell.** The source's `status` is `failed`, with "The OpenShell
provider is not owned by this source."

**Steps.** After upgrading, replace each such source, _untested_:

1. Register a replacement `openai` source from the same Secret. It gets its own
   profile.
2. For each Agent bound to the old source:
   - Grant the Agent's service principal `operate` on the replacement.
   - Update the Agent so that `credentialSources` lists the replacement instead
     of the old source, and `harnessAuth.sourceId` names the replacement.
   - Deploy it, and wait until OCC selects the new version.

   OCC refuses to delete a source with `409` while an Agent, its selected
   version, or a pending deployment still references it.

3. In the Namespace's OpenShell Workspace, delete each old source's provider:
   the one labeled `openclaw.dev/credential-source-id` with the source's ID.
   OpenShell refuses while a Sandbox still lists it, so the old version's
   Sandbox must be gone. Then delete the old source through OCC. A `404` while
   `GET` shows `deleting` means the provider remains; a
   `409 CREDENTIAL_WITHDRAWAL_IN_PROGRESS` means retry after withdrawal work
   finishes.
4. Once no old `openai` provider remains, delete the `oce-openai` profile.
   OpenShell refuses while a provider still uses it.
