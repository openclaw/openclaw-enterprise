# Breaking-change notices

OpenClaw Enterprise (OCE) is pre-alpha and has no stable release, so a newer
main can refuse or break an Installation that an older build created. Each
change like that gets an entry here: what breaks, who is affected, how to tell,
and the steps. Before an upgrade, read every entry dated after the source commit
you run now, here, in the [earlier notices](breaking-changes-archive.md), in the
[notices before 2026-10-13](breaking-changes-before-2026-10-13.md), in the
[notices before 2026-10-12](breaking-changes-before-2026-10-12.md), in the
[notices before 2026-10-11](breaking-changes-before-2026-10-11.md) and in the
[notices before 2026-10-10](breaking-changes-before-2026-10-10.md),
then follow the [upgrade checklist](upgrade-checklist.md) and
[production image upgrades](production-upgrade.md).

Entries are newest first. Steps marked _untested_ have not been run against a
real Installation.

## 2026-10-16: stored model provider settings are checked at deploy

**What breaks.** On every Compute, deploying or redeploying an Agent runs the
Configuration save's model provider rules on the stored Configuration. A
Configuration an older build stored with a provider or model `baseUrl` that is
not an absolute `http` or `https` URL (`ftp://models.example/v1`, `/v1`,
`https:/v1`), an `api` the runtime does not support, or a header name that is
not a valid HTTP field name used to deploy, and then failed at the model probe
or not at all. Deployment now answers `400` and creates no version, even for a
provider the Agent does not use. A provisioning attempt queued before the
upgrade is rejected without retry.

**Who is affected.** Agents whose stored Configuration holds such a value.
Header names were already checked at deploy on Kubernetes Compute.

**How to tell.** The deploy `400` carries the save's message, such as
`Configuration field /models/providers/<provider>/baseUrl must be an absolute http or https URL.`
or `... must name a model API the runtime supports, ...`. A rejected queued
attempt records `PROVISIONING_REJECTED` with the same message.

**Steps.** Edit the Configuration: fix or remove the field the message names,
save, and deploy again.

## 2026-10-14: OAuth2 token_url hosts must be DNS names

**What breaks.** Creating an OpenShell `oauth2-client-credentials` or
`oauth2-refresh-token` credential source refuses a `token_url` whose host is an
IP address in any spelling (`10.0.0.5`, `0x7f000001`, `127.1`, `[::1]`), a
`localhost` name, a name ending in `.localdomain`, `.localdomain4` or
`.localdomain6`, or a single-label name (`keycloak`, `ip6-localhost`). Those
are the shapes of the loopback, link-local and own-hostname aliases in the
gateway Pod's `/etc/hosts`. The OpenShell gateway posts the source's client secret and
refresh token to that URL from its own network position. A deployment that
binds an existing source with such a `token_url` fails. Until it is deleted,
the gateway keeps refreshing that source against the stored `token_url`, and
rotating it does too. DNS names, including
in-cluster Service names such as `keycloak.idp.svc.cluster.local`, stay
accepted. Names that reach the gateway Pod itself are refused too: a Pod DNS
name (`10-42-0-5.idp.pod.cluster.local`), also with extra leading labels or
without the cluster domain (`x.10-42-0-5.idp.pod`), and, when the OpenShell Backend's
`endpoint` or `serviceName` names the gateway's namespace, any name in that
namespace (`openshell-gateway.openshell-system.svc`,
`openshell-gateway-0.openshell-gateway-peer`, `grpc.tcp.openshell-gateway`). OCC now stores `token_url` in
normalized form (`https://Login.Example.test:443/token` becomes
`https://login.example.test/token`). A `bearer-token` or OAuth2 `host` ending in a
numeric or `0x` label (`0x7f.0x1`, `example.123`) is refused like an IP address.

**Who is affected.** Installations with OAuth2 credential sources whose issuer
is addressed by IP address, a `localhost` name, a single-label name, a Pod DNS
name, or a name in the OpenShell gateway's namespace, and `bearer-token` or
OAuth2 sources whose `host` ends in a numeric or `0x` label.

**How to tell.** Creation returns `400` for `/config/token_url` with `... token_url
host must be a DNS name with at least two labels, not an IP address or a
localhost or localdomain name.` or `... token_url host must not be a Kubernetes
Pod name or a name in the OpenShell gateway's namespace.` A deployment that binds such a source fails with the same
message, or with `... token_url port must be 1 to 65535.` for a stored port `0`. `GET` on the source shows
its stored `config.token_url`. Creation with such a `host` returns `400` for
`/config/host` with `... host must be an exact DNS name.`, and deploying or
updating the value of a stored source with such a `host` fails with the same
message.

