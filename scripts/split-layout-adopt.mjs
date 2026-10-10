#!/usr/bin/env node
// Upgrades the split-layout tenants of a released single-cluster Installation in place: each
// `oce-gateways-<hash>` storage namespace becomes its tenant's namespace. Canonical Secrets,
// Configurations, service-account credentials and dedicated Gateway state stay where they are;
// the old Harness namespace's claims move by PersistentVolume rebind and its Agent Secrets are
// copied byte for byte. OCC's database is not written. See docs/guides/deploy/breaking-changes-archive.md.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MANAGER = "openclaw-enterprise";
const MANAGED_BY = "app.kubernetes.io/managed-by";
const TENANT_LABEL = "openclaw.dev/namespace";
const STORAGE_LABEL = "openclaw.dev/gateway-namespace";
const ID_ANNOTATION = "openclaw.dev/namespace-id";
const LIFECYCLE_ANNOTATION = "openclaw.dev/namespace-lifecycle";
// A Codex OAuth source is bound to the UID of the workspace claim it was handed to.
const OAUTH_VOLUME_ANNOTATION = "openclaw.dev/oauth-volume-uid";
const OAUTH_AGENT_ANNOTATION = "openclaw.dev/oauth-agent-id";
const COMPUTE_FIELD_MANAGER = "openclaw-enterprise-compute";
const GATEWAY_MEMBERSHIP_LABEL = "openclaw-enterprise.io/gateway";
export const JOURNAL_ANNOTATION = "openclaw.dev/split-layout-adopt";
const JOURNAL_FORMAT = "oce-split-layout-adopt/v1";
const WRITERS = Object.freeze(["api", "worker"]);
// Claims that hold Harness workspaces and embedded Gateway state.
const MOVED_CLAIM = /^(?:workspace|gateway-state)-[0-9a-f]{12}$/u;
// Per-revision projections of canonical Secrets; the next deploy renders them again.
const PROJECTED_SECRET = /^(?:gateway|harness)-secrets-[0-9a-f]{12}-[0-9a-f]{12}$/u;
// Objects Kubernetes derives from others or creates in every namespace.
const DERIVED_RESOURCES = new Set([
  "events",
  "events.events.k8s.io",
  "pods",
  "replicasets.apps",
  "controllerrevisions.apps",
  "endpoints",
  "endpointslices.discovery.k8s.io",
]);
const ROUTE_RESOURCES = new Set(["httproutes", "securitypolicies"]);
const listedResource = (resource) =>
  resource === "pods" ||
  (!DERIVED_RESOURCES.has(resource) && !resource.endsWith(".metrics.k8s.io"));
const REQUIRED_GRANTS = Object.freeze([
  { role: "openclaw-tenant-worker", serviceAccount: "openclaw-enterprise-worker" },
  { role: "openclaw-tenant-api", serviceAccount: "openclaw-enterprise-api" },
  { role: "openclaw-tenant-configuration", serviceAccount: "openclaw-enterprise-api" },
]);

const usage = `Usage:
  node scripts/split-layout-adopt.mjs plan [--out FILE]
  node scripts/split-layout-adopt.mjs apply --archive DIR --yes
  node scripts/split-layout-adopt.mjs revert --archive DIR --yes
  node scripts/split-layout-adopt.mjs finalize --yes [--controller-upgraded]
Options: [--namespace-id ID]... [--occ-namespace NAME] [--context NAME] [--kubeconfig FILE]
  [--drop-resource RESOURCE]... [--accept-oauth-reconnect]
The script does not back up volumes: snapshot the PersistentVolumes plan lists first.`;

export class AdoptError extends Error {}

const sha256Hex = (value, length) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);
export const storageNamespaceName = (id) => `oce-gateways-${sha256Hex(id, 24)}`;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const labelsOf = (object) => object?.metadata?.labels ?? {};
const managed = (object, id) =>
  labelsOf(object)[MANAGED_BY] === MANAGER && labelsOf(object)[TENANT_LABEL] === id;
const terminating = (object) =>
  object.metadata?.deletionTimestamp !== undefined || object.status?.phase === "Terminating";

/** A kubectl client over `run(args, input)`, which returns `{status, stdout, stderr}`. */
export function createKubectl(run, { warn = () => {} } = {}) {
  const call = (args, input) => {
    const result = run(args, input);
    if (result.status !== 0) {
      // kubectl errors name the object, never Secret data.
      throw new AdoptError(
        `kubectl ${args.slice(0, 3).join(" ")}: ${String(result.stderr).trim()}`,
      );
    }
    return result.stdout;
  };
  const json = (args, input) => {
    const out = call(args, input);
    return out.trim() === "" ? undefined : JSON.parse(out);
  };
  const scope = (namespace) => (namespace === undefined ? [] : ["-n", namespace]);
  return {
    get: (resource, name, namespace) =>
      json(["get", resource, name, ...scope(namespace), "--ignore-not-found", "-o", "json"]),
    list: (resource, namespace, selector) =>
      json([
        "get",
        resource,
        ...scope(namespace),
        ...(selector === undefined ? [] : ["-l", selector]),
        "-o",
        "json",
      ])?.items ?? [],
    resources: () => {
      // One unavailable APIService fails the whole command but still prints the rest.
      const args = ["api-resources", "--verbs=list", "--namespaced", "-o", "name"];
      const result = run(args);
      if (result.status !== 0 && String(result.stdout).trim() === "") {
        throw new AdoptError(`kubectl api-resources: ${String(result.stderr).trim()}`);
      }
      if (result.status !== 0) {
        warn(`kubectl api-resources: ${String(result.stderr).trim()}`);
      }
      const resources = String(result.stdout)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      for (const required of ["persistentvolumeclaims", "secrets", "pods"]) {
        if (!resources.includes(required)) {
          throw new AdoptError(`kubectl api-resources did not list ${required}`);
        }
      }
      return resources;
    },
    // Server-side apply under another field manager, for fields that manager owns natively.
    applyAs: (manager, object) =>
      json(
        [
          "apply",
          "--server-side",
          `--field-manager=${manager}`,
          "--force-conflicts",
          "-f",
          "-",
          "-o",
          "json",
        ],
        JSON.stringify(object),
      ),
    create: (object) => json(["create", "-f", "-", "-o", "json"], JSON.stringify(object)),
    patch: (resource, name, namespace, type, patch) =>
      json([
        "patch",
        resource,
        name,
        ...scope(namespace),
        "--type",
        type,
        "-p",
        JSON.stringify(patch),
        "-o",
        "json",
      ]),
    // kubectl has no precondition flag; the raw DELETE carries the API's DeleteOptions.
    deleteExact: (path, uid) =>
      call(
        ["delete", "--raw", path, "-f", "-"],
        JSON.stringify({ kind: "DeleteOptions", apiVersion: "v1", preconditions: { uid } }),
      ),
  };
}

