# Check repository access from OpenSandbox on Docker

Run Git in OpenSandbox against a local bare repository. OpenClaw Control
Plane (OCC) checks requests against the repository grant in PostgreSQL.
The test supplies the issuer, sender, and GitHub API. The host runs the
draft pull request checks. This test never contacts GitHub.

First run the [Docker startup probe](../docker/README.md). Reuse its checkout,
Python environment, and cached images after cleanup. Run on the Docker host
so the test can reach the fixture's loopback sockets. Use synthetic credentials
and keep the daemon dedicated to this run. Another OpenSandbox server can
adopt or expire allocations and remove orphaned egress sidecars. Both
checks refuse existing allocations, sidecars and execd installers.

In the same private shell, export the probe inputs.

```sh
export OCC_TEST_OPENSANDBOX_GIT_SOURCE="$opensandbox_source"
export OCC_TEST_OPENSANDBOX_GIT_PYTHON="$probe_dir/venv/bin/python"
export OCC_TEST_OPENSANDBOX_GIT_IMAGE="$runtime_image"
export OCC_TEST_OPENSANDBOX_GIT_EXECD_IMAGE="$execd_image"
```

Follow the [PostgreSQL setup](../../../../docs/testing/postgresql.md#revision-worker-tests).
Keep its cleanup trap. Replace the `run-tests` command with the following.

```sh
file=tests/integration/postgres-external-protected-git.test.ts
node scripts/ci/prepare.ts --lane postgres-application --file "$file" \
  --state "$PG_RUN_DIR/state.json" --github-env "$PG_RUN_DIR/test.env"
env -u OCC_TEST_DATABASE_URL -u OPENCLAW_ENTERPRISE_CI_STATE \
  -u OPENCLAW_ENTERPRISE_CI_PREFIX OCC_TEST_OPENSANDBOX_GIT=1 \
  node --env-file="$PG_RUN_DIR/test.env" --test \
  --test-name-pattern="pushes only the granted ref" "$file"
```

Docker networking is off. Git reaches the sender over TLS through a Unix
socket on a read-only mount. Git supplies a route marker. The sender holds
the synthetic provider token and checks access with OCC.

Require one pass with zero skips. Check these outcomes.

- Git fetches a new commit and pushes `refs/heads/review`. Another repository
  and a missing route marker fail. Git can discover refs, but a push to an
  unapproved ref must fail before its pack reaches the origin.
- Before withdrawal, the origin accepts the token from the host (HTTP 200).
- After withdrawal, OCC denies fetch, push, and draft creation. No request
  reaches the origin. The issuer revokes the unexpired token. The origin
  then refuses the same token from the host (HTTP 401).
- The workload cannot reach the origin directly. The test checks selected
  files, process data, and output for the synthetic token.
- The lifecycle API and Docker confirm removal. If cleanup is uncertain,
  inspect the reported allocation and private state directory before reuse.

The Git client runs in its own sandbox. This check does not start an Agent
or verify a live GitHub integration.
