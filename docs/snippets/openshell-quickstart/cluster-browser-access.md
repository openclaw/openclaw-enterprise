---
published: false
---

### Configure browser access

Continue in the same operator shell. The laptop needs OpenSSL, jq and kubectl, plus permission to read the bootstrap claim, get the listener Deployment, list its Pods and create `pods/portforward` in `oce-system`. The listener terminates TLS on Pod loopback and forwards HTTP/WebSocket traffic to OCC. OCC retains browser authentication and authorizes access to the Agent UI.

### Read the protected initial owner files

After the Helm initialization Job succeeds, mount its output claim read-only. Use a fresh private output directory. Kubernetes permission to read this claim is privileged. The one-use reader must run in the claim’s volume topology on a control node with access to the chosen storage.

```bash
jq -n --arg image "$CONTROLLER_IMAGE" --arg namespace "$PLATFORM_NS" \
  --arg claim occ-bootstrap-admin-password --argjson nodeSelector '{"oce-role":"control"}' \
  -f "$assets/bootstrap-reader.jq" |
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
mv "$RUN_DIR/initial-admin-service-key.json" "$RUN_DIR/service-key.json"
export OCC_SERVICE_KEY_FILE="$RUN_DIR/service-key.json"
```

Use `ADMIN_EMAIL` and `$RUN_DIR/initial-admin-password` for ordinary Console password sign-in. The initial administrator has the required Agent administration access. Other owners need a browser account with `administer` permission on this exact Agent. The service key file authenticates operator REST calls. Retain the original bootstrap claim for recovery.

### Install the loopback TLS listener

Run the following on the laptop with OpenSSL, jq and kubectl. Create a separate private test CA for this installation. Its leaf covers the Console and one-label Agent hostnames. Keep the CA key private on the laptop. Mount only the serving certificate and its key in the listener.

```bash
cookie_domain="$CLUSTER_NAME.oce.localhost"
console_host="console.$cookie_domain"
CONSOLE_ORIGIN="https://$console_host:18443"
NATIVE_ADMIN_DOMAIN="agents.$cookie_domain"
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
  'extendedKeyUsage=serverAuth' "subjectAltName=DNS:$console_host,DNS:*.$NATIVE_ADMIN_DOMAIN" > "$tls_dir/leaf.ext"
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

Print a self-contained command for a second laptop terminal. Run that printed command there and leave it running:

```bash
printf 'kubectl --kubeconfig %q --context %q -n %q port-forward --address 127.0.0.1 deployment/oce-owner-listener 18443:8443\n' \
  "$KUBECONFIG" "$CONTEXT" "$PLATFORM_NS"
```

In the original shell, verify TLS and the signed-out session. Import **only** `$tls_dir/ca.crt` into the owner browser’s trust store. The Console and Agent `.localhost` names must resolve to laptop loopback.

```bash
curl --fail --silent --show-error --noproxy '*' --cacert "$tls_dir/ca.crt" \
  --resolve "$console_host:18443:127.0.0.1" "$CONSOLE_ORIGIN/api/auth/session" |
  jq -e 'has("data") and .data==null'
printf 'Owner Console: %s/console/\n' "$CONSOLE_ORIGIN"
```
