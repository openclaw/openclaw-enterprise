# Open an EKS Agent from a laptop

Use the same Bash shell, private `RUN_DIR`, kubeconfig and `oce-system` Namespace as the [EKS OpenShell installation](eks-openshell-setup.md). This procedure uses the deployment’s pinned controller image to terminate TLS on Pod loopback. The laptop operator needs permission to get the listener Deployment, list its Pods and create `pods/portforward` in `oce-system`. Kubernetes carries the connection through that subresource. The listener streams HTTP and WebSocket bytes to the OCC API Service. OCC receives the original Host, Origin, browser cookie and WebSocket upgrade. OCC holds the separate private Envoy routing key and authorizes native UI access for the signed-in user.

## Set the production browser origins before installing OCC

Use a cluster name that is also a lowercase DNS label. Keep the browser port at 18443 in both the Helm values and the laptop forward. The EKS values template sets these fields for the selected cluster:

| Setting                               | Value                                           |
| ------------------------------------- | ----------------------------------------------- |
| `auth.baseUrl`                        | `https://console.<cluster>.oce.localhost:18443` |
| `agentNativeAdmin.enabled`            | `true`                                          |
| `agentNativeAdmin.domain`             | `agents.<cluster>.oce.localhost`                |
| `agentNativeAdmin.sharedCookieDomain` | `<cluster>.oce.localhost`                       |

Keep the private Gateway routing Service as `ClusterIP`, with its own serving certificate and hostname. For an existing HTTPS ingress, use the [native-admin ingress procedure](native-admin.md#production-requirements) with that ingress’s console and wildcard Agent hosts and their trusted cookie domain.

## Read the protected initial owner files

After the Helm initialization Job succeeds, mount its output claim read-only. Use a fresh private output directory. Kubernetes permission to read this claim is privileged. The one-use reader must run in the claim’s availability zone on a control node with EBS access.

```bash
jq -n --arg image "$CONTROLLER_IMAGE" -f "$assets/bootstrap-reader.jq" |
  kubectl --context "$CONTEXT" create -f -
kubectl -n "$PLATFORM_NS" wait --for=condition=Ready pod/oce-owner-bootstrap-reader --timeout=3m
for file in initial-admin-password initial-admin-service-key.json; do
  test ! -e "$RUN_DIR/$file"
  kubectl -n "$PLATFORM_NS" exec oce-owner-bootstrap-reader -- \
    node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))' \
    "/bootstrap/$file" > "$RUN_DIR/$file.tmp"
  test -s "$RUN_DIR/$file.tmp"
  chmod 600 "$RUN_DIR/$file.tmp"
  mv "$RUN_DIR/$file.tmp" "$RUN_DIR/$file"
done
kubectl -n "$PLATFORM_NS" delete pod oce-owner-bootstrap-reader
export OCC_SERVICE_KEY_FILE="$RUN_DIR/initial-admin-service-key.json"
```

Use `ADMIN_EMAIL` and `$RUN_DIR/initial-admin-password` for ordinary Console password sign-in. The initial administrator has the required Agent administration access. Other owners need a browser account with `administer` permission on this exact Agent. The service key file authenticates operator REST calls. Retain the original bootstrap claim for recovery.

## Install the loopback TLS listener

Run the following on the laptop with OpenSSL, jq and kubectl. Create a separate private test CA for this installation. Its leaf covers the Console and one-label Agent hostnames. Keep the CA key private on the laptop. Mount only the serving certificate and its key in the listener.

```bash
cookie_domain="$EKS_CLUSTER.oce.localhost"
console_host="console.$cookie_domain"
console_origin="https://$console_host:18443"
agent_domain="agents.$cookie_domain"
tls_dir="$RUN_DIR/owner-tls"
mkdir -m 700 "$tls_dir"
cat > "$tls_dir/ca.cnf" <<'CONF'
[req]
distinguished_name=dn
prompt=no
x509_extensions=ca
[dn]
CN=OCE private owner browser CA
[ca]
basicConstraints=critical,CA:true,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
CONF
openssl req -x509 -newkey rsa:3072 -nodes -days 30 -config "$tls_dir/ca.cnf" \
  -keyout "$tls_dir/ca.key" -out "$tls_dir/ca.crt"
openssl req -new -newkey rsa:2048 -nodes -subj "/CN=OCE private owner browser" \
  -keyout "$tls_dir/tls.key" -out "$tls_dir/tls.csr"
printf '%s\n' 'basicConstraints=critical,CA:false' 'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' "subjectAltName=DNS:$console_host,DNS:*.$agent_domain" > "$tls_dir/leaf.ext"
openssl x509 -req -in "$tls_dir/tls.csr" -CA "$tls_dir/ca.crt" -CAkey "$tls_dir/ca.key" \
  -CAcreateserial -days 28 -extfile "$tls_dir/leaf.ext" -out "$tls_dir/tls.crt"
openssl verify -CAfile "$tls_dir/ca.crt" -verify_hostname "$console_host" "$tls_dir/tls.crt"
kubectl -n "$PLATFORM_NS" create secret tls oce-owner-browser-tls --cert="$tls_dir/tls.crt" --key="$tls_dir/tls.key"
kubectl -n "$PLATFORM_NS" create configmap oce-owner-listener --from-file="$assets/owner-listener.mjs"
kubectl -n "$PLATFORM_NS" get svc openclaw-enterprise-api -o json > "$RUN_DIR/api-service.json"
kubectl -n kube-system get svc kube-dns -o json > "$RUN_DIR/dns-service.json"
jq -n --arg image "$CONTROLLER_IMAGE" --argjson api "$(cat "$RUN_DIR/api-service.json")" \
  --argjson dns "$(cat "$RUN_DIR/dns-service.json")" -f "$assets/owner-listener.jq" > "$RUN_DIR/listener.json"
kubectl --context "$CONTEXT" create -f "$RUN_DIR/listener.json"
kubectl -n "$PLATFORM_NS" rollout status deploy/oce-owner-listener
```

The NetworkPolicy permits the listener (`app=oce-owner-browser`) to reach the exact API Service VIP and selected API Pods on TCP 8080, and the DNS VIP and CoreDNS Pods on UDP/TCP 53. The chart’s `api.clients` entry permits the matching API ingress. If an existing CoreDNS ingress policy restricts DNS clients, admit only `app=oce-owner-browser` in `oce-system` on UDP/TCP 53 alongside the existing clients. Re-render when these Services change. No new public address or Kubernetes Service is needed.

In a second laptop terminal, select the same private kubeconfig and context and keep the following process running:

```bash
kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" -n oce-system \
  port-forward --address 127.0.0.1 deployment/oce-owner-listener 18443:8443
```

In the original shell, verify TLS and the signed-out session. Import **only** `$tls_dir/ca.crt` into the owner browser’s trust store. The Console and Agent `.localhost` names must resolve to laptop loopback.

```bash
curl --fail --silent --show-error --noproxy '*' --cacert "$tls_dir/ca.crt" \
  --resolve "$console_host:18443:127.0.0.1" "$console_origin/api/auth/session" |
  jq -e 'has("data") and .data==null'
printf 'Owner Console: %s/console/\n' "$console_origin"
```

Return to the [EKS setup](eks-openshell-setup.md#3-authenticate-and-prepare-the-namespace) to create the Agent before opening its native UI.
