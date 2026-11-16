# Send Git requests for one admitted repository

This example implements a trusted sender for one selected GitHub repository and one admitted execution. It serves smart HTTP at `/repository.git` and one draft creation at `POST /draft-pull`. The remote origin is fixed by the sender. The caller cannot select the GitHub host or repository. The example PR command uses a fixed head and base. The installation token and GitHub repository policies determine provider permissions.

The ordinary Box example does not install a protected recipient or provide its authenticated Git route. Leave protected repository access disabled until the same selected Driver can supply both. Do not use the ordinary Box control socket, a static token, or an unauthenticated TLS proxy as a substitute.

## Bind the sender in the selected Driver

1. Select one installed Driver that implements both Sandbox repository access and Credential Proxy. Use the [protected sender selection](../../../../docs/reference/drivers/selection.md#select-a-protected-sender) and the existing Worker binding. This sender requires the v5 online-request mode and one `github-repository` selection. It does not select another scope as a fallback.
2. Complete held enrollment through the existing Compute and provider path. Verify the actual protected policy and recipient, the original running host execution, and the exact authenticated transport that reaches only this sender. Bind the actual process to the recipient's process identity as `bootId:pid:startTicks` of the execution's `box run` process, which the host reads from `/proc`. Box intercepts every TLS connection from the workload and presents no client certificate, so the execution credential is a bearer instead: the Driver mints 32 random bytes per execution, sends them to the host only in `PUT /v1/execution`, and the host passes them to `box run` as an `env://` phantom credential for the sender's exact host and port. The host never writes the bearer to disk and reports only its SHA-256 in `GET /v1/execution`. The Driver binds that digest to the recipient's network identity as `box-phantom-sha256:<SHA-256 in lowercase hex>`. Keep `enforcement.peerKeyId` unset for v5; this example uses the verified recipient network identity, not the separate request-signing field.
3. Through the maintained Worker authority, independently observe the committed recipient. Read the eligible material version, persist the install intent with `recipients.beginInstall`, and confirm only after observing that exact version at the same isolated recipient. Use the fence returned by `recipients.confirmInstall`. An unresolved effect is not a confirmed install. The example does not issue credentials, install material, or write an enrollment record.
4. Create the sender with the fixed execution, Driver, sender, repository ID/name, GitHub installation ID, branches, and a dedicated owner-only journal directory outside Box. The paired Driver supplies `current(signal)` from the authentic running recipient: the committed `EgressInstallation`, its confirmed revision fence, the installed material attempt/version, the original `box run` process identity, and the bearer digest the host reports. This lookup must check current ownership and honor cancellation. Attach the component's `bindRepositoryGit` as that Driver's Worker-side Credential Proxy method. Pass the request handler only to the dedicated private HTTPS listener. Bind that listener to the approved network and admit only the Box host's address; keep its key and the GitHub credential out of the Box workload. Box verifies the listener's certificate against its compiled-in public roots, so use a publicly trusted certificate for the sender's DNS name, or a Box build that trusts a route CA.

The sender compares the request's bearer digest with the reported digest in constant time, then rechecks the whole current recipient before it reads material and again before any request bytes reach the provider. A bearer from a replaced `box run` no longer matches the committed recipient, so its requests are refused before any material read or connection.

The ordinary Box example Driver refuses protected wiring and credential attachments. Protected wiring needs the paired registration described in the [Driver guide](../driver/README.md). The sender's local tests supply a controlled authority and recipient fixture to test the transport itself.

## Use the admitted remote

Once the protected recipient is installed, the execution's environment holds a Box placeholder in `OCE_REPOSITORY_SENDER_BEARER`. Box replaces it with the real bearer only on intercepted HTTPS requests to the sender's exact host and port, and refuses any request to that destination that lacks the placeholder. Send it on every request with `http.extraHeader`:

```sh
git remote add protected https://repository-sender.example.invalid:9443/repository.git
git -c http.version=HTTP/1.1 \
    -c http.extraHeader="Authorization: Bearer $OCE_REPOSITORY_SENDER_BEARER" fetch protected
git -c http.version=HTTP/1.1 \
    -c http.extraHeader="Authorization: Bearer $OCE_REPOSITORY_SENDER_BEARER" \
    push protected HEAD:refs/heads/review
```

The client does not receive a GitHub token or the bearer. The sender passes bounded smart-HTTP bytes to the selected repository. It accepts a push only when its command list updates exactly the configured head branch: another branch, the base, a tag, a deletion, a second ref, push options and signed pushes are refused before any material read. Discovery and fetch are not ref-restricted. Keep branch protection on the base branch anyway. The single PR action uses the fixed REST endpoint below; stock `gh pr create` is not a client for it.

```sh
curl --header "Authorization: Bearer $OCE_REPOSITORY_SENDER_BEARER" \
  --header 'Content-Type: application/json' --data '{"title":"Review change"}' \
  https://repository-sender.example.invalid:9443/draft-pull
```

The sender constructs a draft against the configured base and returns only a confirmed result for the selected repository. It does not expose a general GitHub API proxy.

Each request checks the current recipient, looks up its exact installed material version, and commits one authorization for the normalized outbound bytes before connecting. A material lookup refusal has no authorization exchange. A committed authorization is possible use; the sender separately records a provider reply or an unknown outcome. Git clients still interpret the protocol result and can read back the actual ref. The sender journals the digest of each exact push body and one draft intent per execution before authorization, so a process restart cannot replay those bytes or create a second draft through this endpoint. Keep the journal until an independent readback reconciles any unknown effect.

Run the local test with `node --test tests/conformance/strands-box-git.test.ts`. It uses real TLS, the bearer header that Box injects, a local `git http-backend`, and a controlled PR API. It neither calls GitHub nor qualifies the protected Box installation.
