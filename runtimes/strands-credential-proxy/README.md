# Strands Box HTTP gateway for OCE Credential Proxy

An ordinary HTTPS client in an admitted execution can call an exact inference or prepared repository
metadata route without holding the provider credential. An expressly credential-free repository
identity read uses the same two fresh authority checks and receipt, with no provider Secret or issuer access. Strands Box terminates the client's TLS and
checks the HTTP request with Dogwood. Each installed route must admit an exact origin IP and port;
the original hostname remains the TLS verification name and the sender performs no ambient origin DNS. OCE's signed installation exchange captures that operation,
resolves the admitted credential, independently authorizes the send and protects the complete
response. The gateway opens one verified TLS connection to the provider and makes at most one send.

Run the gateway in a **separate trusted Pod for one execution**. The workload may receive the
inspection CA certificate, never the exchange key, bearer, issuer key, history database or a sender
probe endpoint. Kubernetes must enforce that the workload can reach only this gateway and any exact
Compute control enrollment endpoint. On Linux this uses Box's portable egress and policy components;
the containment boundary is the qualified Kubernetes installation. See the
[controller installation](../../apps/controller/src/drivers/strands-box/installation.ts) and
[image packaging](../../deploy/strands-credential-proxy).

## Build and review

Use Rust 1.98.1, a C toolchain, Git, GNU patch and protoc. From this directory:

```sh
./build-gateway.sh
./build-gateway.sh --test-guarded-exchange
cargo test --profile distribution --locked
cargo clippy --profile distribution --all-targets --locked -- -D warnings
# With the OCE workspace development dependencies installed, check the signed opening with its real owner.
node --test tests/operation-opening.test.mjs tests/credential-free-opening.test.mjs tests/workspace-projection-opening.test.mjs
```

The script fetches public Strands Box at `bd8578548047307a71bf29a4f2791ec7c03ee8af`, applies the
[separately reviewable request-exchange patch](upstream/strands-box-request-exchange.patch) and builds
against this repository's actual signed Credential Proxy protobuf. Cargo.lock selects
dogwood-language and dogwood-local-engine 1.0.0. The image carries the selected Box and Dogwood
licenses and notices. A general distribution still needs its complete dependency inventory. Set `STRANDS_BOX_SOURCE` to an existing
Git clone to avoid fetching it. Build inputs, binaries and credentials are never vendored into source.
The lockfile includes Box's exact Dogwood language and durable local engine 1.0.0 and Cedar 4.11.0.
The `distribution` profile is a fast, stripped qualification build. Set `CARGO_PROFILE=release` for
an optimized binary; qualify the exact image you intend to run.

The Box patch is a downstream extension proposed for upstream review. Box gives one terminal
transport the policy-checked request and a single-use origin connection. Box checks the actual
destination against its effect policy, owns the dial, and records cancellation as indeterminate.
A delegated failure cannot fall back to a direct send. The six terminal-exchange tests exercise
real pending-connect cancellation, denied origins, Unix and plain TCP policy, confirmed receipt,
an uncertain truncated response and response-policy refusal. The patch contains no OCE credential contract.

## Installation and send contract

1. **Observe the installed sender.** Mount the controller's immutable configuration and raw 32-byte,
   per-execution Ed25519 exchange seed, a separately projected bearer file and private execution
   history volume. Start `strands-credential-proxy CONFIG.json`. The policy SHA-256 covers the exact
   installed policy bytes, including plan, Dogwood source, bounded routes and authority. The gateway
   checks its actual sandbox, authority URI, audience and authority CA against that policy.
2. **Enroll this process before releasing the workload.** Query `GET /installed?challenge=<64 hex>`
   on the controller-only probe port. Verify the challenge signature, execution, exact policy hash,
   random process instance, exchange public key and SHA-256 of the actual `GET /ca.pem` bytes. An
   initial empty bearer yields a signed bootstrap observation. The controller issues a short-lived
   bearer bound to this particular process and key, verifies the subsequently observed bearer digest
   and acknowledges enforced installation. A missing bearer file cannot produce an observation. A
   process restart changes both instance and inspection CA and needs admission again.
3. **Check policy before sending.** Box accepts only inspected HTTPS CONNECT sessions, binds inner
   authority to CONNECT, canonicalizes the path, then asks the actual Dogwood engine whether the
   request is allowed. The [sample policy](policy/one-attempt.dw) durably counts attempts within an
   hour, including denied attempts and uncertain outcomes. It allows the first and denies a second
   even after a process restart. It illustrates temporal semantics; use OCE's authoritative
   reservation for a business allowance. The history guard refuses an absent or empty database after
   enrollment. The controller must preserve private volume identity and prevent rollback; a local
   marker cannot detect restoration of an older, internally consistent volume snapshot.
4. **Bind resolve, final authorization and one origin send.** Each new operation gets a UUIDv7 and a
   deadline anchored to that same creation time, as required by OCE's replay admission. The process
   instance remains a UUIDv4. The gateway captures the exact admitted
   method, destination, normalized end-to-end headers and body. It removes client credential headers,
   regenerates Host and framing, reads the current process-bound bearer, opens OCE's TLS-authenticated
   `HttpInstallationExchange.Exchange`, then signs the challenge, exact encoded resolve and fresh
   downstream custody. The installed Credential Proxy route's grant determines which positive selection is acceptable.
   Inference and prepared metadata require actual material. Credential-free metadata requires an
   explicit `ready_without_material`, then `selection.no_material_required = true` with SHA-256 of
   empty injection. A missing credential or a permit for the other profile fails closed. The sender
   passes the operator-admitted IP to Box's single-use policy-checked connection, then authenticates
   the original TLS hostname on that socket before requesting fresh send authorization. It verifies the
   operation handle, request ID, exact injection digest, material profile, send-start deadline and
   custody echo. The first origin write enforces that deadline. There is no origin fallback, local
   material cache, token mint, refresh on the request path or automatic business retry.
5. **Return only the approved complete response.** The gateway bounds and buffers the origin head,
   body and actual final trailers, including unannounced or duplicate trailers. It gives the whole
   response to OCE on the same signed exchange. If OCE does not approve it, no provider head or body
   is released. Errors after send authorization can mean the provider acted, including a timeout or
   client disconnect; the gateway reports uncertainty and never replays the call. The original client
   connection is the only possible response sink, not proof the client stayed connected.

Native Codex may attach optional checkout path, Git remotes, commit and dirty-state telemetry to
a Responses turn, in both the encoded body metadata and a matching HTTP header. After Box and
Dogwood allow the original request on an admitted inference Responses route, this gateway removes
only that known `workspaces` object from both copies, before signing the operation. It refuses
duplicate JSON keys, unfamiliar workspace shapes, missing mirrors or disagreeing copies. All
remaining metadata still goes through the unchanged OCE provider policy; unknown fields are not
silently removed. This covers that optional client telemetry, not paths a user includes in a prompt,
tool result or another field. Do not treat it as a general content redactor.

The effective request profile is bounded HTTP/1.1, exact HTTPS GET or POST with no query, one
admitted injected header or an explicitly authorized empty injection, and at most 1 MiB in each
direction. OCE performs provider-specific classification and actual authority checks. This initial client leg does not implement streaming
release, provider response trailers, Git smart transport, WebSocket or arbitrary TCP. Dogwood sees
events from this gateway, not filesystem or other workload reads. The complete exchange timeout
starts after Box captures a bounded client request; it does not time client upload from CONNECT.
An authority missing the signed installation stream or final custody echo fails closed.
