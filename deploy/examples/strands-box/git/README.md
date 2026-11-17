# Send Git requests for one admitted repository

This example implements a trusted sender for one selected GitHub repository and one admitted execution. It serves smart HTTP at `/repository.git` and one draft creation at `POST /draft-pull`. The remote origin is fixed by the sender. The caller cannot select the GitHub host or repository. The example PR command uses a fixed head and base. The installation token and GitHub repository policies determine provider permissions.

The ordinary Box example does not install a protected recipient or provide its authenticated Git route. Leave protected repository access disabled until the same selected Driver can supply both. Do not use the ordinary Box control socket, a static token, or an unauthenticated TLS proxy as a substitute.

## Bind the sender in the selected Driver

1. Select one installed Driver that implements both Sandbox repository access and Credential Proxy. Use the [protected sender selection](../../../../docs/reference/drivers/selection.md#select-a-protected-sender) and the existing Worker binding. This sender requires the v5 online-request mode and one `github-repository` selection. It does not select another scope as a fallback.
2. Complete held enrollment through the existing Compute and provider path. Verify the actual protected policy and recipient, the original running host execution, and the exact authenticated transport that reaches only this sender. Bind the actual process to the recipient's process identity as `bootId:pid:startTicks`. For this example, the Driver binds the client TLS key to the recipient's network identity as `mtls-sha256:<SPKI SHA-256 in lowercase hex>`. Keep `enforcement.peerKeyId` unset for v5; this example uses the verified recipient network identity, not the separate request-signing field.
3. Through the maintained Worker authority, independently observe the committed recipient. Read the eligible material version, persist the install intent with `recipients.beginInstall`, and confirm only after observing that exact version at the same isolated recipient. Use the fence returned by `recipients.confirmInstall`. An unresolved effect is not a confirmed install. The example does not issue credentials, install material, or write an enrollment record.
4. Create the sender with the fixed execution, Driver, sender, repository ID/name, GitHub installation ID, branches, and a dedicated owner-only journal directory outside Box. The paired Driver supplies `current(signal)` from the authentic running recipient: the committed `EgressInstallation`, its confirmed revision fence, the installed material attempt/version, the original host process identity, and the verified TLS client key. This lookup must check current ownership and honor cancellation. Attach the component's `bindRepositoryGit` as that Driver's Worker-side Credential Proxy method. Pass the request handler only to the dedicated private HTTPS listener configured for client certificate verification. Bind that listener to the approved network; keep its key and the GitHub credential out of the Box workload.

The currently shipped Box example supplies the host identity through its private control socket but refuses protected wiring and credential attachments. It cannot currently satisfy steps 2–4. The sender's local tests supply a controlled authority and authenticated recipient fixture to test the transport itself.

## Use the admitted remote

Once the protected recipient is installed, configure the Git client to use the sender's fixed HTTPS endpoint as its remote:

```sh
git remote add protected https://repository-sender.example.invalid/repository.git
git -c http.version=HTTP/1.1 -c http.sslCAInfo="$SENDER_CA" -c http.sslCert="$EXECUTION_CERT" \
    -c http.sslKey="$EXECUTION_KEY" fetch protected
git -c http.version=HTTP/1.1 -c http.sslCAInfo="$SENDER_CA" -c http.sslCert="$EXECUTION_CERT" \
    -c http.sslKey="$EXECUTION_KEY" push protected HEAD:refs/heads/review
```

Use the certificate and trust configuration issued for the authenticated execution. The client does not receive a GitHub token. The sender passes bounded smart-HTTP bytes to the selected repository. GitHub decides which Git operations are allowed. The example does not impose a branch or draft-only permission. Its single PR action uses the fixed REST endpoint below; stock `gh pr create` is not a client for it.

```sh
curl --cacert "$SENDER_CA" --cert "$EXECUTION_CERT" --key "$EXECUTION_KEY" \
  --header 'Content-Type: application/json' --data '{"title":"Review change"}' \
  https://repository-sender.example.invalid/draft-pull
```

The sender constructs a draft against the configured base and returns only a confirmed result for the selected repository. It does not expose a general GitHub API proxy.

Each request checks the current recipient, looks up its exact installed material version, and commits one authorization for the normalized outbound bytes before connecting. A material lookup refusal has no authorization exchange. A committed authorization is possible use; the sender separately records a provider reply or an unknown outcome. Git clients still interpret the protocol result and can read back the actual ref. The sender journals the digest of each exact push body and one draft intent per execution before authorization, so a process restart cannot replay those bytes or create a second draft through this endpoint. Keep the journal until an independent readback reconciles any unknown effect.

Run the local test with `node --test tests/conformance/strands-box-git.test.ts`. It uses real TLS, a local `git http-backend`, and a controlled PR API. It neither calls GitHub nor qualifies the protected Box installation.
