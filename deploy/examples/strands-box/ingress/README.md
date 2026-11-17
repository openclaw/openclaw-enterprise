# Connect one Agent Gateway to the Box host

Use one provider-owned ClusterIP Service in the pilot Agent's existing Namespace. The Service selects the one real relay Pod for the admitted revision. That Pod passes TLS bytes to one fixed private IPv4 address on TCP 8443. The dedicated host terminates TLS and forwards a root WebSocket upgrade to the original run's Unix socket. The native server validates the Gateway's bearer. The relay has no bearer or TLS private key.

This example uses the existing [Sandbox Harness endpoint](../../../../docs/reference/drivers/sandbox.md#harness-transport) and Kubernetes `network.providerHarness` peer. Use it with a single, isolated pilot placement where the cluster can reach the private host and enforce the exact policies. The pilot does not add a general external provider bridge or an outbound workspace-node route. Use the repository-supported Node.js version on the host and in the relay image.

1. Pick the Agent Namespace and a unique installation label. Apply [service.yaml](service.yaml) with those values, then read its allocated `spec.clusterIP`. Keep the same Service through the revision's lifecycle. No Pod should match the selector before provision. Configure Compute's `network.providerHarness` with the Namespace, that ClusterIP as `address`, the exact two Service selector labels as `podLabels`, and `port: 8443`.
2. Use the Service's full DNS name as the WSS authority (for example, `box-harness.pilot.svc.cluster.local`). Issue a fresh TLS leaf and key for each original Box admission with that exact DNS SAN. Keep the key with the original ingress owner and retire it with that generation. Derive the leaf digest from the issued certificate via the trusted provisioning path using `openssl x509 -in "$LEAF_PEM" -outform DER | sha256sum`. Put the lowercase hex digest in `ingressLeafSha256` for the host control and ingress. Use the issued file to establish this pin before contact with the listener. The Sandbox Driver returns `wss://<authority>:8443/` and the public CA bundle in `harnessEndpoint.tls.caBundle`. Compute maps the hostname to the Service IP and mounts the CA in the Agent Gateway.
3. Start the original Box host launcher. Once it writes its private `ready.json`, supply the exact SHA-256 of that receipt to the host ingress. Keep the receipt and socket in the run's canonical, owner-only runtime directory. The ingress runs as the same nonroot Linux UID, with access to the launcher's `/proc` identity and file descriptors. The parent directories must be under operator control. Give it a mode-0600 JSON configuration like this, using the real private bind, canonical files and exact receipt digest:

   ```json
   {
     "authority": "box-harness.pilot.svc.cluster.local",
     "bindAddress": "10.20.30.40",
     "certFile": "/srv/box/ingress/server-chain.pem",
     "ingressLeafSha256": "replace-with-the-issued-leaf-der-sha256",
     "keyFile": "/srv/box/ingress/server-key.pem",
     "readySha256": "replace-with-the-exact-ready-receipt-sha256",
     "runtimeDir": "/srv/box/runs/current-run"
   }
   ```

   Read the receipt digest with `sha256sum /srv/box/runs/current-run/ready.json` under the original owner UID. Start the host executable with `node host-ingress.ts /absolute/private/ingress.json`. The host listener accepts one private IPv4 bind and port, the configured DNS origin, and HTTP Upgrade at `/`. Restrict network access to the approved relay path. If the original launcher, receipt or socket changes, ingress closes its sessions and listener. Start a new explicitly admitted ingress for a new generation.

   For the file-only deployment the Worker and Gateway require the pinned leaf, trusted CA and matching hostname before sending the bearer. The ingress adds `X-OpenClaw-External-Workspace-Generation` to the successful authenticated upgrade using its pinned receipt digest. It drops the header supplied by the native server. The Worker and the opt-in [Gateway runtime](../ordinary-chat/README.md#bind-a-standalone-gateway-to-one-box-execution) check the receipt digest before sending native requests.

4. At provision, create the one relay Pod with the stable Service labels and the exact trusted Harness requirements, including Agent, revision, and provider network profile. Build [relay.Dockerfile](relay.Dockerfile) from this directory with `--build-arg NODE_IMAGE=<approved-node-image-by-digest>`. Give the provider the resulting relay image by digest. The relay uses UID:GID `1000:1000`, read-only root, no added capabilities, `RuntimeDefault` seccomp, and no ServiceAccount token or host mounts. Expose TCP port 8443. Supply:

   | Environment variable         | Value                                                           |
   | ---------------------------- | --------------------------------------------------------------- |
   | `BOX_RELAY_LISTEN_ADDRESS`   | Pod IP from `status.podIP`                                      |
   | `BOX_RELAY_UPSTREAM_ADDRESS` | Exact dedicated host private IPv4 address                       |
   | `BOX_RELAY_AUTHORITY`        | Exact Service DNS name                                          |
   | `BOX_RELAY_CA_FILE`          | Read-only public CA bundle, such as `/etc/box-transport/ca.pem` |

   Use `node /opt/box-ingress/relay.ts probe` as the exec readiness probe (five-second period and timeout, one failure threshold). It verifies TLS through the real relay and expects a native 401 response to an anonymous WebSocket upgrade. The Pod receives no bearer. The example Driver uses its own bearer and requires a matching Codex JSON-RPC `initialize` result before reporting `serving`.

5. Read back the per-revision policy before the relay can serve. [relay-networkpolicy.example.yaml](relay-networkpolicy.example.yaml) shows the Gateway and Worker selectors and the single Box host `/32` on TCP 8443. Check other effective policies because Kubernetes NetworkPolicies are additive. The relay does not need DNS egress. Preserve the UID of the original Pod and policy through the provider lifecycle. Retire those exact resources and verify the Service has no matching endpoint.

A Ready Pod proves reachability to the native authentication boundary. It does not establish a model turn, an outbound workspace-node connection, or a protected repository operation.