function objectPath(object, resource) {
  const plural = resource.split(".")[0];
  const base = object.apiVersion.includes("/") ? `/apis/${object.apiVersion}` : "/api/v1";
  const scoped = object.metadata.namespace ? `/namespaces/${object.metadata.namespace}` : "";
  return `${base}${scoped}/${plural}/${object.metadata.name}`;
}

const mountedClaims = (pods) =>
  new Set(
    pods.flatMap((pod) =>
      (pod.spec?.volumes ?? []).map((volume) => volume.persistentVolumeClaim?.claimName),
    ),
  );

function hasGrant(bindings, { role, serviceAccount }) {
  return bindings.some(
    (binding) =>
      binding.roleRef?.kind === "ClusterRole" &&
      (binding.roleRef.name === role || binding.roleRef.name?.endsWith(`-${role}`)) &&
      (binding.subjects ?? []).some(
        (subject) => subject.kind === "ServiceAccount" && subject.name === serviceAccount,
      ),
  );
}

/** Sorts every object in the old Harness namespace into moved, dropped or refused. */
export function classify(resource, object, id, dropResources = []) {
  const name = object.metadata.name;
  if (resource === "pods") {
    // Workload Pods go with their owners; a bare Pod is someone's and is not deleted silently.
    return (object.metadata.ownerReferences ?? []).length > 0 ? "derived" : "refuse";
  }
  if (DERIVED_RESOURCES.has(resource)) {
    return "derived";
  }
  if (
    (resource === "configmaps" && name === "kube-root-ca.crt") ||
    (resource === "serviceaccounts" && name === "default")
  ) {
    return "derived";
  }
  // Operator grants; the storage namespace holds its own (checked separately).
  if (resource === "rolebindings.rbac.authorization.k8s.io") {
    return "drop";
  }
  if (!managed(object, id)) {
    // Kinds the operator confirmed are rendered again or disposable (for example a Sandbox
    // provider's objects).
    return dropResources.includes(resource) ? "drop" : "refuse";
  }
  if (resource === "persistentvolumeclaims") {
    return MOVED_CLAIM.test(name) ? "move-claim" : "refuse";
  }
  if (resource === "secrets") {
    return PROJECTED_SECRET.test(name) ? "drop" : "copy-secret";
  }
  if (ROUTE_RESOURCES.has(resource.split(".")[0])) {
    return "route";
  }
  return "drop";
}

