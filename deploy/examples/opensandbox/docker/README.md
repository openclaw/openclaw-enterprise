# Check Codex startup in OpenSandbox on Docker

This probe starts the packaged Codex app-server through the OpenSandbox
lifecycle server. A peer container sends `initialize` through the OpenSandbox
execution daemon (`execd`). The probe generates its own credentials.

Use Node.js 24, CPython 3.12, uv, and a local Linux amd64 Docker daemon with a
Unix socket. Cache both images below. Use a disposable daemon and run one
OpenSandbox server at a time. On startup, the server can adopt or expire
existing allocations and remove orphaned egress sidecars. The probe refuses
existing allocations, egress sidecars and execd installers, including stopped
containers. Keep other OpenSandbox clients off the daemon throughout the
check.

From the OpenClaw Enterprise (OCE) repository root, set `opensandbox_source`
to a clean checkout at `d098823411816e73381cfedc7d10429e55bf5b31`.

```sh
umask 077
opensandbox_source=/path/to/OpenSandbox
probe_dir="$(mktemp -d)"
runtime_image=ghcr.io/openclaw/openclaw-enterprise-runtime@sha256:05247b40b16fd6f1154198d783f35b06c7313444858dc7603802e7f62365e2f8
execd_image=docker.io/opensandbox/execd@sha256:7881f066cbe817f610c2221f292abe73fde05518a37167bc3d1bf974c3c7987a

UV_CACHE_DIR="$probe_dir/uv-cache" UV_PROJECT_ENVIRONMENT="$probe_dir/venv" uv sync \
  --project "$opensandbox_source/server" --python "$(command -v python3)" \
  --frozen --no-dev --no-install-project

node deploy/examples/opensandbox/docker/probe.mts \
  "$opensandbox_source" "$probe_dir/venv/bin/python" "$runtime_image" "$execd_image"
```

If Docker has exhausted its address pool, check host routes and Docker networks.
Set `OCE_OPENSANDBOX_PROBE_SUBNET` to an unused local IPv4 subnet and retry.

Look for `codex-peer` with `initialized: true`. The three HTTP 401 results
cover a missing execd token and a missing or incorrect Codex token. The
lifecycle server listens on loopback. The peer uses the internal Docker
network, so success says nothing about host access to Codex.

Check `sandbox-cleanup` and `network-cleanup` for zero remaining containers
and networks. If cleanup fails, the probe reports the allocation label and
keeps the private server state. Inspect Docker with `docker container ls -a
--filter "label=$label"` and `docker network ls --filter "label=$label"`,
using the full reported `key=value` pair. Verify ownership and remove only
the trial resources. Confirm they are gone before deleting the state or
rerunning the probe. The state contains the lifecycle key. Keep `probe_dir` for the
[Git access check](../git/README.md) or remove it after cleanup.
