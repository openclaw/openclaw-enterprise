# Set up Compose OCC with local k3d

Use this setup for the hybrid local target of [main](./main.md). Follow
[Compose OCC with Kubernetes compute](../../../../docs/guides/deploy/local-kubernetes-development.md#run-occ-in-compose-with-kubernetes-compute),
then [connect Compose to Kubernetes Agents](../../../../docs/guides/deploy/local-compose-kubernetes.md).
OCC, its Kubernetes worker, and PostgreSQL run in Compose; Agents run in k3d.
This is not the default Compose-only preview, which cannot deploy Agents.

## Follow the guides in order

1. Select the explicit hybrid profile from the local guide. Resolve a fresh
   private state directory, Compose project, cluster, subnet, and free ports,
   including PostgreSQL. Record immutable images and the retention decision.
2. Verify the generated state selects Kubernetes compute and sandbox Driver
   `none`. Record the actual node, `controller`, `worker-kubernetes`, and
   `postgres` addresses on the owned private network. Use the generated
   kubeconfig/context; preserve unrelated Compose projects and clusters.
3. Complete the hybrid guide's routing prerequisites and render only the routing
   resources. Do not install a second OCC or PostgreSQL into Kubernetes. Keep
   the routing NodePort private, retain certificate verification, and verify
   live network isolation with positive controls.
4. Apply the guide's protected Installation changes and mount the routing key
   and public CA into both `controller` and `worker-kubernetes`. Recreate only
   those owned services. Recheck exact address-based peers after recreation.
   Create the test Namespace only after routing is ready; do not patch an earlier
   Namespace's policies to manufacture acceptance.
5. Exercise the omitted-broker case first. For repository checks, follow the
   hybrid guide's [repository and Slack setup](../../../../docs/guides/deploy/local-compose-kubernetes.md#add-repository-and-slack-services)
   and the linked standalone broker procedure. Preserve its private control
   socket, key isolation, exact relay peer, TLS, and both Slack proxy paths.
6. Verify both standard presets, Console provisioning, Codex node enrollment,
   and real model/tool execution. Follow main's separate runtime and credential
   requirements; healthy Compose containers alone are not acceptance.

## Native UI boundary and reporting

This profile does not provide the Kubernetes-only shared-session native-admin
browser domain. Follow the hybrid guide's documented local TLS relay and optional
gateway-password procedure for native access. Treat that as password-authenticated
native proof, including exact-session continuity where available; it does not
pass main's Console-launched shared-session or OCC browser-authentication checks.
Record those unsupported checks explicitly. Never disable TLS verification or
claim full main parity while required capabilities remain unavailable.

## Clean up

Apply [main's retention decision](./runtime-acceptance.md#completion) first.
Preserve requested running Agents and their dependencies; the shutdown steps
below apply only to resources selected for disposal.

Stop repository-bound Agents and verify broker session disposal before stopping
the broker. Use the original profile's documented `dev down` with the same state,
project, and engine selection. Remove only the additional owned relay/proxy
services, forwards, and public CA trust entries. Preserve state and the broker
when credential cleanup is pending; record retained resources and the blocker.
