# Run Strands Box from the integration branch

Use `demo/strands-box-one-repo` for new work on the [in-Pod driver](../../../docs/reference/drivers/strands-box.md).
The Helm Worker deploys a dedicated Codex Agent. The supervisor authenticates the Gateway, Box
isolates the workload, and a separate file node serves its workspace. **The ordinary model key
is readable by Codex.** Use this path for sandbox evaluation with a test credential.

## Build the ARM image

Use Linux ARM64 with Git, the [Box build prerequisites](https://github.com/Kimiyu-186/box/tree/6e46f190d8f953f519ae03d47a342a95f8701beb), Rust 1.98.1 and Docker.
[Box #482](https://github.com/strands-agents/box/pull/482) supplies the container receiver.
From this checkout, set `OCE_RUNTIME_IMAGE` to the matching [base runtime by digest](../../../docs/guides/deploy/published-images.md).
Choose a new context directory. Set `TMPDIR` and an absolute `CARGO_TARGET_DIR` on scratch storage to reuse build output.

```sh
ctx="$(mktemp -d)/context"
bash deploy/examples/strands-box/prepare-image.sh "$ctx"
(cd "$ctx" && sha256sum --check SHA256SUMS)
docker build -t oce-strands:local --build-arg OCE_RUNTIME_IMAGE="${OCE_RUNTIME_IMAGE:?}" \
  --build-arg STRANDS_BOX_SOURCE_REVISION="$(cat "$ctx/box-revision")" "$ctx"
```

Select that image for the Agent in Kubernetes Compute. Install the [node profile](../../../scripts/generate-strands-box-seccomp.ts)
on the selected ARM nodes. Select `strands-box-sandbox`, configure the DNS and control-plane peers
and permitted destinations, and enable `strandsBox.workerReadiness` in Helm.
Use the [driver settings](../../../docs/reference/drivers/strands-box.md) and
[installed test results](https://github.com/openclaw/openclaw-enterprise/pull/6370).
Verify a model reply, a workspace write/read and a denied private file. From inside Box, try
an allowed and a denied destination, then try direct access with the proxy disabled.
Check which requests reached each receiver.

## Reproduce the protected GitHub pilot

The [original runbook](https://github.com/openclaw/openclaw-enterprise/blob/2617ebce1e0c7e148315fd3b6de4c24ab30a6f8f/deploy/examples/strands-box/RUNBOOK.md)
uses an operator-started host and a different Box fork. Its source and database migrations are
preserved together at the original commit in this branch's history. Use a fresh database and a
separate checkout for the x86 pilot.

```sh
git worktree add --detach ../strands-pilot 2617ebce1e0c7e148315fd3b6de4c24ab30a6f8f
cd ../strands-pilot/deploy/examples/strands-box
```

The pilot demonstrated five GitHub App drafts. Moving that behavior to the in-Pod driver
requires a credential holder outside the workload and authorization of each outgoing request.
The [protected execution proposal](https://github.com/openclaw/openclaw-enterprise/pull/6505)
tracks the design.