/** Reads one tenant's two namespaces and decides what adoption must do. Read-only. */
export function planTenant(
  kubectl,
  storage,
  resources,
  { dropResources = [], acceptOauthReconnect = false } = {},
) {
  const id = labelsOf(storage)[STORAGE_LABEL];
  const plan = {
    namespaceId: id,
    storage: storage.metadata.name,
    storageUid: storage.metadata.uid,
    tenant: undefined,
    tenantUid: undefined,
    claims: [],
    volumes: [],
    secrets: [],
    routes: [],
    dropped: {},
    running: [],
    reconnectAgents: [],
    refusals: [],
  };
  const refuse = (reason) => plan.refusals.push(reason);
  if (
    storage.metadata.annotations?.[ID_ANNOTATION] !== id ||
    labelsOf(storage)[MANAGED_BY] !== MANAGER
  ) {
    refuse(`${storage.metadata.name} is not an OCE-managed storage namespace`);
  }
  if (terminating(storage)) {
    refuse(`${storage.metadata.name} is terminating`);
  }
  const tenants = kubectl.list("namespaces", undefined, `${TENANT_LABEL}=${id}`);
  if (tenants.length !== 1) {
    refuse(
      tenants.length === 0
        ? "no tenant namespace in this cluster (a two-cluster control target is not affected)"
        : `${tenants.length} namespaces claim the tenant`,
    );
    return plan;
  }
  const tenant = tenants[0];
  plan.tenant = tenant.metadata.name;
  plan.tenantUid = tenant.metadata.uid;
  if (tenant.metadata.annotations?.[LIFECYCLE_ANNOTATION] === "external") {
    refuse(`${plan.tenant} is an existing namespace; use scripts/split-layout-tenants.mjs`);
  } else if (
    tenant.metadata.annotations?.[ID_ANNOTATION] !== id ||
    labelsOf(tenant)[MANAGED_BY] !== MANAGER
  ) {
    refuse(`${plan.tenant} is not an OCE-managed tenant namespace`);
  }
  if (terminating(tenant)) {
    refuse(`${plan.tenant} is terminating`);
  }
  for (const resource of resources.filter(listedResource)) {
    let objects;
    try {
      objects = kubectl.list(resource, plan.tenant);
    } catch (error) {
      refuse(`cannot list ${resource} in ${plan.tenant}: ${error.message}`);
      continue;
    }
    for (const object of objects) {
      const name = object.metadata.name;
      const verdict = classify(resource, object, id, dropResources);
      if (verdict === "move-claim") {
        plan.claims.push(name);
        plan.volumes.push(object.spec?.volumeName);
      } else if (verdict === "copy-secret") {
        plan.secrets.push(name);
      } else if (verdict === "route") {
        plan.routes.push({ resource, name });
      } else if (verdict === "drop") {
        plan.dropped[resource] = (plan.dropped[resource] ?? 0) + 1;
      } else if (verdict === "refuse") {
        refuse(`${plan.tenant} holds ${resource}/${name}, which adoption does not move`);
      }
    }
  }
  const claimUids = new Set();
  for (const name of plan.claims) {
    if (kubectl.get("persistentvolumeclaims", name, plan.storage) !== undefined) {
      refuse(`${plan.storage} already has PersistentVolumeClaim ${name}`);
    }
    const uid = kubectl.get("persistentvolumeclaims", name, plan.tenant)?.metadata.uid;
    if (uid !== undefined) {
      claimUids.add(uid);
    }
  }
  // The moved claim gets a new UID, so an OAuth source handed to it needs a new sign-in.
  for (const namespace of [plan.storage, plan.tenant]) {
    for (const secret of kubectl.list("secrets", namespace)) {
      const annotations = secret.metadata.annotations ?? {};
      if (claimUids.has(annotations[OAUTH_VOLUME_ANNOTATION])) {
        plan.reconnectAgents.push(annotations[OAUTH_AGENT_ANNOTATION] ?? secret.metadata.name);
      }
    }
  }
  if (plan.reconnectAgents.length > 0 && !acceptOauthReconnect) {
    refuse(
      `Agents ${plan.reconnectAgents.join(", ")} use Codex OAuth bound to a moved claim and ` +
        "must sign in again after adoption; add --accept-oauth-reconnect",
    );
  }
  for (const name of plan.secrets) {
    const existing = kubectl.get("secrets", name, plan.storage);
    const source = kubectl.get("secrets", name, plan.tenant);
    if (existing !== undefined && !sameSecret(existing, source)) {
      refuse(`${plan.storage} already has a different Secret ${name}`);
    }
  }
  const bindings = kubectl.list("rolebindings.rbac.authorization.k8s.io", plan.storage);
  for (const grant of REQUIRED_GRANTS) {
    if (!hasGrant(bindings, grant)) {
      refuse(
        `${plan.storage} lacks a RoleBinding of ClusterRole *-${grant.role} to ` +
          `${grant.serviceAccount}; see production-agents.md#grant-tenant-rolebindings`,
      );
    }
  }
  for (const namespace of [plan.tenant, plan.storage]) {
    for (const deployment of kubectl.list("deployments.apps", namespace, "openclaw.dev/agent")) {
      if ((deployment.spec?.replicas ?? 0) > 0) {
        plan.running.push(labelsOf(deployment)["openclaw.dev/agent"]);
      }
    }
  }
  plan.running = [...new Set(plan.running)].sort();
  return plan;
}

function sameSecret(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.type === right.type &&
    JSON.stringify(Object.entries(left.data ?? {}).sort()) ===
      JSON.stringify(Object.entries(right.data ?? {}).sort())
  );
}

/** Plans every released split-layout tenant, or only the selected Namespace IDs. */
export function planAll(kubectl, { namespaceIds = [], ...options } = {}) {
  const resources = kubectl.resources();
  const plans = [];
  const adopted = [];
  for (const storage of kubectl.list("namespaces", undefined, STORAGE_LABEL)) {
    const id = labelsOf(storage)[STORAGE_LABEL];
    if (namespaceIds.length > 0 && !namespaceIds.includes(id)) {
      continue;
    }
    if (storage.metadata.name !== storageNamespaceName(id)) {
      continue;
    }
    // A journal marks a tenant this script already started; apply resumes it, finalize ends it.
    if (storage.metadata.annotations?.[JOURNAL_ANNOTATION] !== undefined) {
      adopted.push({ namespaceId: id, storage: storage.metadata.name });
      continue;
    }
    if (labelsOf(storage)[TENANT_LABEL] !== undefined) {
      continue;
    }
    plans.push(planTenant(kubectl, storage, resources, options));
  }
  return { plans, adopted };
}

function readJournal(kubectl, storage) {
  const object = kubectl.get("namespaces", storage);
  const raw = object?.metadata?.annotations?.[JOURNAL_ANNOTATION];
  if (raw === undefined) {
    return undefined;
  }
  const journal = JSON.parse(raw);
  if (journal?.format !== JOURNAL_FORMAT) {
    throw new AdoptError(`${storage} has an unreadable ${JOURNAL_ANNOTATION} annotation`);
  }
  return journal;
}

function journalsOf(kubectl) {
  return kubectl
    .list("namespaces", undefined, STORAGE_LABEL)
    .filter((object) => object.metadata.annotations?.[JOURNAL_ANNOTATION] !== undefined)
    .map((object) => readJournal(kubectl, object.metadata.name));
}

function writeJournal(kubectl, journal) {
  kubectl.patch("namespaces", journal.storage, undefined, "merge", {
    metadata: { annotations: { [JOURNAL_ANNOTATION]: JSON.stringify(journal) } },
  });
}

async function waitFor(
  check,
  description,
  { timeoutMs, intervalMs = 2_000, sleep, detail = () => "" },
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new AdoptError(`timed out after ${timeoutMs} ms waiting for ${description}${detail()}`);
    }
    await sleep(intervalMs);
  }
}

function writerDeployments(kubectl, occNamespace) {
  return Object.fromEntries(
    WRITERS.map((component) => {
      const name = `openclaw-enterprise-${component}`;
      const deployment = kubectl.get("deployments.apps", name, occNamespace);
      if (deployment === undefined) {
        throw new AdoptError(`${occNamespace}/${name} does not exist; set --occ-namespace`);
      }
      return [component, deployment];
    }),
  );
}

const images = (deployment) =>
  (deployment.spec?.template?.spec?.containers ?? []).map(({ image }) => image).sort();

/**
 * Moves one claim's PersistentVolume from `from` to `to`. Every step reads live state first,
 * so a rerun after any failure continues where the last one stopped.
 */
