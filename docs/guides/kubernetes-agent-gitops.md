# Manage an existing Agent with Argo CD

Install the alpha Operator, review ownership of an existing dedicated Agent,
and let Argo CD apply its desired Configuration. First-time resource creation is
not supported in this delivery. Read the [current limits](../reference/kubernetes-agent-operator.md)
before preparing manifests.

## Prepare administrator-owned dependencies

1. Install OCC and its worker/PostgreSQL through the supported Kubernetes setup.
   Use controller code containing the external-management API and migration 0077.
2. Provision a dedicated Agent with its own Configuration, ready Harness auth and
   required Secret bindings through the ordinary Agent workflow.
3. Create a non-Agent ServicePrincipal and issue a service key. Grant exact
   Namespace read, Agent read/update/administer/deploy/operate, Configuration
   read/update, revision read and required Secret/credential-source permissions.
   These are independent grants; administer does not imply other actions.
4. Store the service key and optional public CA in private Kubernetes Secrets in
   the Operator namespace. Keep model and Telegram credential values in their
   existing OCC Secret/credential-source owners, outside Git.
5. Install Argo CD with rights restricted to the target CR namespace/kinds.
   Configure a read-only Git deploy key. Do not grant it access to runtime Pods,
   runtime Secrets or broad Installation administration.

The Connection is administrator-owned trust configuration. Restrict its writers
separately from Agent authors. Review any change to its HTTPS endpoint or key
reference. Keep Kubernetes secret material and repository private keys out of
manifests and command history.

## Install the Operator

Select an approved digest-pinned controller image that contains `apps/operator`.
The chart intentionally has no floating image default. Supply a stable cluster
source ID, exact credential Secret names, actual Kubernetes API endpoint CIDRs
and ports, and the exact Enterprise destination.

```sh
helm upgrade --install oce-operator deploy/helm/openclaw-enterprise-operator   --namespace oce-agent-operator --create-namespace   --values /private/operator-values.yaml
```

Helm installs CRDs on first installation but does not upgrade existing CRDs.
Review schema changes and apply the matching chart's `crds/` directory explicitly
before upgrading the controller. Keep CRD and Operator versions together.

The NetworkPolicy allows DNS, the selected Kubernetes API endpoints and the
selected Enterprise destination only. Allow translated API addresses where the
cluster dataplane requires them. Verify allowed and denied traffic on the chosen
cluster; a declared NetworkPolicy alone does not prove enforcement.

## Review and declare an Agent

Read the Agent management API with authorized tooling and review its `adoption`
snapshot. Stop the previous desired-state reconciler. Commit a manifest with
the reviewed values; the following IDs are placeholders, not discovered by name.

```yaml
apiVersion: enterprise.openclaw.ai/v1alpha1
kind: OCEAgent
metadata:
  name: assistant
  namespace: oce-agent-operator
spec:
  namespaceRef: tenant
  executionMode: dedicated
  desiredState: running
  deletionPolicy: Retain
  nativeAdmin: true
  adopt:
    agentId: agt_REVIEWED
    configurationId: cfg_REVIEWED
    configurationGeneration: 1
    activeRevisionId: rev_REVIEWED
    fingerprint: REVIEWED_SHA256
    managementVersion: 0
  harnessAuth:
    method: credential_source
    sourceId: cs_EXISTING_READY_SOURCE
  configuration:
    values:
      # Copy the complete reviewed native Configuration, including its Harness.
      messages:
        visibleReplies: automatic
    secretBindings:
      TELEGRAM_BOT_TOKEN:
        secretRef: telegram-token
```

Create the referenced `OCENamespace` with `connectionRef`, `existingId` and
Retain policy, and `OCESecret` with `namespaceRef`, `existingId` and Retain policy.
The administrator supplies `OCEConnection` with its Installation ID, HTTPS origin,
`namespaceScope.existingIds`, `allowCreate: false` and private `serviceKeyRef`.
A partial native Configuration can remove required settings: copy the complete
reviewed values. Keep values free of plaintext credentials.

## Configure Argo CD and verify automatic apply

Point an Application at the manifest path, enable automated sync, self-heal and
prune, and use an AppProject that allows only the approved repository,
namespace and OCE kinds. Add increasing `argocd.argoproj.io/sync-wave`
annotations for Connection, Namespace, Secret and Agent dependencies.

Register the chart's `argocd-health.lua` as
`resource.customizations.health.enterprise.openclaw.ai_<Kind>` for each of the
four kinds in `argocd-cm`. Enable
`resource.customizations.useOpenLibs.enterprise.openclaw.ai_<Kind>: "true"`
for these administrator-reviewed scripts. Run the Argo controller with `TZ=UTC`.
The script checks generation, age and the Ready condition.

Wait for Synced **and** Healthy. Then change a harmless Agent setting in Git,
wait for normal Argo polling and verify one new Configuration generation,
one deployment revision and fresh ready runtime Pods. Repeated reconciliation
must not create more revisions. Confirm the real channel still responds; status
alone is not a Telegram delivery test.

Deleting a Retain Agent CR releases management and keeps the running Agent.
Recreating the CR gives it a new UID/source: review the current management
version and snapshot before adopting again. A normal administrator stop suspends
automatic management. Do not expect Argo to restart it until explicit ownership
release and reviewed re-adoption. See [status and recovery semantics](../reference/kubernetes-agent-operator.md#status-retries-and-deletion).
