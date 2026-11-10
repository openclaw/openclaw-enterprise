# Install OCE on a prepared EKS cluster

Complete [EKS preparation](eks-openshell-setup.md) first. Continue in the **same
protected Bash session**, from the same OCE checkout, with the staged `$RUN_DIR`,
private `$KUBECONFIG`, selected `$CONTEXT`, image/chart references and network
inventory. Do not restart the session setup or replace its protected files.

This continues the development and evaluation workflow; [OpenShell production
qualification remains incomplete](../../reference/drivers/openshell-sandbox.md#remaining-qualification-work).

<a id="configure-the-protected-copies-and-install"></a>

Confirm the database endpoint from your infrastructure outputs; EKS does not select RDS automatically. For RDS, obtain its [approved CA bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html). The templates use Secret `occ-database-ca`, key `ca.pem`, mounted at `/etc/openclaw/database-ca`. Both database URLs must use the database hostname and `sslmode=verify-full&sslrootcert=/etc/openclaw/database-ca/ca.pem`. Use the provider’s verified CA for other PostgreSQL services. Keep exact database and API egress addresses current through failover; security groups do not replace NetworkPolicies.

<Snippet file="../../snippets/openshell-quickstart/cluster-installation.md" />

<a id="4-enroll-linear-and-protected-git"></a>
<a id="5-deploy-and-open-the-owners-agent"></a>

## 4. Prepare the operator session

Continue in the same Bash shell to [Deploy your first Agent](deploy-first-agent.md).

## Verify workspace routing

After activation, check accepted/programmed Gateway and HTTPRoute status, ready certificates and an accepted API-key SecurityPolicy. Follow the [routing checks](workspace-routing.md#verify-routing-and-file-access) to verify invalid operator keys are rejected and dedicated Harnesses cannot bypass Envoy to reach the native Gateway.

In the Console **Workspace files** tab, read all four paths, save and reload a harmless change, then restore the original. Previously absent files should report `NOT_FOUND` with editable fields, not `DEPENDENCY_UNAVAILABLE`. A bound PVC or healthy OCC API alone does not prove routing. Across Pod replacement, compare PVC identities and existing session IDs to verify retained Gateway state. Record resource ownership, backups, credential renewal and recovery responsibilities using [production handoff](production-handoff.md).

For later upgrades, first repeat the [API and webhook policy refresh](eks-openshell-setup.md#refresh-api-network-policies-after-the-node-groups-join). Then use [Upgrade production images](production-upgrade.md), its [checklist](upgrade-checklist.md) and [baseline](upgrade-baseline.md). Helm rollback does not undo committed migrations or restore Agent-volume data; use [upgrade recovery](production-upgrade-recovery.md) after a failure.

To finish, [delete the Agent](quickstart-delete-agent.md), then clean up the installation with [Amazon EKS cleanup](eks-cleanup.md).