To find affected sources before upgrading, print every source's `token_url`
and `host` with the [CLI](../../reference/cli.md) and `jq`, as an account that
can read every Namespace and credential source (lists return only readable ones):

```sh
for ns in $(occ namespace list -o json | jq -r '.[].id'); do
  occ credential-source list --namespace "$ns" -o json | jq -r '.[]
    | select(.config.token_url or .config.host)
    | [.namespaceId, .id, .type, .config.token_url // "-", .config.host // "-"]
    | @tsv'
done
```

Compare each host with the shapes under **What breaks**. This was checked
against the CLI and the list response shape, not a live Installation.

**Steps.** _untested_ against a live Installation:

1. Give the issuer (or, for a `host`, the protected API) a DNS name its TLS
   certificate covers, such as its Service name with its Namespace
   (`keycloak.idp.svc.cluster.local`).
2. Register a replacement source with that `token_url` or `host`.
3. For each Agent bound to the old source, grant its service principal
   `operate` on the replacement, list the replacement in `credentialSources`
   instead of the old source, and deploy.
4. Delete the old source. That also stops the gateway refreshing its token
   against the old URL.

<span id="2026-10-14-preset-and-revision-lists-return-summaries-revisions-page" class="anchor-alias"></span>

## 2026-10-14: Preset and Agent revision lists return summaries and use pages

**What breaks.** `GET .../presets` items carry only `id`, `namespaceId`, `name`
and `createdAt`, without `template`. `GET .../agents/{agentId}/revisions` items
carry identity, `configurationId`, `configurationGeneration`, `harness` and
`createdAt`, without the saved settings or `configurationReadError`. Versions
list newest first, 50 to a page (`limit` up to 100), and `meta.nextCursor`
names the next page.

**Who is affected.** API clients and scripts (including
`occ preset list -o json`) that read templates or saved settings from these
lists, or expect every version in one response. Operators who run `occ agent revisions` with an `occ`
built before this change: it exits `0` but prints only the newest 50 versions,
with no hint that older ones exist.

**How to tell.** List items lack `template` or `configuration`, and
`meta.nextCursor` is set. An older `occ agent revisions --help` lists no
`--cursor` flag, and a full page ends without the `older revisions may exist`
notice.

