# Record OpenShell network decisions

Use this procedure with OpenShell 0.1.8 and dedicated Agent Sandboxes in the
same Kubernetes cluster as OpenClaw Control Plane (OCC). Enable Helm-managed
Gateway routing. OpenShell must run each supervisor in a separate Pod from
the Agent workload. You need permission to update both Helm releases, manage
Secrets, and configure workspace network policies.

## Configure the private receiver

1. Select the Kubernetes context and set `OCC_NS` to the namespace of the OCC
   release. Generate a dedicated credential in a private temporary directory.

   ```sh
   umask 077
   audit_dir=$(mktemp -d)
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$audit_dir/token"
   printf 'authorization=Bearer %s\n' "$(cat "$audit_dir/token")" > "$audit_dir/headers"
   kubectl -n "$OCC_NS" create secret generic openshell-audit-receiver --from-file="$audit_dir/headers"
   ```

2. Apply these values to the OCC release with your existing Helm settings.

   ```yaml
   controlPlaneAudit:
     enabled: true
     openShellExporterSecret: openshell-audit-receiver
   ```

3. After cert-manager issues the certificate, retrieve the public root and
   the listener port. Set `OS_NS` to the OpenShell Gateway namespace.

   ```sh
   kubectl -n "$OCC_NS" get secret openclaw-enterprise-runtime-audit-root -o 'jsonpath={.data.tls\.crt}' | openssl base64 -d -A > "$audit_dir/ca.crt"
   kubectl -n "$OCC_NS" get service openclaw-enterprise-runtime-audit -o 'jsonpath={.spec.ports[0].port}'
   kubectl -n "$OS_NS" create secret generic openshell-audit-exporter --from-file="$audit_dir/headers" --from-file="$audit_dir/ca.crt"
   rm "$audit_dir/token" "$audit_dir/headers" "$audit_dir/ca.crt"
   rmdir "$audit_dir"
   ```

## Configure the OpenShell exporter

Allow DNS and TCP egress from supervisor Pods to the OCC API Pods on the
listener port. The OCC chart accepts supervisor Pods with the labels
`openshell.ai/managed-by=openshell` and `openshell.ai/boundary-role=supervisor`
in namespaces labeled `openshell.ai/openclaw-workspace=true`. Restrict who
can assign these labels.

Merge the following values into the OpenShell Gateway release. Replace
`OCC_NAMESPACE` and `PORT` with the OCC namespace and listener port. Append
the volume and mount to any existing entries. The exporter adds `/v1/logs`.

```yaml
gatewayConfig:
  openshell.gateway.otlp.ocsf:
    enabled: true
    protocol: http/protobuf
    endpoint: https://openclaw-enterprise-runtime-audit.OCC_NAMESPACE.svc:PORT/internal/openshell-audit
    headers_file: /run/secrets/openshell-audit/headers
    ca_file: /run/secrets/openshell-audit/ca.crt
server:
  extraVolumes:
    - name: openshell-audit
      secret: { secretName: openshell-audit-exporter }
  extraVolumeMounts:
    - name: openshell-audit
      mountPath: /run/secrets/openshell-audit
      readOnly: true
```

OpenShell gives the exporter credential to each supervisor at launch. The
credential authenticates the OpenShell deployment. A compromised supervisor
could report decisions for other enrolled Sandboxes. Keep both Secrets out
of Agent workloads. To rotate the credential, update both Secrets, restart
the OCC API and OpenShell Gateway, then deploy fresh Sandboxes.

## Verify delivery

Deploy a new Agent revision and perform a tool call that opens a connection.
Read the [Agent audit log](audit-log.md#agent-runtime-activity). Look for
`openclaw.runtime.policy.decided` with `network_policy`, `allow` or `deny`,
and the Sandbox ID of the revision. Each row represents one supervisor
decision. One tool call can open multiple connections. Background traffic
can produce decisions outside a turn.

OpenShell exports after enforcement. A full queue or an extended outage can
lose decisions. OCC accepts records for the enrolled Sandbox while the
revision has an active audit grant. If records are missing, check the
supervisor’s exporter status, workspace egress, CA, and listener port. If
cert-manager replaces the root, copy the new public certificate into the
exporter Secret and restart the OpenShell Gateway and Sandboxes.
