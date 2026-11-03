---
published: false
---

## Remove the Installation

Keep the saved session and complete [Delete Agent](quickstart-delete-agent.md) first. Verify that this dedicated quickstart installation has no other Agents to retain. The following removes the recorded OCE release and the OpenShell release installed for it:

```bash
source /path/to/private/run/session.sh
helm --kubeconfig "$KUBECONFIG" --kube-context "$CONTEXT" -n "$PLATFORM_NS" list
helm --kubeconfig "$KUBECONFIG" --kube-context "$CONTEXT" -n "$PLATFORM_NS" uninstall "$RELEASE"
helm --kubeconfig "$KUBECONFIG" --kube-context "$CONTEXT" -n "$PLATFORM_NS" uninstall openshell-gateway
kube -n "$PLATFORM_NS" delete deployment oce-owner-listener --ignore-not-found
kube -n "$PLATFORM_NS" delete configmap oce-owner-listener --ignore-not-found
kube -n "$PLATFORM_NS" delete secret oce-owner-browser-tls --ignore-not-found
```

Stop the laptop port-forward. Remove the quickstart network policies recorded by setup and Add Git, if those files exist:

```bash
for policy_file in "$RUN_DIR/agent-service-peers.json" "$RUN_DIR/protected-service-peers.json" "$RUN_DIR/listener.json"; do
  if [[ -f $policy_file ]]; then kube delete -f "$policy_file" --ignore-not-found; fi
done
kube -n "$PLATFORM_NS" delete networkpolicy oce-initialization-dns-vip oce-worker-openshell-management --ignore-not-found
```

| Created or used during setup                                                                                                    | Cleanup outcome                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| OCE and OpenShell Helm releases, private listener and recorded network policies                                                 | Commands above remove their managed resources.                                                             |
| Versioned Installation Secrets, database/authentication/client-TLS Secrets, browser bootstrap claim and Git registry/key inputs | Operator-created inputs remain; remove only this installation's recorded objects after deciding retention. |
| Backing tenant namespace, tenant RoleBindings and retained workspace/PVC storage                                                | Inspect after Agent deletion; remove only this installation's remaining objects.                           |
| Kubernetes cluster, shared `oce-system` namespace, GatewayClass, controllers and StorageClasses                                 | Retained for other installations and workloads.                                                            |
| External database, roles, backups and image registry                                                                            | Retained; use their owners' provisioning records for separate removal.                                     |

Helm does not remove all operator-created inputs or retained storage. Inventory the selected namespace before removing the quickstart's versioned Installation Secrets, registry ConfigMaps, App/custody/TLS Secrets, bootstrap claim and other retained volumes:

```bash
kube -n "$PLATFORM_NS" get secrets,configmaps,persistentvolumeclaims
kube get namespaces -l "openclaw.dev/namespace=$namespace"
```

Remove only resources recorded as belonging to this installation. Keep shared controllers, GatewayClasses, namespaces, storage and other users' workloads. Confirm the storage reclaim policy before deleting a claim; preserve required backups first. The external PostgreSQL database and its backups are managed separately. Retire only this installation's database, roles and secrets through the database owner's provisioning procedure.

Issued GitHub tokens can remain valid until expiry after the worker disappears. Installation removal does not revoke the service-account PAT or uninstall the GitHub App. Remove private run-owned credential copies when they are no longer needed; retain the required recovery and deletion records.