export async function rebindClaim(kubectl, entry, from, to, { sleep, timeoutMs }) {
  const { name, pv } = entry;
  const readVolume = () => {
    const volume = kubectl.get("persistentvolumes", pv);
    if (volume === undefined) {
      throw new AdoptError(`PersistentVolume ${pv} of claim ${name} is missing`);
    }
    return volume;
  };
  // Retain first: the claim delete below must never release the volume's data.
  if (readVolume().spec.persistentVolumeReclaimPolicy !== "Retain") {
    kubectl.patch("persistentvolumes", pv, undefined, "merge", {
      spec: { persistentVolumeReclaimPolicy: "Retain" },
    });
    if (readVolume().spec.persistentVolumeReclaimPolicy !== "Retain") {
      throw new AdoptError(`PersistentVolume ${pv} did not keep reclaim policy Retain`);
    }
  }
  const source = kubectl.get("persistentvolumeclaims", name, from);
  if (source !== undefined && source.spec?.volumeName === pv) {
    if (mountedClaims(kubectl.list("pods", from)).has(name)) {
      throw new AdoptError(`a Pod in ${from} still mounts ${name}; stop it and run again`);
    }
    kubectl.deleteExact(
      `/api/v1/namespaces/${from}/persistentvolumeclaims/${name}`,
      source.metadata.uid,
    );
    await waitFor(
      () => kubectl.get("persistentvolumeclaims", name, from) === undefined,
      `claim ${from}/${name} to be deleted`,
      { sleep, timeoutMs },
    );
  } else if (source !== undefined) {
    throw new AdoptError(`${from}/${name} is bound to another volume`);
  }
  const target = kubectl.get("persistentvolumeclaims", name, to);
  if (target !== undefined && target.spec?.volumeName !== pv) {
    throw new AdoptError(`${to}/${name} already exists for another volume`);
  }
  const claimRef = readVolume().spec.claimRef;
  const reserved =
    claimRef?.namespace === to &&
    claimRef.name === name &&
    (claimRef.uid === undefined || claimRef.uid === target?.metadata.uid);
  if (!reserved) {
    // Without uid and resourceVersion, the reference reserves the volume for the new claim.
    kubectl.patch("persistentvolumes", pv, undefined, "json", [
      {
        op: claimRef === undefined ? "add" : "replace",
        path: "/spec/claimRef",
        value: { apiVersion: "v1", kind: "PersistentVolumeClaim", namespace: to, name },
      },
    ]);
    const observed = readVolume().spec.claimRef;
    // The PV controller may already have bound an existing target claim.
    if (
      observed?.namespace !== to ||
      observed.name !== name ||
      (observed.uid !== undefined && observed.uid !== target?.metadata.uid)
    ) {
      throw new AdoptError(`PersistentVolume ${pv} did not accept the new claim reference`);
    }
  }
  if (target === undefined) {
    kubectl.create({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name, namespace: to, labels: entry.labels, annotations: entry.annotations },
      spec: { ...entry.spec, volumeName: pv },
    });
  }
  await waitFor(
    () => {
      const claim = kubectl.get("persistentvolumeclaims", name, to);
      return (
        claim?.status?.phase === "Bound" && readVolume().spec.claimRef?.uid === claim.metadata.uid
      );
    },
    `claim ${to}/${name} to bind ${pv}`,
    { sleep, timeoutMs },
  );
  if (entry.reclaimPolicy !== "Retain") {
    kubectl.patch("persistentvolumes", pv, undefined, "merge", {
      spec: { persistentVolumeReclaimPolicy: entry.reclaimPolicy },
    });
    if (readVolume().spec.persistentVolumeReclaimPolicy !== entry.reclaimPolicy) {
      throw new AdoptError(`PersistentVolume ${pv} did not restore ${entry.reclaimPolicy}`);
    }
  }
}

// Server-populated fields that must not be sent back on create.
function portable(object) {
  const copy = structuredClone(object);
  for (const field of [
    "uid",
    "resourceVersion",
    "creationTimestamp",
    "generation",
    "managedFields",
  ]) {
    delete copy.metadata[field];
  }
  delete copy.metadata.annotations?.["kubectl.kubernetes.io/last-applied-configuration"];
  delete copy.status;
  return copy;
}

const CLAIM_ANNOTATION_PREFIXES = [
  "pv.kubernetes.io/",
  "volume.beta.kubernetes.io/",
  "volume.kubernetes.io/",
];

function claimEntry(kubectl, plan, name) {
  const claim = kubectl.get("persistentvolumeclaims", name, plan.tenant);
  const pv = claim?.spec?.volumeName;
  if (claim === undefined || claim.status?.phase !== "Bound" || !pv) {
    throw new AdoptError(`${plan.tenant}/${name} is not a bound claim`);
  }
  const volume = kubectl.get("persistentvolumes", pv);
  return {
    name,
    pv,
    reclaimPolicy: volume.spec.persistentVolumeReclaimPolicy,
    labels: claim.metadata.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(claim.metadata.annotations ?? {}).filter(
        ([key]) => !CLAIM_ANNOTATION_PREFIXES.some((prefix) => key.startsWith(prefix)),
      ),
    ),
    // The live claim's class, not the release's manifest: a defaulted class must match the PV.
    spec: {
      accessModes: claim.spec.accessModes,
      resources: { requests: { storage: claim.spec.resources.requests.storage } },
      volumeMode: claim.spec.volumeMode ?? "Filesystem",
      ...(claim.spec.storageClassName === undefined
        ? {}
        : { storageClassName: claim.spec.storageClassName }),
    },
    moved: false,
  };
}

function writePrivate(path, value) {
  const partial = `${path}.partial`;
  writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(partial, path);
}

