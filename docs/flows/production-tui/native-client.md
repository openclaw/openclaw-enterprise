# Native production TUI client lifecycle

Continue from an activated gateway to Pod discovery, native TUI attachment, and client shutdown. See the [parent flow](../production-tui.md) for its context and overall sequence.

## Execution trace

### 4. The operator discovers the active gateway Pod

`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.gatewayConfiguration`

Gateway Pods keep stable labels for the Agent, including
`app.kubernetes.io/managed-by=openclaw-enterprise`,
`openclaw.dev/workload-role=gateway`, `openclaw.dev/namespace`, and
`openclaw.dev/agent`. Those labels are not enough to prove the active immutable
revision after a cutover. The attach procedure calculates the expected
ConfigMap name from `AGENT_ID` and `REVISION_ID`, then selects exactly one
Running, Ready gateway Pod whose volumes mount that ConfigMap.

If discovery returns zero Pods, Kubernetes has not made the active gateway
ready. If it returns more than one, the operator stops and resolves the
ambiguous runtime state before attaching.

### 5. `kubectl exec` starts the native TUI inside the gateway

`deploy/runtime/README.md`,
`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.deployment`

The runtime image supplies `/app/openclaw.mjs`. The gateway container already
has the configuration file, port, token, and persistent runtime state mounted.
The operator starts a separate client state directory so TUI device-pairing and
client metadata do not reuse the serving gateway state:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" exec -it "$GATEWAY_POD" -c gateway -- \
  env -u OPENAI_API_KEY OPENCLAW_STATE_DIR=/tmp/occ-tui-client \
  node /app/openclaw.mjs tui \
    --session "$E2E_SESSION" \
    --message "Reply exactly: $NONCE"
```

The command intentionally does not pass `--url` or a token. The OCC service key
stays in the operator environment and never enters the Pod or TUI. Gateway
authentication uses the separate Agent gateway token. The TUI inherits the
Pod-local gateway connection details from the running container environment and
configuration, authenticates with the injected gateway token, and opens the
normal interactive UI. `--message` submits the first prompt to the TUI-native
agent named `main`; that name is separate from the OCC Namespace, Agent, and
AgentRevision IDs. The client process unsets `OPENAI_API_KEY`; model access
stays in the serving gateway path. The same process remains attached so the
operator can type a second prompt into the same session.

### 6. The operator exits the client without stopping the gateway

`tests/integration/production-tui-k3d-real.test.mjs`, `tests/helpers/tui-pty.py:run_conversation`

Ctrl+D exits the TUI process launched by `kubectl exec`; the production TUI test
drives that exit through `tests/helpers/tui-pty.py`, then checks the gateway
`/readyz` endpoint from inside the same Pod. After a new
immutable AgentRevision becomes active, the operator uses the service key to
read the Agent again and repeats discovery because
the matching ConfigMap and possibly the gateway Pod UID have changed. Removing
a temporary local service-key copy does not revoke the credential, and exiting
the TUI does not rotate or revoke it. Deliberate rotation and revocation follow
the [service-key procedure](../../guides/deploy/service-keys.md#revoke-or-rotate-a-service-key).

Automated coverage for this exact lifecycle is
`tests/integration/production-tui-k3d-real.test.mjs`. It uses
`tests/helpers/tui-pty.py` to keep the native TUI process open across two
prompts, verify nonce-only assistant responses, prove fresh invalid-token
denial, repeat the attach path after immutable revision cutover, and confirm
Ctrl+D exits only the client. Its native Configuration sets
`agents.defaults.skipBootstrap` to `true` for the disposable demo Agent so
first-run bootstrap guidance does not consume the nonce prompt.

The test separates production installation, service-key-authenticated provisioning, and
revision conversations into named stages. Shared scoped Kubernetes commands,
resource lookups, and polling come from
`tests/helpers/kubernetes-real.mjs:createKubernetesClient`; the production test
retains its credential-redacting process runner. One `nativeTuiArgv` builder
supplies the valid and denied TUI checks and the generated interactive attach
script, keeping client authentication and environment handling consistent.

## Related

- [Return to the parent flow](../production-tui.md).
