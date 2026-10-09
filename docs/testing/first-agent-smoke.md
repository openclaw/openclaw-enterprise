# First Agent smoke

The `First Agent Smoke` job in the [CI workflow](../../.github/workflows/ci.yml)
installs this checkout the way a new user does and drives two Agents through
their first deployment, a model turn, logs, stop, and start. It needs no secrets,
so it runs on every pull request and every push to `main`.

It is **not** a `CI Required` dependency. A failure is visible on the pull request
but does not block merging. Making it required is a maintainer decision.

## What it runs

[`scripts/ci/first-agent-smoke.mjs`](../../scripts/ci/first-agent-smoke.mjs) has
two commands, run as separate workflow steps:

1. `images` builds the controller and runtime images from the checkout, reading
   the hosted image caches that the Images and Packaging lane writes. It adds a
   private test CA to the runtime image's trust store, pushes both images to a
   loopback registry, and exports their digests as
   `OCC_DEVELOPMENT_CONTROLLER_IMAGE` and `OCC_KUBERNETES_RUNTIME_IMAGE`.
2. `run` performs the smoke:
   - starts the Kubernetes-only [Local Setup](../guides/quickstart.md) with
     `occ dev up` and those images;
   - routes `api.openai.com` inside the cluster to the stand-in provider;
   - runs `scripts/first-agent.mjs` unchanged with a placeholder key to deploy an
     embedded OpenClaw Agent and verify its model reply;
   - creates and deploys a dedicated Codex Agent through the API the console
     uses: Namespace Secret, exact Secret grant, transport credentials, deploy;
   - sends a chat turn through the Codex Agent's gateway;
   - reads both Agents' logs with `occ agent logs`;
   - stops both Agents with `occ agent stop`, then starts them with
     `occ agent deploy`, and sends a chat turn to each new revision.

The step table in the job summary records each phase's duration.

## What a pass proves

Each reported status is checked against the cluster and a model turn:

- A deployment counts only when its status is `succeeded` and the Agent reports
  that revision active. A `failed` status fails the job at once with its error code.
- A chat turn must return a fresh nonce, and the stand-in provider must log that
  it answered the same nonce, so the reply came from a real model request
  through the Agent's own runtime.
- After a stop, the Agent must report `desiredRuntimeState: stopped`, clear its
  active revision, and have no running Pods.
- A start must admit a new revision and serve a chat turn from it.

## Stand-in model provider

The provider is [`tests/fixtures/runtime-model-probe-endpoint.mjs`](../../tests/fixtures/runtime-model-probe-endpoint.mjs),
also used by the runtime image tests. It speaks the Responses API over HTTPS and
the WebSocket upgrade Codex uses, and echoes the request's nonce.

It runs in a container of the runtime image on a Docker network attached to the
k3d node. CoreDNS answers `api.openai.com` with its address through the
`coredns-custom` ConfigMap. Agent NetworkPolicies allow model egress only to
public addresses on TCP 443, and OpenClaw refuses provider addresses in private
or special-use ranges, so the provider uses `11.111.0.2`. That address is
routable only on the runner's Docker network.

After restarting CoreDNS, the smoke waits until the API proxy Pod resolves both
the API Service and `api.openai.com` to the provider before it calls the API.

The runtime image differs from the checkout's image by one layer: the test CA
in the system trust store (`SSL_CERT_FILE`) and in `NODE_EXTRA_CA_CERTS`. No
product code or Agent configuration is changed for the smoke.

## Node resolver

Local Setup starts its k3d node with `IPTABLES_MODE=legacy`. On the hosted
Ubuntu 22.04 runner, whose Docker uses iptables-nft, k3d's default node
resolver refuses queries. `occ dev up` therefore gives the node the runner's
upstream resolver on Linux Docker by default, and the smoke sets nothing. See
[Resolve node DNS failures](../guides/deploy/local-kubernetes-development.md#resolve-node-dns-failures).

## Docker Hub mirror

The job runs on a GitHub-hosted runner whose egress addresses other users share.
Pulls carrying the runner's built-in Docker Hub sign-in have been refused with
Docker Hub's anonymous rate limit. Before Buildx starts, the job points the runner's Docker
Engine and the Buildx builder at the public `mirror.gcr.io` mirror. The mirror
refuses any credentials, and the Engine forwards the client's Docker Hub
sign-in to it, so later steps use a Docker client configuration without
credentials. Pinned digests are still verified. An image the mirror lacks falls
back to Docker Hub anonymously, which can still hit the limit. The last step
prints which endpoint served each Engine pull; a fallback shows as
`Attempting next endpoint`. Images that the k3d node's containerd pulls inside
the cluster still come from their own registries.

## Limits

The smoke does not prove real model compatibility, credentials, hosted search,
Slack, OpenShell, gateway routing from a browser, or upgrades of an existing
installation. Use the [manual integration lanes](ci-manual-integration.md) for
those.

## Troubleshooting

On failure the job prints the stand-in provider's events, Pods, events, each
Agent's deployment status and logs, and the platform Pod logs. `occ dev up`
deletes its cluster when it fails, so while it runs the smoke also records Pods,
warning events, node conditions, and details of Pods that stay unready, and
prints them if Local Setup fails. The model key is a
placeholder and the cluster is discarded with the runner.

Run it locally only on a disposable Linux host with Docker, k3d, kubectl, Helm,
Go, and enforced NetworkPolicies:

```sh
go build -trimpath -o bin/occ ./cmd/occ
node scripts/ci/first-agent-smoke.mjs images
node scripts/ci/first-agent-smoke.mjs run
```

Set `OCC_FIRST_AGENT_SMOKE_DIRECTORY` to choose the work directory. The script
creates fixed-name containers and a fixed Docker network; remove them and run
`occ dev down` with the printed state directory afterward.