**Steps.** Read one Preset or version by ID for its document
(`occ preset get ID -o json`). Pass `meta.nextCursor` back as `cursor` until it is `null`.
Upgrade `occ` to the release your controller runs
([CLI setup](../cli.md#connect-to-your-installation)), then pass the
`--cursor` each full page prints to read older versions.

## 2026-10-14: every model selection must use the Harness provider

**What breaks.** On Kubernetes Compute, Configuration, Preset and Agent saves
and deployment refuse a model selection off the primary model's provider:
fallbacks, Agent entries, `subagents.model` and the other `*Model` settings,
`models` policy keys, `modelPolicy.allow`, hook models,
`channels.modelByChannel`, and an `apiKey` on another `models.providers`
entry (`openrouter:auto` and `openrouter:free` count as `openrouter`).
Dedicated Codex refuses every `apiKey`, `mediaModels` and `voiceModel`, and
unqualified policy entries. Every Compute refuses another-provider fallbacks at
save. A Preset variable's provider is checked at launch; a number
or boolean model variable is refused. Preset saves also check `agents` rosters.
Every Compute also refuses a literal key in `memory.search.remote` (also per
Agent), `tools.media` requests, speech and Talk provider `apiKey`s, web fetch,
OpenTelemetry and edge auth credential headers, skill `apiKey`s and
`cron.webhookToken`, and a header name there or in MCP `headers` that is not an
HTTP field name. It also refuses a literal secret in the other slots OpenClaw
marks sensitive: Gateway, hooks, sandbox SSH and storage secrets, and channel
and plugin settings such as `botToken` or `webSearch.apiKey`
([list](../../reference/configuration/secrets.md#secret-boundaries)). Preset
saves also refuse a literal `gateway.auth.password` or invalid `approvalPolicy`;
provisioning checks `agents` rosters.

**Who is affected.** Configurations and Presets that select a second provider
or give it an `apiKey`, set an `apiKey`, media or voice model for Dedicated
Codex, or hold a literal key or secret in one of those slots.

**How to tell.** A `400` names the setting: `... must select
<provider>/<model>, the provider of the Agent's Harness authentication
binding`, `... must use the primary model's provider`, `... must be
provider/model references`, `... must be unset`, or `... holds a credential
value inline, where a reference is required`.

**Steps.** Move or remove the setting the `400` names, keeping only the
primary model's provider, or make a literal key a `${NAME}` reference or a
SecretRef, then save and deploy again.

## 2026-10-14: observability URLs must not hide another host

**What breaks.** Profile preflight and API and worker startup refuse an
`observability.url` that contains a tab, newline, or a backslash before the
query. The parser stored a different host. A backslash in the query stays.

**Who is affected.** Profiles with `controlPlane.observabilityUrl`, and
Installations whose startup `observability.url` uses one of those characters.

**How to tell.** Preflight reports `controlPlane.observabilityUrl must not
contain a tab or newline, or a backslash before the query`. Startup logs
`OBSERVABILITY_URL_INVALID`.

**Steps.** Write the host you mean, with no tab, newline, or backslash before the
query, and upgrade. _untested_ against a live Installation.

## 2026-10-14: proxy and MCP URLs must name a host

**What breaks.** Configuration and Preset saves refuse a proxy, channel proxy,
MCP server, or plugin URL whose authority is empty (`https:///v1`) or whose
`//` is missing (`https:/v1`).

**Who is affected.** Configurations and Presets that save one of those
spellings in a proxy, channel, MCP, or plugin URL.

**How to tell.** The save answers `400` naming the field: `has an empty
authority or a missing //, which parses as a different host.`

**Steps.** Write an absolute http or https URL with the host you mean, and
save again.

## 2026-10-14: OpenShell gateway IPv4 hosts must be four decimal octets

**What breaks.** Startup and both gateway clients refuse an OpenShell
`endpoint` whose IPv4 host is not four decimal octets with no leading zeros.

**Who is affected.** Backends whose `configuration.endpoint` uses one of those
spellings.

**How to tell.** The report says `IPv4 host must be four decimal octets`.

**Steps.** Write those four octets, then restart.

## 2026-10-14: model endpoint URLs refuse rewritten spellings and IP hosts

**What breaks.** Creating an OpenShell `openai` credential source refuses a
`base_url`, and Kubernetes Compute startup refuses `runtime.codexModelBaseUrl`,
with a space or control character, without the `//` after `https:`, or with an
`@` before the host (`https://@host/v1`), which the URL parser silently
rewrote. An `openai` source host must be an exact DNS name, like a
`bearer-token` host: an IP address in any spelling (`127.0.0.1`,
`0x7f000001`, `127.1`) or a label with `_` or an edge `-` is refused. A
deployment or Secret update of an existing source with such a host or spelling
fails. A new source stores its
`base_url` normalized (`https://API.example.com:443/v1/` as
`https://api.example.com/v1`).

**Who is affected.** Sources or Compute settings that use those spellings, and
`openai` sources with such a host.

**How to tell.** Creation returns `400` for `/config/base_url`, with `... host
must be an exact DNS name.` or the spelling's message. Compute startup reports
`Codex model endpoint must ...` or `... requires HTTPS ...`. A deployment with
such a source fails with `The OpenShell endpoint requires HTTPS, ...`.

**Steps.** Fix the spelling. Replace such a source with one whose endpoint is a
DNS name its certificate covers, as the
[`openai` source replacement notice](breaking-changes-archive.md#2026-10-13-openshell-openai-credential-sources-need-replacing)
describes. _untested_ against a live Installation.

## 2026-10-14: Codex model IPv4 hosts must be four decimal octets

**What breaks.** `runtime.codexModelBaseUrl` whose IPv4 host is not four decimal
octets with no leading zeros is refused.

**Who is affected.** Kubernetes Compute settings that set
`runtime.codexModelBaseUrl` to one of those spellings.

**How to tell.** Compute reports `Codex model endpoint IPv4 host must be four
decimal octets`.

**Steps.** Write those four octets, then start again.

## 2026-10-14: gateway hostnames must not be rewritten IPv4

**What breaks.** Helm and Compute refuse rewritten or URL-parser-invalid IPv4 in
`gatewayRouting.hostname` and harness `routing.hostname`. Sandbox suffix
`gatewayRouting.sandbox.domain` also refuses canonical IPv4: an Agent label
cannot precede an address. Nonfinal hex labels remain accepted.

**Who is affected.** Helm values or Installation YAML using those spellings.

**How to tell.** Diagnostics name the invalid field and suggest its correction.

**Steps.** Use a DNS name resolving to the Gateway that its certificate covers;
the `openclaw-enterprise` chart requests a DNS SAN, not an IP SAN. For harness
`routing.hostname`, use a name covered by the operator's `routing.tlsSecretName`
certificate. Use a DNS suffix such as
`previews.example.test` for sandbox. Correct Helm/Installation values, then upgrade.
_untested_ against a live Installation.

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