function archiveDirectory(archive, id) {
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  if ((statSync(archive).mode & 0o077) !== 0) {
    throw new AdoptError(`${archive} must be private (mode 0700)`);
  }
  const directory = join(archive, id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** Adopts every planned tenant. Stops OCC's API and worker first and leaves them stopped. */
export async function applyAdoption(
  kubectl,
  {
    archive,
    occNamespace = "openclaw-system",
    namespaceIds = [],
    dropResources = [],
    acceptOauthReconnect = false,
    log = () => {},
    sleep = defaultSleep,
    timeoutMs = 300_000,
  },
) {
  const { plans, adopted } = planAll(kubectl, {
    namespaceIds,
    dropResources,
    acceptOauthReconnect,
  });
  const started = adopted.map(({ storage }) => readJournal(kubectl, storage));
  const resumed = started.filter(({ state }) => state === "applying");
  const refusals = plans.flatMap(({ storage, refusals }) =>
    refusals.map((reason) => `${storage}: ${reason}`),
  );
  for (const { storage } of started.filter(({ state }) => state === "reverting")) {
    refusals.push(`${storage}: a revert is unfinished; run revert again`);
  }
  if (refusals.length > 0) {
    throw new AdoptError(`refusing to start:\n${refusals.join("\n")}`);
  }
  for (const journal of resumed) {
    if (journal.archive !== resolve(archive)) {
      throw new AdoptError(`${journal.storage} was started with --archive ${journal.archive}`);
    }
  }
  const writers = writerDeployments(kubectl, occNamespace);
  // A resumed run, or one after another tenant's apply, finds OCC already stopped: keep the
  // replicas and images recorded before the first stop.
  // --namespace-id narrows the plan, not this: any journal holds the pre-stop record.
  const anyJournal = journalsOf(kubectl).find((journal) => journal.writers !== undefined);
  const recorded =
    anyJournal?.writers ??
    Object.fromEntries(
      WRITERS.map((component) => [
        component,
        { replicas: writers[component].spec.replicas ?? 1, images: images(writers[component]) },
      ]),
    );
  if (plans.length + resumed.length === 0) {
    log("no split-layout tenants to adopt");
    // A run killed after its last tenant but before the API restart finishes here.
    if (anyJournal !== undefined) {
      await startOldApi(kubectl, recorded, { occNamespace, log, sleep, timeoutMs });
    }
    return [];
  }
  // After the controller upgrade, stopping its writers would leave OCC down: the old API
  // restart below only starts the images recorded at apply.
  for (const component of WRITERS) {
    if (
      anyJournal !== undefined &&
      JSON.stringify(images(writers[component])) !== JSON.stringify(recorded[component].images)
    ) {
      throw new AdoptError(
        `openclaw-enterprise-${component} runs other images than apply recorded; roll the ` +
          "controller back to the images recorded at apply before adopting more tenants",
      );
    }
  }
  // Journals are written before any change, so revert can always restore what was there.
  const journals = [...resumed];
  for (const plan of plans) {
    const journal = readJournal(kubectl, plan.storage) ?? {
      format: JOURNAL_FORMAT,
      state: "applying",
      namespaceId: plan.namespaceId,
      storage: plan.storage,
      storageUid: plan.storageUid,
      tenant: plan.tenant,
      tenantUid: plan.tenantUid,
      writers: recorded,
      running: plan.running,
      workloads: {},
      archive: resolve(archive),
      dropResources,
      claims: plan.claims.map((name) => claimEntry(kubectl, plan, name)),
      // null: to copy; "preexisting": an identical copy was already there and is not ours.
      secrets: Object.fromEntries(
        plan.secrets.map((name) => [
          name,
          kubectl.get("secrets", name, plan.storage) === undefined ? null : "preexisting",
        ]),
      ),
      routes: plan.routes,
      routesArchived: false,
    };
    writeJournal(kubectl, journal);
    journals.push(journal);
  }
  await stopWriters(kubectl, writers, { occNamespace, log, sleep, timeoutMs });
  for (const journal of journals) {
    await adoptTenant(kubectl, journal, { archive, log, sleep, timeoutMs });
  }
  await startOldApi(kubectl, recorded, { occNamespace, log, sleep, timeoutMs });
  return journals;
}

// The upgrade helper reads the Installation through the API, and the old API runs on the
// adopted layout: requests that touch an adopted tenant fail its ownership checks. The worker,
// which reconciles Agents, stays stopped until the upgrade.
async function startOldApi(kubectl, recorded, { occNamespace, log, sleep, timeoutMs }) {
  const { replicas, images: recordedImages } = recorded.api;
  const name = "openclaw-enterprise-api";
  const live = kubectl.get("deployments.apps", name, occNamespace);
  if (replicas === 0 || JSON.stringify(images(live)) !== JSON.stringify(recordedImages)) {
    return;
  }
  if ((live.spec.replicas ?? 1) !== replicas) {
    kubectl.patch("deployments.apps", name, occNamespace, "merge", { spec: { replicas } });
    log(`scaled ${occNamespace}/${name} back to ${replicas}`);
  }
  await waitFor(
    () =>
      (kubectl.get("deployments.apps", name, occNamespace)?.status?.availableReplicas ?? 0) >=
      replicas,
    `${name} to serve`,
    { sleep, timeoutMs },
  );
}

async function stopWriters(kubectl, writers, { occNamespace, log, sleep, timeoutMs }) {
  for (const component of WRITERS) {
    const name = `openclaw-enterprise-${component}`;
    if ((writers[component].spec.replicas ?? 1) !== 0) {
      kubectl.patch("deployments.apps", name, occNamespace, "merge", { spec: { replicas: 0 } });
      log(`scaled ${occNamespace}/${name} to 0`);
    }
    await waitFor(
      () => (kubectl.get("deployments.apps", name, occNamespace)?.status?.replicas ?? 0) === 0,
      `${name} to stop`,
      { sleep, timeoutMs },
    );
  }
}

async function adoptTenant(kubectl, journal, { archive, log, sleep, timeoutMs }) {
  const { tenant, storage, namespaceId: id } = journal;
  const save = () => writeJournal(kubectl, journal);
  // The plan ran while OCC still served. With OCC stopped nothing new appears, so take in
  // what appeared meanwhile; anything adoption does not handle stops here, before any change.
  for (const resource of kubectl.resources().filter(listedResource)) {
    const kind = resource.split(".")[0];
    if (!["persistentvolumeclaims", "secrets", "pods", ...ROUTE_RESOURCES].includes(kind)) {
      continue;
    }
    for (const object of kubectl.list(resource, tenant)) {
      const name = object.metadata.name;
      const verdict = classify(resource, object, id, journal.dropResources);
      if (verdict === "refuse") {
        throw new AdoptError(`${tenant} gained ${resource}/${name}, which adoption does not move`);
      }
      if (verdict === "move-claim" && !journal.claims.some((entry) => entry.name === name)) {
        journal.claims.push(claimEntry(kubectl, journal, name));
      } else if (verdict === "copy-secret" && !(name in journal.secrets)) {
        journal.secrets[name] =
          kubectl.get("secrets", name, storage) === undefined ? null : "preexisting";
      } else if (
        verdict === "route" &&
        !journal.routesArchived &&
        !journal.routes.some((route) => route.resource === resource && route.name === name)
      ) {
        journal.routes.push({ resource, name });
      }
    }
  }
  save();
  for (const deployment of kubectl.list("deployments.apps", tenant)) {
    const name = deployment.metadata.name;
    if (journal.workloads[name] === undefined) {
      journal.workloads[name] = deployment.spec?.replicas ?? 1;
      save();
    }
    if ((deployment.spec?.replicas ?? 1) !== 0) {
      kubectl.patch("deployments.apps", name, tenant, "merge", { spec: { replicas: 0 } });
    }
  }
  const moving = new Set(journal.claims.map(({ name }) => name));
  const mountingPods = () =>
    kubectl
      .list("pods", tenant)
      .filter((pod) => [...mountedClaims([pod])].some((claim) => moving.has(claim)));
  const mounting = () => mountingPods().map((pod) => pod.metadata.name);
  // A Gateway that ignores SIGTERM holds its claim for its whole grace period (330 s).
  const graceMs = Math.max(
    0,
    ...mountingPods().map((pod) => (pod.spec?.terminationGracePeriodSeconds ?? 0) * 1_000),
  );
  await waitFor(() => mounting().length === 0, `Pods in ${tenant} to release their claims`, {
    sleep,
    timeoutMs: timeoutMs + graceMs,
    detail: () => `; still mounting: ${mounting().join(", ")}`,
  });
  log(`${tenant}: workloads stopped`);
  for (const name of Object.keys(journal.secrets)) {
    const source = kubectl.get("secrets", name, tenant);
    const existing = kubectl.get("secrets", name, storage);
    if (existing !== undefined) {
      if (!sameSecret(existing, source ?? existing)) {
        throw new AdoptError(`${storage} already has a different Secret ${name}`);
      }
      // A run that died between create and journal save left its own copy.
      if (journal.secrets[name] === null) {
        journal.secrets[name] = existing.metadata.uid;
        save();
      }
      continue;
    }
    if (source === undefined) {
      throw new AdoptError(`${tenant}/${name} disappeared before it was copied`);
    }
    const copy = portable(source);
    copy.metadata.namespace = storage;
    // An owner in the old namespace would make the garbage collector delete the copy.
    delete copy.metadata.ownerReferences;
    journal.secrets[name] = kubectl.create(copy).metadata.uid;
    save();
  }
  log(`${tenant}: ${Object.keys(journal.secrets).length} Agent Secrets copied to ${storage}`);
  // Archive the routes before deleting them: revert recreates them from this file.
  const routesFile = join(archiveDirectory(archive, id), "routes.json");
  if (!journal.routesArchived) {
    const routes = journal.routes
      .map(({ resource, name }) => ({ resource, object: kubectl.get(resource, name, tenant) }))
      .filter(({ object }) => object !== undefined);
    writePrivate(routesFile, routes);
    journal.routesArchived = true;
    save();
  }
  for (const { resource, object } of JSON.parse(readFileSync(routesFile, "utf8"))) {
    const live = kubectl.get(resource, object.metadata.name, tenant);
    if (live !== undefined) {
      kubectl.deleteExact(objectPath(live, resource), live.metadata.uid);
    }
  }
  log(`${tenant}: ${journal.routes.length} routes archived and deleted`);
  for (const entry of journal.claims) {
    if (!entry.moved) {
      await rebindClaim(kubectl, entry, tenant, storage, { sleep, timeoutMs });
      entry.moved = true;
      save();
      log(`${tenant}/${entry.name} -> ${storage} (${entry.pv})`);
    }
  }
  // Storage first: until the tenant label leaves the old namespace, both claim the tenant and
  // OCC refuses to pick one, which is the safe state for a crash between the two patches.
  kubectl.patch("namespaces", storage, undefined, "merge", {
    metadata: { labels: { [TENANT_LABEL]: id } },
  });
  kubectl.patch("namespaces", tenant, undefined, "merge", {
    metadata: { labels: { [TENANT_LABEL]: null } },
  });
  // The release created this namespace without server-side apply. Hand the fields the
  // Compute Driver applies to a tenant namespace to its field manager, as on one it created,
  // so later changes to them apply without conflicts.
  const adopted = labelsOf(kubectl.get("namespaces", storage));
  kubectl.applyAs(COMPUTE_FIELD_MANAGER, {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: storage,
      labels: Object.fromEntries(
        [
          MANAGED_BY,
          TENANT_LABEL,
          STORAGE_LABEL,
          GATEWAY_MEMBERSHIP_LABEL,
          ...["enforce", "audit", "warn"].map((mode) => `pod-security.kubernetes.io/${mode}`),
        ]
          .filter((key) => adopted[key] !== undefined)
          .map((key) => [key, adopted[key]]),
      ),
      annotations: { [ID_ANNOTATION]: id },
    },
  });
  journal.state = "applied";
  save();
  log(`${storage} is now the tenant namespace of ${id}`);
}

/** Undoes apply while the old release is still installed (its API and worker stopped). */
export async function revertAdoption(
  kubectl,
  {
    archive,
    occNamespace = "openclaw-system",
    namespaceIds = [],
    log = () => {},
    sleep = defaultSleep,
    timeoutMs = 300_000,
  },
) {
  const journals = kubectl
    .list("namespaces", undefined, STORAGE_LABEL)
    .filter((storage) => storage.metadata.annotations?.[JOURNAL_ANNOTATION] !== undefined)
    .map((storage) => readJournal(kubectl, storage.metadata.name))
    .filter(({ namespaceId }) => namespaceIds.length === 0 || namespaceIds.includes(namespaceId));
  if (journals.length === 0) {
    log("nothing to revert");
    return [];
  }
  for (const journal of journals) {
    if (journal.routesArchived && journal.archive !== resolve(archive)) {
      throw new AdoptError(`${journal.storage} was adopted with --archive ${journal.archive}`);
    }
  }
  const writers = writerDeployments(kubectl, occNamespace);
  for (const component of WRITERS) {
    const recorded = journals[0].writers[component];
    if (JSON.stringify(images(writers[component])) !== JSON.stringify(recorded.images)) {
      throw new AdoptError(
        `openclaw-enterprise-${component} runs another image; revert is only possible ` +
          "before the upgrade starts the new release",
      );
    }
  }
  await stopWriters(kubectl, writers, { occNamespace, log, sleep, timeoutMs });
  for (const journal of journals) {
    const { tenant, storage, namespaceId: id } = journal;
    kubectl.patch("namespaces", tenant, undefined, "merge", {
      metadata: { labels: { [TENANT_LABEL]: id } },
    });
    kubectl.patch("namespaces", storage, undefined, "merge", {
      metadata: { labels: { [TENANT_LABEL]: null } },
    });
    journal.state = "reverting";
    writeJournal(kubectl, journal);
    for (const entry of journal.claims) {
      if (
        kubectl.get("persistentvolumeclaims", entry.name, tenant)?.spec?.volumeName !== entry.pv
      ) {
        await rebindClaim(kubectl, entry, storage, tenant, { sleep, timeoutMs });
        log(`${storage}/${entry.name} -> ${tenant} (${entry.pv})`);
      } else if (
        kubectl.get("persistentvolumes", entry.pv)?.spec.persistentVolumeReclaimPolicy !==
        entry.reclaimPolicy
      ) {
        // Apply may have set Retain before it stopped.
        kubectl.patch("persistentvolumes", entry.pv, undefined, "merge", {
          spec: { persistentVolumeReclaimPolicy: entry.reclaimPolicy },
        });
      }
      entry.moved = false;
      writeJournal(kubectl, journal);
    }
    for (const [name, uid] of Object.entries(journal.secrets)) {
      if (
        uid !== null &&
        uid !== "preexisting" &&
        kubectl.get("secrets", name, storage)?.metadata.uid === uid
      ) {
        kubectl.deleteExact(`/api/v1/namespaces/${storage}/secrets/${name}`, uid);
      }
    }
    if (journal.routesArchived) {
      if (journal.archive !== resolve(archive)) {
        throw new AdoptError(`${storage} was adopted with --archive ${journal.archive}`);
      }
      const routesFile = join(archiveDirectory(archive, id), "routes.json");
      for (const { resource, object } of JSON.parse(readFileSync(routesFile, "utf8"))) {
        if (kubectl.get(resource, object.metadata.name, tenant) === undefined) {
          kubectl.create(portable(object));
        }
      }
    }
    for (const [name, replicas] of Object.entries(journal.workloads)) {
      kubectl.patch("deployments.apps", name, tenant, "merge", { spec: { replicas } });
    }
    kubectl.patch("namespaces", storage, undefined, "merge", {
      metadata: { annotations: { [JOURNAL_ANNOTATION]: null } },
    });
    log(`${tenant} is the tenant namespace of ${id} again`);
  }
  const remaining = journalsOf(kubectl);
  if (remaining.length > 0) {
    // --namespace-id reverted only some tenants; the others stay adopted, so the old worker
    // must not run yet.
    await startOldApi(kubectl, journals[0].writers, { occNamespace, log, sleep, timeoutMs });
    log(
      `${remaining.map(({ storage }) => storage).join(", ")} stay adopted; the worker stays ` +
        "stopped until they are reverted or the upgrade runs",
    );
    return journals;
  }
  for (const component of WRITERS) {
    const { replicas } = journals[0].writers[component];
    kubectl.patch("deployments.apps", `openclaw-enterprise-${component}`, occNamespace, "merge", {
      spec: { replicas },
    });
  }
  log("OCC API and worker restored; the old release serves again");
  return journals;
}

/** Deletes each adopted tenant's old Harness namespace once the new release runs. */
export async function finalizeAdoption(
  kubectl,
  {
    occNamespace = "openclaw-system",
    namespaceIds = [],
    controllerUpgraded = false,
    log = () => {},
    sleep = defaultSleep,
    timeoutMs = 300_000,
  },
) {
  const writers = writerDeployments(kubectl, occNamespace);
  const finalized = [];
  for (const storage of kubectl.list("namespaces", undefined, STORAGE_LABEL)) {
    const journal = readJournal(kubectl, storage.metadata.name);
    if (
      journal === undefined ||
      (namespaceIds.length > 0 && !namespaceIds.includes(journal.namespaceId))
    ) {
      continue;
    }
    const { tenant, namespaceId: id } = journal;
    if (journal.state !== "applied" || labelsOf(storage)[TENANT_LABEL] !== id) {
      throw new AdoptError(
        `${storage.metadata.name} is not fully adopted (state ${journal.state}); run apply`,
      );
    }
    if (
      !controllerUpgraded &&
      WRITERS.some(
        (component) =>
          JSON.stringify(images(writers[component])) ===
          JSON.stringify(journal.writers[component].images),
      )
    ) {
      throw new AdoptError(
        "the controller still runs the images recorded at apply; upgrade it first (finalize " +
          "removes the way back), or add --controller-upgraded if apply recorded the new ones",
      );
    }
    const old = kubectl.get("namespaces", tenant);
    if (old !== undefined) {
      if (old.metadata.uid !== journal.tenantUid || labelsOf(old)[TENANT_LABEL] !== undefined) {
        throw new AdoptError(`${tenant} changed since apply; inspect it before deleting`);
      }
      const left = kubectl
        .list("persistentvolumeclaims", tenant)
        .map(({ metadata }) => metadata.name);
      if (left.length > 0) {
        throw new AdoptError(`${tenant} still holds claims ${left.join(", ")}`);
      }
      // Anything added since apply that adoption would not have dropped stops the delete.
      const foreign = [];
      for (const resource of kubectl.resources().filter(listedResource)) {
        for (const object of kubectl.list(resource, tenant)) {
          const name = object.metadata.name;
          const verdict = classify(resource, object, id, journal.dropResources);
          if (
            verdict === "refuse" ||
            (verdict === "copy-secret" && !(name in journal.secrets)) ||
            (verdict === "route" &&
              !journal.routes.some((route) => route.resource === resource && route.name === name))
          ) {
            foreign.push(`${resource}/${name}`);
          }
        }
      }
      if (foreign.length > 0) {
        throw new AdoptError(`${tenant} holds ${foreign.join(", ")}; move or delete them first`);
      }
      for (const entry of journal.claims) {
        if (
          kubectl.get("persistentvolumeclaims", entry.name, journal.storage)?.status?.phase !==
          "Bound"
        ) {
          throw new AdoptError(`${journal.storage}/${entry.name} is not bound`);
        }
      }
      if (!terminating(old)) {
        kubectl.deleteExact(`/api/v1/namespaces/${tenant}`, journal.tenantUid);
      }
      await waitFor(
        () => kubectl.get("namespaces", tenant) === undefined,
        `${tenant} to be deleted`,
        {
          sleep,
          timeoutMs,
        },
      );
    }
    kubectl.patch("namespaces", journal.storage, undefined, "merge", {
      metadata: { annotations: { [JOURNAL_ANNOTATION]: null } },
    });
    log(`${tenant} deleted; ${journal.storage} keeps tenant ${id}`);
    finalized.push(journal);
  }
  return finalized;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, namespaceIds: [], dropResources: [], kubectlArgs: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (["--yes", "--accept-oauth-reconnect", "--controller-upgraded"].includes(flag)) {
      options[flag.slice(2).replace(/-(\w)/gu, (_, c) => c.toUpperCase())] = true;
    } else if (flag === "--drop-resource" && value !== undefined) {
      options.dropResources.push(value);
      index += 1;
    } else if (["--context", "--kubeconfig"].includes(flag) && value !== undefined) {
      options.kubectlArgs.push(flag, value);
      index += 1;
    } else if (flag === "--namespace-id" && value !== undefined) {
      options.namespaceIds.push(value);
      index += 1;
    } else if (["--out", "--archive", "--occ-namespace"].includes(flag) && value !== undefined) {
      options[flag.slice(2).replace(/-(\w)/gu, (_, c) => c.toUpperCase())] = value;
      index += 1;
    } else {
      throw new AdoptError(`unknown argument ${flag}\n${usage}`);
    }
  }
  return options;
}

