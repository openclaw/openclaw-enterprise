# Supply network policy during local OpenShell startup

Pass a YAML file to `occ dev up` or `scripts/dev-up` to add binary-scoped endpoint
rules to the generated OpenShell Sandbox policy. Select Kubernetes Compute and
OpenShell; either Compose or Kubernetes can hold OCC. Follow the
[local OpenShell prerequisites](local-kubernetes-development.md#start-the-openshell-fail-closed-profile).

```bash
OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes \
OCC_DEVELOPMENT_CONTROL_PLANE=compose \
OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell \
./scripts/dev-up --sandbox-network-policy-file ./network-policy.yaml
```

The file contains only `networkPolicies`, using the existing
[OpenShell Driver shape](../../reference/drivers/openshell-sandbox.md#configuration).
Replace the executable and host below with the resolved binary path inside the
selected runtime image and an endpoint you intend to permit:

```yaml
networkPolicies:
  - name: tool-network
    binaries:
      - path: /absolute/resolved/tool
    endpoints:
      - host: permitted.example.test
        ports: [443]
        tls: skip
```

Startup rejects missing files, files larger than 1 MiB, multiple YAML documents,
unknown fields, empty lists, invalid Driver settings, duplicate rule names, and
collisions with generated or reserved names before creating resources. Node.js
and the installed workspace dependencies are required for Driver validation.

Supplied rules append to the generated rules. Model Credential Source profiles,
workspace transport, filesystem/process policy, and Kubernetes NetworkPolicies
retain their existing owners. The added rules apply to all Agents using this
development Sandbox Driver, rather than one Agent or chat session.

The parsed rules are saved in private `state.json` and rendered into
`installation.yaml`, which supplies the same configuration to OCC API and worker.
Editing the input file does not change the running policy. Keep the cleanup
command printed by startup; run it and recreate the stack to apply another file.
Without this option, startup uses its existing generated policy.

Inspect current decisions using the Agent's existing Sandbox Logs view or
`occ agent logs ID --source sandbox --revision REVISION_ID`. See
[Agent logs](../topics/agent-logs.md) for permissions, retention, and follow limits,
and the [startup flow](../../flows/openshell-sandbox-provisioning.md#0-create-the-development-control-plane)
for implementation ownership.

## Delegate per-Agent additions

Pass a separate ceiling file when operators want authorized users to request
per-Agent grants later:

```sh
./scripts/dev-up --sandbox-network-policy-ceiling-file ./ceiling.yaml
```

```yaml
grants:
  - id: approved-service
    binary: /usr/bin/python3.11
    host: service.example.com
    ports:
      - from: 443
        to: 443
```

This input requires Kubernetes Compute and a Sandbox Driver. It is validated
before resources are created and saved into the shared Installation startup
configuration as `sandboxNetworkPolicyCeiling`. It grants no access and does not
enable Agent editing. Defaults and ceiling files may be supplied together.
Recreate Local Setup to change either operator input. See
[per-Agent policies](../../reference/sandbox-policies.md) and the
[console/CLI workflow](../topics/agent-sandbox-policy.md).
