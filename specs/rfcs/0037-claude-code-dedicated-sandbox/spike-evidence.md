# RFC-0037 spike evidence

Back to the [proposal](index.md).

On 2026-11-11 we ran a disposable spike on a remote test VM. It took about 25
minutes. The setup was a k3d cluster with Agent Sandbox v0.5.2 and stock
OpenShell 0.1.6, at the digests in `internal/occdev/openshell.go`.

The workload image was the OCE runtime image plus the Claude Code 2.1.304
binary, installed the same way as draft #3027. It contained:

- managed settings rendered by a copy of #3027's `claudeCodeManagedSettings`;
- a configuration directory at `/etc/claude-code-config`.

The workload uid owned the managed settings and the configuration directory,
so only OpenShell policy could refuse writes to them.

The model was a self-hosted Anthropic-compatible model endpoint. An in-cluster
relay sat in front of it and logged each request's method, path, user agent and
status. It also recorded whether the credential arrived as a placeholder or had
been substituted. It never logged header values.

The OpenShell provider profile contained:

- one credential, `ANTHROPIC_API_KEY`, sent as `x-api-key`;
- one REST endpoint, the relay, with access `read-write` and enforcement
  `enforce`;
- the binary `/usr/local/bin/claude`.

The Sandbox policy used OCE's default filesystem lists and Landlock
`hard_requirement`. It added `read_write` only for
`/etc/claude-code-config/projects`.

Nothing in this spike exercised OCE's Controller, Gateway or OpenClaw worker.
The spike scripts were not committed.

<a id="pod"></a>

## Sandbox identity and Pod shape

```text
id: uid=10001 gid=10001 groups=10001
ANTHROPIC_API_KEY: set, len=60, shape=<opaque>:<opaque>:env:<opaque>
CapEff:	0000000000000000
NoNewPrivs:	1
Seccomp:	2
/usr/local/bin/claude
2.1.304 (Claude Code)
init openshell-sandbox-bootstrap  ... capabilities drop ALL, readOnlyRootFilesystem
init workspace-init               ... runAsUser 10001
container agent ["/.openshell/runtime/openshell-sandbox", "--bootstrap", ...]
```

The placeholder had the form `openshell:resolve:env:v<hex>_ANTHROPIC_API_KEY`
and was scoped to the revision.

<a id="turn"></a>

## Real turn

```text
INIT tools=[] apiKeySource=ANTHROPIC_API_KEY permissionMode=default
TEXT HERON-7731
RESULT subtype=success is_error=false turns=1 ms=998
relay: POST /v1/messages?beta=true ua="claude-cli/2.1.304 (external, sdk-cli)" auth=substituted status=200
```

<a id="bash"></a>

## Native Bash under OpenShell policy

The model was given `--tools Bash`. It then ran a probe script with the Bash
tool (`turns=2`, `RESULT success`).

| Test | Result |
|---|---|
| T1: overwrite `/etc/claude-code/managed-settings.json` | `Permission denied` |
| T2: create `managed-settings.d` | `Permission denied` |
| T3: plant `settings.json` in the configuration directory | `Permission denied` |
| T4: plant `remote-settings.json` | `Permission denied` |
| T5: rename the configuration directory | `Permission denied` |
| T6: write the transcript directory | ok |
| T7: write the workdir | ok |
| T8: `example.com:443` | denied: `NET:OPEN DENIED ... [reason:transparent_tcp_policy_denied]` |
| T9: telemetry host | denied |
| T10: vendor API host | denied |
| T11: model endpoint from a `curl` child of `claude` | **reached it, with the credential substituted:** `GET /v1/models ua=curl auth=substituted status=200` |
| T12: `169.254.169.254` | denied |
| T13: `kubernetes.default.svc` | denied |

T11 is the important result. The same `curl` run through Sandbox exec, outside
`claude`, was denied:
`binary '/usr/bin/curl' not allowed in policy '_provider_ccd' (ancestors: [/usr/bin/bash -> ...])`.

So OpenShell applies a provider rule to every descendant of a listed binary.
The model never sees the key. It can, however, spend it on any route the
profile allows.

<a id="l7"></a>

## Messages-only L7 rules (live update)

We updated the profile in place to allow only `POST /v1/messages` and
`POST /v1/messages/count_tokens`. After the update:

- turns still passed (`?beta=true` matched);
- a model-driven `curl` of `GET /v1/models` was refused:

```text
{"error":"policy_denied","rule":"GET /v1/models","layer":"l7","protocol":"rest",...}  code=403
```

<a id="credential"></a>

## Credential delivery

| Method | Result |
|---|---|
| Placeholder in the process environment | Turn passed. |
| Placeholder over fd 3 (`CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=3`), environment variable removed, as OpenClaw passes credentials | `EGRET-5508`, success in 2.1 s. |
| Static placeholder baked into managed settings | `API Error: 500 Credential placeholder could not be resolved` after 182.6 s of retries. The request never reached the endpoint. |

With the key revoked at the endpoint, `claude` retried for 173 s before
reporting `Failed to authenticate. API Error: 401`.

<a id="telemetry"></a>

## Telemetry

We built a variant without #3027's telemetry denial. It passed two turns, and
it also made the following attempts:

- `HEAD /api/hello` (user agent `Bun`) to the model base URL;
- six attempts to the vendor API host, each denied by OpenShell:

```text
NET:REFUSE DENIED api.anthropic.com [reason:policy_dns_ineligible]
NET:OPEN DENIED /usr/local/bin/claude(0) -> api.anthropic.com:443 [reason:transparent_tcp_policy_denied]
```

With the denial in place, the same Sandbox logged no denied connection from
`claude`.

<a id="resume"></a>

## Resume with a read-only configuration directory

A turn with `--session-id` taught the model `KESTREL-9043`. A second turn with
`--resume` recalled it. The transcripts were written under
`projects/-sandbox/*.jsonl`. Everything else in the configuration directory
stayed read-only.

## Not covered

The spike did not cover:

- an OpenClaw worker driving `claude`;
- OCE admission and the Console;
- persistent volumes across a Pod restart;
- `read_only` volume mounts, as opposed to Landlock;
- managed-settings precedence under the full OCE environment;
- Stop and Delete.

The proposal's acceptance criteria cover all of these.