export async function main(argv, { run } = {}) {
  const options = parseArgs(argv);
  const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
  const kubectl = createKubectl(
    run ??
      ((args, input) =>
        spawnSync("kubectl", ["--request-timeout=30s", ...options.kubectlArgs, ...args], {
          input,
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 256 * 1024 * 1024,
        })),
    { warn: log },
  );
  const common = {
    occNamespace: options.occNamespace,
    namespaceIds: options.namespaceIds,
    dropResources: options.dropResources,
    acceptOauthReconnect: options.acceptOauthReconnect === true,
    log,
  };
  if (options.command === "plan") {
    const result = planAll(kubectl, common);
    for (const plan of result.plans) {
      log(
        `${plan.storage} <- ${plan.tenant ?? "?"} (${plan.namespaceId}): ${plan.claims.length} claims, ` +
          `${plan.secrets.length} Secrets, ${plan.routes.length} routes; running Agents: ` +
          `${plan.running.join(", ") || "none"}`,
      );
      log(`  back up these volumes first: ${plan.volumes.join(", ") || "none"}`);
      if (plan.reconnectAgents.length > 0) {
        log(`  OAuth sign-in needed again for: ${plan.reconnectAgents.join(", ")}`);
      }
      for (const reason of plan.refusals) {
        log(`  refused: ${reason}`);
      }
    }
    for (const { storage } of result.adopted) {
      log(`${storage}: adopted; finalize pending`);
    }
    if (options.out) {
      writePrivate(options.out, result);
    }
    return result.plans.some(({ refusals }) => refusals.length > 0) ? 2 : 0;
  }
  if (!options.yes || (options.command !== "finalize" && !options.archive)) {
    throw new AdoptError(usage);
  }
  if (options.command === "apply") {
    await applyAdoption(kubectl, { ...common, archive: options.archive });
    // Earlier runs may have adopted some tenants already; list every journal's Agents.
    const running = journalsOf(kubectl).flatMap(({ running }) => running);
    log(
      "adopted; the old API serves and the worker stays stopped. Upgrade the controller now, " +
        "then deploy the Agents that " +
        `were running: ${running.join(" ") || "none"}`,
    );
  } else if (options.command === "revert") {
    await revertAdoption(kubectl, { ...common, archive: options.archive });
  } else if (options.command === "finalize") {
    await finalizeAdoption(kubectl, {
      ...common,
      controllerUpgraded: options.controllerUpgraded === true,
    });
  } else {
    throw new AdoptError(usage);
  }
  return 0;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof AdoptError ? error.message : error);
      process.exit(1);
    },
  );
}
