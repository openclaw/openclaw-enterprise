# Test Strands Box GitHub access locally

The paired Strands Box test runs stock `git` and stock `gh` against a controlled
GitHub origin, through a stand-in for Box egress that applies the exact
credential routes and policy the Strands Box host generates. It checks the
Worker's material install, the host's delivery record, the push, one draft pull
request, refusal of another repository and refusal after withdrawal. It does
not start Box, Kubernetes or an installed OpenClaw Enterprise (OCE) deployment.

## Run the test

Use Linux as a nonroot user, Node and dependencies from the
[testing requirements](README.md#requirements-and-credentials), Git, OpenSSL,
and the GitHub CLI (`gh`) on `PATH` at `/usr/local/bin/gh` or `/usr/bin/gh`.
The [runtime image](../../deploy/runtime/Dockerfile) installs the same client.
The test downloads nothing, uses no account credentials and calls no public
provider.

```sh
node --test tests/conformance/strands-box-protected.test.ts
```

Without `gh` the end-to-end case is skipped with the reason
`stock gh is not installed on this host`; treat that skip as a missing input,
not a pass. The suite also runs in the `checks-baseline-1` lane.

## What the test observes

1. Before the Compute release and activation, the Worker reads no material and
   delivers nothing to the host.
2. After the release, one install intent is persisted, the host receives the
   material once over its owner-only control socket, and the intent is
   confirmed only after the host reports that exact version in the live
   `box run`. A lost delivery reply is settled from the host's record without a
   second intent or a second restart. A Worker restart adopts the installed
   version. A renewed version is not installed.
3. Stock `git push https://github.com/<owner>/<repo>.git <branch>` updates the
   branch, and stock `gh pr create --draft` opens one draft. The workload
   environment holds only Box placeholders, Box's proxy and Box's CA files.
4. Another repository is refused by the origin, which models an installation
   token scoped to one repository. A host outside the generated policy is
   refused at `CONNECT`.
5. After withdrawal the Worker sends nothing to the host, and the execution
   keeps running. The origin models the revoked installation token, so fresh
   Git and `gh` requests fail with GitHub's `401` and nothing is written.

## Interpret the result

The Box stand-in ([`boxGitHubEgress`](../../tests/helpers/strands-box-egress.ts))
reproduces only the behavior the test relies on: TLS interception with its own
CA, the permitted host and method, placeholder replacement for a phantom route,
attachment to every request for an `inject = "always"` route, identity
encoding and response scrubbing. It does not prove Box containment, Box's
actual route semantics, GitHub's token scope or revocation timing. Check those
on an installed run; see [Strands Box validation](../../deploy/examples/strands-box/VALIDATION.md).

Withdrawal reaches GitHub in this mode: the refused request arrives at the
origin and is rejected there, because Box does not ask OCE before each request.
The earlier rehearsal that required a withdrawn request never to reach the
origin returns when Box can call OCE's request authorization; see
[known gaps](../../deploy/examples/strands-box/KNOWN-GAPS.md).

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
