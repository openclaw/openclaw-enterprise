# Test Strands Box GitHub access locally

The paired Strands Box test runs stock `git` and stock `gh` against a controlled
GitHub origin, through a stand-in for Box egress that applies the exact
credential routes and policy the Strands Box host generates and asks the host's
real credential source for every request. It checks request-time readiness, one
OCE decision per request, renewal without restarting `box run`, the push, one
draft pull request, refusal of another repository and refusal after withdrawal.
It does not start Box, Kubernetes or an installed OpenClaw Enterprise (OCE)
deployment.

## Run the test

Use Linux as a nonroot user, Node and dependencies from the
[testing requirements](README.md#requirements-and-credentials), Git, OpenSSL,
and the GitHub CLI (`gh`) on `PATH` at `/usr/local/bin/gh` or `/usr/bin/gh`.
The [runtime image](../../deploy/runtime/Dockerfile) installs the same client.
The test downloads nothing, uses no account credentials and calls no public
provider.

```sh
OCC_TEST_STRANDS_BOX_NATIVE=1 \
  node --test tests/conformance/strands-box-protected-gh.test.ts
```

The end-to-end case is part of the manual `strands-box-native` lane, described
below. With the lane selected and no `gh`, it fails. The same steps without
`gh` (the push, refusal of another repository and refusal after withdrawal) run
in `strands-box-protected.test.ts` with the paired registration and release
cases, in the `checks-baseline-1` lane.

On a slow or emulated host, set `OCC_TEST_STRANDS_TIMEOUT_MULTIPLIER` to an
integer from 1 to 10. It scales the Strands test and fixture deadlines without
changing any expected outcome; native hosts keep the default of 1.

## What the test observes

1. Before the Compute release and activation, the Worker reads no material and
   prepares nothing.
2. After the release, the Worker persists one install intent for the version
   and confirms it only while the host reports the live `box run` asking it.
   Nothing is sent to the host. A Worker restart adopts the confirmed version.
3. Stock `git push https://github.com/<owner>/<repo>.git <branch>` updates the
   branch, and stock `gh pr create --draft` opens one draft. Each request Box
   sends is asked once, decided once by OCE's `requests.authorize` and
   recorded with its own `exchangeId`. The workload environment holds only Box
   placeholders, Box's proxy and Box's CA files, never the token or the source
   bearer.
4. A renewed version is refused with `route_not_ready` until the Worker
   confirms it, then works in the same `box run`. The host is not asked to
   restart.
5. Another repository is refused by OCE with `request_not_allowed` before any
   provider connection. A host outside the generated policy is refused by Box
   at `CONNECT`, and OCE is not asked.
6. After withdrawal OCE refuses the next Git and `gh` request with
   `access_withdrawn` before any provider connection, nothing is written, and
   the execution keeps running.

## Interpret the result

The Box stand-in ([`boxGitHubEgress`](../../tests/helpers/strands-box-egress.ts))
reproduces only the behavior the test relies on: TLS interception with its own
CA, the permitted host and method, placeholder replacement for a phantom route,
attachment to every request for an `inject = "always"` route, the
request-time source wire, identity encoding and response scrubbing. It does not
prove Box containment, Box's actual route semantics, GitHub's token scope or
revocation timing. Check those on an installed run; see [Strands Box validation](../../deploy/examples/strands-box/VALIDATION.md).

The stand-in opens the upstream connection only after the source answers. Real
Box dials the upstream at `CONNECT`, before it asks, so on an installed run a
refused request may still open a TCP connection that carries no request bytes;
see [known gaps](../../deploy/examples/strands-box/KNOWN-GAPS.md).

## Reuse the controlled services

- [`strandsRehearsalModel(t)`](../../tests/helpers/strands-rehearsal-model.ts)
  returns the Responses `baseUrl`, model name, synthetic credential, CA path and
  bytes, and request and connection counters.
- [`strandsRepositoryOriginFixture(t)`](../../tests/helpers/strands-rehearsal-repository.ts)
  returns the GitHub HTTPS listener, a TLS-verifying `upstreamAgent`, the real
  repository, `publishCommit()`, request records in `writes`, refusals,
  created `pulls` and `revoke()`. It answers Git smart HTTP for one repository
  and the GraphQL operations `gh pr create` sends.

Both listeners bind to loopback. Register runtime cleanup before starting the
fixtures so the runtime stops before its services and files are removed.

## Run the Box host checks with native inputs

The manual `strands-box-native` lane holds the Box host checks that need
material CI does not stage. Run them as a nonroot Linux user. The lane sets
`OCC_TEST_STRANDS_BOX_NATIVE=1`. Without it, the ordinary test sweep skips
these cases. Once selected, a missing input fails the case.

- `tests/conformance/strands-box-native-codex.test.ts` sends the installed
  Driver's pinned TLS readiness probe through a Unix relay to native Codex. It
  also starts the owned launcher against native Codex and the compiled agent.
  Set `OCC_TEST_STRANDS_NATIVE_CODEX` and `STRANDS_HOST_TEST_CODEX` to the
  native Codex executable, and `STRANDS_HOST_TEST_AGENT_BUILD` to the compiled
  agent directory.
- `tests/conformance/strands-box-protected-gh.test.ts` pushes and opens a
  draft with stock `git` and `gh`, as described above.
- `tests/conformance/strands-box-turn-network-codex.test.ts` checks that Codex
  applies no network sandbox of its own under the Box turn policy. Put a Linux
  Codex CLI on `PATH` or set `OCE_CODEX_BIN`.
- `tests/conformance/strands-box-shell-calls.test.ts` needs ARM64 and the
  stock Box. Set `OCC_TEST_STRANDS_BOX_SHELL_BOX` and
  `OCC_TEST_STRANDS_BOX_SHELL_VERIFIER_SHA256` as described in the
  [workspace verifier](../../deploy/examples/strands-box/workspace-verifier/README.md).

Select one file with `--file` when the host has only one set of inputs:

```sh
node scripts/ci/run-tests.ts run strands-box-native \
  --file tests/conformance/strands-box-native-codex.test.ts \
  --state "$RUN/state.json" --results "$RUN/results.json"
```
