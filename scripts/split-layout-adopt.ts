#!/usr/bin/env node
// Upgrades the split-layout tenants of a released single-cluster Installation in place: each
// `oce-gateways-<hash>` storage namespace becomes its tenant's namespace. Canonical Secrets,
// Configurations, service-account credentials and dedicated Gateway state stay where they are;
// the old Harness namespace's claims move by PersistentVolume rebind and its Agent Secrets are
// copied byte for byte. OCC's database is not written.
// See docs/guides/deploy/split-layout-upgrade.md.
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

type KubectlResult = { status: number | null; stdout: string; stderr: string };
type RunKubectl = (args: string[], input?: string) => KubectlResult;
type Kubectl = ReturnType<typeof createKubectl>;
type Log = (line: string) => void;
type WaitOptions = { sleep: (milliseconds: number) => Promise<void>; timeoutMs: number };
type RecoveryOptions = WaitOptions & { occNamespace: string; log: Log };
type ArchiveOptions = WaitOptions & { archive: string; log: Log };
type Selection = { namespaceIds?: string[] };
type PlanningOptions = Selection & { dropResources?: string[]; acceptOauthReconnect?: boolean };
type RevertOptions = Selection & Partial<RecoveryOptions> & { archive: string };
type ApplyOptions = RevertOptions & PlanningOptions;
type FinalizeOptions = Selection & Partial<RecoveryOptions> & { controllerUpgraded?: boolean };

type RecordValue = Record<string, unknown>;
type StringMap = Record<string, string>;
type KubernetesObject = RecordValue & {
  apiVersion?: string;
  metadata: RecordValue & {
    name: string;
    namespace?: string;
    uid?: string;
    labels?: StringMap;
    annotations?: StringMap;
    ownerReferences?: unknown[];
  };
};
type Writer = (typeof WRITERS)[number];
type WriterState = { replicas: number; images: string[] };
type Writers = Record<Writer, WriterState>;
type Route = { resource: string; name: string };
type ArchivedRoute = { resource: string; object: KubernetesObject };
type ClaimSpec = {
  accessModes: string[];
  resources: { requests: { storage: string } };
  volumeMode: string;
  storageClassName?: string;
};
type ClaimEntry = {
  name: string;
  pv: string;
  reclaimPolicy: string;
  labels: StringMap;
  annotations: StringMap;
  spec: ClaimSpec;
  moved: boolean;
};
type SecretCopy = null | "preexisting" | string;
type TenantPlan = {
  namespaceId: string;
  storage: string;
  storageUid: string | undefined;
  tenant: string | undefined;
  tenantUid: string | undefined;
  claims: string[];
  volumes: (string | undefined)[];
  secrets: string[];
  routes: Route[];
  dropped: Record<string, number>;
  running: string[];
  reconnectAgents: string[];
  refusals: string[];
};
type TenantLocation = { tenant: string; storage: string };
type Journal = TenantLocation & {
  format: typeof JOURNAL_FORMAT;
  state: "applying" | "applied" | "reverting";
  namespaceId: string;
  storageUid: string;
  tenantUid: string;
  writers: Writers;
  running: string[];
  workloads: Record<string, number>;
  archive?: string;
  dropResources?: string[];
  claims: ClaimEntry[];
  secrets: Record<string, SecretCopy>;
  routes: Route[];
  routesArchived: boolean;
};
type CliOptions = {
  command: string | undefined;
  namespaceIds: string[];
  dropResources: string[];
  kubectlArgs: string[];
  yes?: boolean;
  acceptOauthReconnect?: boolean;
  controllerUpgraded?: boolean;
  out?: string;
  archive?: string;
  occNamespace?: string;
};

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
const WRITERS = ["api", "worker"] as const;
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
const listedResource = (resource: string) =>
  resource === "pods" ||
  (!DERIVED_RESOURCES.has(resource) && !resource.endsWith(".metrics.k8s.io"));
const REQUIRED_GRANTS = Object.freeze([
  { role: "openclaw-tenant-worker", serviceAccount: "openclaw-enterprise-worker" },
  { role: "openclaw-tenant-api", serviceAccount: "openclaw-enterprise-api" },
  { role: "openclaw-tenant-configuration", serviceAccount: "openclaw-enterprise-api" },
]);

const usage = `Usage:
  node scripts/split-layout-adopt.ts plan [--out FILE]
  node scripts/split-layout-adopt.ts apply --archive DIR --yes
  node scripts/split-layout-adopt.ts revert --archive DIR --yes
  node scripts/split-layout-adopt.ts finalize --yes [--controller-upgraded]
Options: [--namespace-id ID]... [--occ-namespace NAME] [--context NAME] [--kubeconfig FILE]
  [--drop-resource RESOURCE]... [--accept-oauth-reconnect]
The script does not back up volumes: snapshot the PersistentVolumes plan lists first.`;

export class AdoptError extends Error {}

const sha256Hex = (value: string, length: number) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);
export const storageNamespaceName = (id: string) => `oce-gateways-${sha256Hex(id, 24)}`;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const labelsOf = (object: KubernetesObject | undefined) => object?.metadata.labels ?? {};
const managed = (object: KubernetesObject, id: string) =>
  labelsOf(object)[MANAGED_BY] === MANAGER && labelsOf(object)[TENANT_LABEL] === id;
const terminating = (object: KubernetesObject) =>
  object.metadata.deletionTimestamp !== undefined || statusOf(object)?.phase === "Terminating";

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Discovery also returns custom resources. Only the known kinds' fields are read below.
function specOf(object: KubernetesObject | undefined): RecordValue | undefined {
  return isRecord(object?.spec) ? object.spec : undefined;
}

function statusOf(object: KubernetesObject | undefined): RecordValue | undefined {
  return isRecord(object?.status) ? object.status : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function arrayOf<T>(value: unknown, check: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(check);
}

function recordOf<T>(
  value: unknown,
  check: (item: unknown) => item is T,
): value is Record<string, T> {
  return isRecord(value) && Object.values(value).every(check);
}

function optional<T>(value: unknown, check: (item: unknown) => item is T): value is T | undefined {
  return value === undefined || check(value);
}

function isObject(value: unknown): value is KubernetesObject {
  if (!isRecord(value) || !isRecord(value.metadata)) {
    return false;
  }
  const { metadata, apiVersion } = value;
  return (
    isString(metadata.name) &&
    optional(metadata.namespace, isString) &&
    optional(metadata.uid, isString) &&
    optional(metadata.labels, isStringMap) &&
    optional(metadata.annotations, isStringMap) &&
    (metadata.ownerReferences === undefined || Array.isArray(metadata.ownerReferences)) &&
    optional(apiVersion, isString)
  );
}

function objectUid(object: KubernetesObject): string {
  const { name, uid } = object.metadata;
  if (uid === undefined) {
    throw new AdoptError(`${name} did not report its UID`);
  }
  return uid;
}

/** A kubectl client over `run(args, input)`, which returns `{status, stdout, stderr}`. */
export function createKubectl(run: RunKubectl, { warn = () => {} }: { warn?: Log } = {}) {
  const call = (args: string[], input?: string) => {
    const result = run(args, input);
    if (result.status !== 0) {
      // kubectl errors name the object, never Secret data.
      throw new AdoptError(
        `kubectl ${args.slice(0, 3).join(" ")}: ${String(result.stderr).trim()}`,
      );
    }
    return result.stdout;
  };
  const json = (args: string[], input?: string): unknown => {
    const out = call(args, input);
    return out.trim() === "" ? undefined : JSON.parse(out);
  };
  const scope = (namespace: string | undefined) =>
    namespace === undefined ? [] : ["-n", namespace];
  return {
    get: (resource: string, name: string, namespace?: string) => {
      const object = json([
        "get",
        resource,
        name,
        ...scope(namespace),
        "--ignore-not-found",
        "-o",
        "json",
      ]);
      if (object === undefined || isObject(object)) {
        return object;
      }
      throw new AdoptError(`kubectl did not return a ${resource} object for ${name}`);
    },
    list: (resource: string, namespace?: string, selector?: string) => {
      const list = json([
        "get",
        resource,
        ...scope(namespace),
        ...(selector === undefined ? [] : ["-l", selector]),
        "-o",
        "json",
      ]);
      if (list == null || (isRecord(list) && list.items == null)) {
        return [];
      }
      if (isRecord(list) && arrayOf(list.items, isObject)) {
        return list.items;
      }
      throw new AdoptError(`kubectl did not return a ${resource} list`);
    },
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
    applyAs: (manager: string, object: unknown) =>
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
    create: (object: unknown) => json(["create", "-f", "-", "-o", "json"], JSON.stringify(object)),
    patch: (
      resource: string,
      name: string,
      namespace: string | undefined,
      type: "merge" | "json",
      patch: unknown,
    ) =>
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
    deleteExact: (path: string, uid: string) =>
      call(
        ["delete", "--raw", path, "-f", "-"],
        JSON.stringify({ kind: "DeleteOptions", apiVersion: "v1", preconditions: { uid } }),
      ),
  };
}

function objectPath(object: KubernetesObject, resource: string) {
  const { apiVersion, metadata } = object;
  if (apiVersion === undefined) {
    throw new AdoptError(`${resource}/${metadata.name} did not report its API version`);
  }
  const plural = resource.split(".")[0];
  const base = apiVersion.includes("/") ? `/apis/${apiVersion}` : "/api/v1";
  const scoped = metadata.namespace ? `/namespaces/${metadata.namespace}` : "";
  return `${base}${scoped}/${plural}/${metadata.name}`;
}

function mountedClaims(pods: KubernetesObject[]) {
  const claims = new Set<string>();
  for (const pod of pods) {
    const volumes = specOf(pod)?.volumes;
    if (volumes === undefined) {
      continue;
    }
    if (!arrayOf(volumes, isRecord)) {
      throw new AdoptError(`Pod ${pod.metadata.name} did not report its volumes`);
    }
    for (const volume of volumes) {
      const claim = volume.persistentVolumeClaim;
      if (claim === undefined) {
        continue;
      }
      if (!isRecord(claim) || !isString(claim.claimName)) {
        throw new AdoptError(`Pod ${pod.metadata.name} has an unreadable claim reference`);
      }
      claims.add(claim.claimName);
    }
  }
  return claims;
}

function hasGrant(
  bindings: KubernetesObject[],
  { role, serviceAccount }: (typeof REQUIRED_GRANTS)[number],
) {
  return bindings.some(({ roleRef, subjects }) => {
    if (!isRecord(roleRef) || roleRef.kind !== "ClusterRole" || !isString(roleRef.name)) {
      return false;
    }
    return (
      (roleRef.name === role || roleRef.name.endsWith(`-${role}`)) &&
      Array.isArray(subjects) &&
      subjects.some(
        (subject: unknown) =>
          isRecord(subject) && subject.kind === "ServiceAccount" && subject.name === serviceAccount,
      )
    );
  });
}

/** Sorts every object in the old Harness namespace into moved, dropped or refused. */
function classify(
  resource: string,
  object: KubernetesObject,
  id: string,
  dropResources: string[] = [],
) {
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
  if (ROUTE_RESOURCES.has(resource.split(".")[0] ?? "")) {
    return "route";
  }
  return "drop";
}

/** Reads one tenant's two namespaces and decides what adoption must do. Read-only. */
function planTenant(
  kubectl: Kubectl,
  storage: KubernetesObject,
  id: string,
  resources: string[],
  { dropResources = [], acceptOauthReconnect = false }: PlanningOptions = {},
): TenantPlan {
  const plan: TenantPlan = {
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
  const refuse = (reason: string) => plan.refusals.push(reason);
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
  const [tenant] = tenants;
  if (tenants.length !== 1 || tenant === undefined) {
    refuse(
      tenants.length === 0
        ? "no tenant namespace in this cluster (a two-cluster control target is not affected)"
        : `${tenants.length} namespaces claim the tenant`,
    );
    return plan;
  }
  const tenantName = tenant.metadata.name;
  plan.tenant = tenantName;
  plan.tenantUid = tenant.metadata.uid;
  if (tenant.metadata.annotations?.[LIFECYCLE_ANNOTATION] === "external") {
    refuse(`${plan.tenant} is an existing namespace; use scripts/split-layout-tenants.ts`);
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
    let objects: KubernetesObject[];
    try {
      objects = kubectl.list(resource, plan.tenant);
    } catch (error) {
      refuse(
        `cannot list ${resource} in ${plan.tenant}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    for (const object of objects) {
      const name = object.metadata.name;
      const verdict = classify(resource, object, id, dropResources);
      if (verdict === "move-claim") {
        plan.claims.push(name);
        plan.volumes.push(volumeName(object));
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
  const claimUids = new Set<string>();
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
      const uid = annotations[OAUTH_VOLUME_ANNOTATION];
      if (uid !== undefined && claimUids.has(uid)) {
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
  for (const namespace of [tenantName, plan.storage]) {
    for (const deployment of kubectl.list("deployments.apps", namespace, "openclaw.dev/agent")) {
      const agent = labelsOf(deployment)["openclaw.dev/agent"];
      if (agent !== undefined && replicasOf(deployment, 0) > 0) {
        plan.running.push(agent);
      }
    }
  }
  plan.running = [...new Set(plan.running)].sort();
  return plan;
}

function sameSecret(left: KubernetesObject | undefined, right: KubernetesObject | undefined) {
  if (left === undefined || right === undefined || left.type !== right.type) {
    return false;
  }
  const leftData = left.data ?? {};
  const rightData = right.data ?? {};
  if (!isStringMap(leftData) || !isStringMap(rightData)) {
    throw new AdoptError("kubectl returned unreadable Secret data");
  }
  return (
    JSON.stringify(Object.entries(leftData).sort()) ===
    JSON.stringify(Object.entries(rightData).sort())
  );
}

/** Plans every released split-layout tenant, or only the selected Namespace IDs. */
export function planAll(kubectl: Kubectl, { namespaceIds = [], ...options }: PlanningOptions = {}) {
  const resources = kubectl.resources();
  const plans: TenantPlan[] = [];
  const adopted: Pick<TenantPlan, "namespaceId" | "storage">[] = [];
  for (const storage of kubectl.list("namespaces", undefined, STORAGE_LABEL)) {
    const id = labelsOf(storage)[STORAGE_LABEL];
    if (id === undefined || (namespaceIds.length > 0 && !namespaceIds.includes(id))) {
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
    plans.push(planTenant(kubectl, storage, id, resources, options));
  }
  return { plans, adopted };
}

function isStringMap(value: unknown): value is StringMap {
  return recordOf(value, isString);
}

function isRoute(value: unknown): value is Route {
  return isRecord(value) && isString(value.resource) && isString(value.name);
}

function isArchivedRoute(value: unknown): value is ArchivedRoute {
  return isRecord(value) && isString(value.resource) && isObject(value.object);
}

function readRoutes(path: string): ArchivedRoute[] {
  const routes: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!arrayOf(routes, isArchivedRoute)) {
    throw new AdoptError(`${path} has unreadable archived routes`);
  }
  return routes;
}

function isClaimResources(value: unknown): value is ClaimSpec["resources"] {
  return isRecord(value) && isRecord(value.requests) && isString(value.requests.storage);
}

function isClaimSpec(value: unknown): value is ClaimSpec {
  return (
    isRecord(value) &&
    arrayOf(value.accessModes, isString) &&
    isClaimResources(value.resources) &&
    isString(value.volumeMode) &&
    optional(value.storageClassName, isString)
  );
}

function isClaimEntry(value: unknown): value is ClaimEntry {
  return (
    isRecord(value) &&
    isString(value.name) &&
    isString(value.pv) &&
    isString(value.reclaimPolicy) &&
    isStringMap(value.labels) &&
    isStringMap(value.annotations) &&
    isClaimSpec(value.spec) &&
    typeof value.moved === "boolean"
  );
}

function isWriterState(value: unknown): value is WriterState {
  return isRecord(value) && isNumber(value.replicas) && arrayOf(value.images, isString);
}

function isJournal(value: unknown): value is Journal {
  if (!isRecord(value) || !isRecord(value.writers)) {
    return false;
  }
  const { writers } = value;
  return (
    value.format === JOURNAL_FORMAT &&
    (value.state === "applying" || value.state === "applied" || value.state === "reverting") &&
    isString(value.namespaceId) &&
    isString(value.storage) &&
    isString(value.storageUid) &&
    isString(value.tenant) &&
    isString(value.tenantUid) &&
    WRITERS.every((component) => isWriterState(writers[component])) &&
    arrayOf(value.running, isString) &&
    recordOf(value.workloads, isNumber) &&
    optional(value.archive, isString) &&
    (value.dropResources === undefined || arrayOf(value.dropResources, isString)) &&
    arrayOf(value.claims, isClaimEntry) &&
    recordOf(value.secrets, (uid): uid is SecretCopy => uid === null || isString(uid)) &&
    arrayOf(value.routes, isRoute) &&
    typeof value.routesArchived === "boolean"
  );
}

function readJournal(kubectl: Kubectl, storage: string): Journal | undefined {
  const object = kubectl.get("namespaces", storage);
  const raw = object?.metadata.annotations?.[JOURNAL_ANNOTATION];
  if (raw === undefined) {
    return undefined;
  }
  const journal: unknown = JSON.parse(raw);
  if (!isJournal(journal)) {
    throw new AdoptError(`${storage} has an unreadable ${JOURNAL_ANNOTATION} annotation`);
  }
  return journal;
}

function existingJournal(kubectl: Kubectl, storage: string): Journal {
  const journal = readJournal(kubectl, storage);
  if (journal === undefined) {
    throw new AdoptError(`${storage} lost its ${JOURNAL_ANNOTATION} annotation`);
  }
  return journal;
}

function journalsOf(kubectl: Kubectl) {
  return kubectl
    .list("namespaces", undefined, STORAGE_LABEL)
    .filter((object) => object.metadata.annotations?.[JOURNAL_ANNOTATION] !== undefined)
    .map((object) => existingJournal(kubectl, object.metadata.name));
}

function writeJournal(kubectl: Kubectl, journal: Journal) {
  kubectl.patch("namespaces", journal.storage, undefined, "merge", {
    metadata: { annotations: { [JOURNAL_ANNOTATION]: JSON.stringify(journal) } },
  });
}

async function waitFor(
  check: () => boolean,
  description: string,
  {
    timeoutMs,
    intervalMs = 2_000,
    sleep,
    detail = () => "",
  }: WaitOptions & {
    intervalMs?: number;
    detail?: () => string;
  },
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

function writerDeployments(
  kubectl: Kubectl,
  occNamespace: string,
): Record<Writer, KubernetesObject> {
  const deploymentFor = (component: Writer) => {
    const name = `openclaw-enterprise-${component}`;
    const deployment = kubectl.get("deployments.apps", name, occNamespace);
    if (deployment === undefined) {
      throw new AdoptError(`${occNamespace}/${name} does not exist; set --occ-namespace`);
    }
    return deployment;
  };
  return { api: deploymentFor("api"), worker: deploymentFor("worker") };
}

function images(deployment: KubernetesObject): string[] {
  const template = specOf(deployment)?.template;
  const containers =
    isRecord(template) && isRecord(template.spec) ? template.spec.containers : undefined;
  if (containers === undefined) {
    return [];
  }
  if (!arrayOf(containers, isRecord)) {
    throw new AdoptError(`Deployment ${deployment.metadata.name} has unreadable containers`);
  }
  return containers
    .map(({ image }) => {
      if (!isString(image)) {
        throw new AdoptError(
          `Deployment ${deployment.metadata.name} did not report its container image`,
        );
      }
      return image;
    })
    .sort();
}

function replicasOf(deployment: KubernetesObject, fallback: number): number {
  const replicas = specOf(deployment)?.replicas;
  if (replicas == null) {
    return fallback;
  }
  if (!isNumber(replicas)) {
    throw new AdoptError(`Deployment ${deployment.metadata.name} has unreadable replicas`);
  }
  return replicas;
}

function observedReplicas(
  deployment: KubernetesObject | undefined,
  field: "replicas" | "availableReplicas",
): number {
  const replicas = statusOf(deployment)?.[field];
  if (replicas == null) {
    return 0;
  }
  if (!isNumber(replicas)) {
    throw new AdoptError(`Deployment ${deployment?.metadata.name} has unreadable ${field} status`);
  }
  return replicas;
}

function volumeName(claim: KubernetesObject | undefined): string | undefined {
  const name = specOf(claim)?.volumeName;
  return isString(name) ? name : undefined;
}

function volumeFor(kubectl: Kubectl, pv: string, claim: string) {
  const volume = kubectl.get("persistentvolumes", pv);
  if (volume === undefined) {
    throw new AdoptError(`PersistentVolume ${pv} of claim ${claim} is missing`);
  }
  return volume;
}

/**
 * Moves one claim's PersistentVolume from `from` to `to`. Every step reads live state first,
 * so a rerun after any failure continues where the last one stopped.
 */
async function rebindClaim(
  kubectl: Kubectl,
  entry: ClaimEntry,
  from: string,
  to: string,
  { sleep, timeoutMs }: WaitOptions,
) {
  const { name, pv } = entry;
  const readVolume = () => volumeFor(kubectl, pv, name);
  // Retain first: the claim delete below must never release the volume's data.
  if (specOf(readVolume())?.persistentVolumeReclaimPolicy !== "Retain") {
    kubectl.patch("persistentvolumes", pv, undefined, "merge", {
      spec: { persistentVolumeReclaimPolicy: "Retain" },
    });
    if (specOf(readVolume())?.persistentVolumeReclaimPolicy !== "Retain") {
      throw new AdoptError(`PersistentVolume ${pv} did not keep reclaim policy Retain`);
    }
  }
  const source = kubectl.get("persistentvolumeclaims", name, from);
  if (source !== undefined && volumeName(source) === pv) {
    if (mountedClaims(kubectl.list("pods", from)).has(name)) {
      throw new AdoptError(`a Pod in ${from} still mounts ${name}; stop it and run again`);
    }
    kubectl.deleteExact(
      `/api/v1/namespaces/${from}/persistentvolumeclaims/${name}`,
      objectUid(source),
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
  if (target !== undefined && volumeName(target) !== pv) {
    throw new AdoptError(`${to}/${name} already exists for another volume`);
  }
  const readReference = () => {
    const reference = specOf(readVolume())?.claimRef;
    if (reference !== undefined && !isRecord(reference)) {
      throw new AdoptError(`PersistentVolume ${pv} has an unreadable claim reference`);
    }
    return reference;
  };
  const claimRef = readReference();
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
    const observed = readReference();
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
        claim !== undefined &&
        statusOf(claim)?.phase === "Bound" &&
        readReference()?.uid === objectUid(claim)
      );
    },
    `claim ${to}/${name} to bind ${pv}`,
    { sleep, timeoutMs },
  );
  if (entry.reclaimPolicy !== "Retain") {
    kubectl.patch("persistentvolumes", pv, undefined, "merge", {
      spec: { persistentVolumeReclaimPolicy: entry.reclaimPolicy },
    });
    if (specOf(readVolume())?.persistentVolumeReclaimPolicy !== entry.reclaimPolicy) {
      throw new AdoptError(`PersistentVolume ${pv} did not restore ${entry.reclaimPolicy}`);
    }
  }
}

// Server-populated fields that must not be sent back on create.
function portable(object: KubernetesObject) {
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

function claimEntry(kubectl: Kubectl, plan: TenantLocation, name: string): ClaimEntry {
  const claim = kubectl.get("persistentvolumeclaims", name, plan.tenant);
  const pv = volumeName(claim);
  if (claim === undefined || statusOf(claim)?.phase !== "Bound" || !pv) {
    throw new AdoptError(`${plan.tenant}/${name} is not a bound claim`);
  }
  const volume = volumeFor(kubectl, pv, name);
  const reclaimPolicy = specOf(volume)?.persistentVolumeReclaimPolicy;
  if (!isString(reclaimPolicy)) {
    throw new AdoptError(`PersistentVolume ${pv} did not report its reclaim policy`);
  }
  const spec = specOf(claim) ?? {};
  const accessModes = spec.accessModes;
  const resources = spec.resources;
  const volumeMode = spec.volumeMode ?? "Filesystem";
  const storageClassName = spec.storageClassName;
  if (
    !arrayOf(accessModes, isString) ||
    !isClaimResources(resources) ||
    !isString(volumeMode) ||
    !optional(storageClassName, isString)
  ) {
    throw new AdoptError(`${plan.tenant}/${name} has an unreadable claim spec`);
  }
  return {
    name,
    pv,
    reclaimPolicy,
    labels: claim.metadata.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(claim.metadata.annotations ?? {}).filter(
        ([key]) => !CLAIM_ANNOTATION_PREFIXES.some((prefix) => key.startsWith(prefix)),
      ),
    ),
    // The live claim's class, not the release's manifest: a defaulted class must match the PV.
    spec: {
      accessModes,
      resources: { requests: { storage: resources.requests.storage } },
      volumeMode,
      ...(storageClassName === undefined ? {} : { storageClassName }),
    },
    moved: false,
  };
}

function writePrivate(path: string, value: unknown) {
  const partial = `${path}.partial`;
  writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(partial, path);
}

function archiveDirectory(archive: string, id: string) {
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  if ((statSync(archive).mode & 0o077) !== 0) {
    throw new AdoptError(`${archive} must be private (mode 0700)`);
  }
  const directory = join(archive, id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** Adopts every planned tenant, then restarts the old API and leaves the worker stopped. */
export async function applyAdoption(
  kubectl: Kubectl,
  {
    archive,
    occNamespace = "openclaw-system",
    namespaceIds = [],
    dropResources = [],
    acceptOauthReconnect = false,
    log = () => {},
    sleep = defaultSleep,
    timeoutMs = 300_000,
  }: ApplyOptions,
): Promise<Journal[]> {
  const { plans, adopted } = planAll(kubectl, {
    namespaceIds,
    dropResources,
    acceptOauthReconnect,
  });
  const started = adopted.map(({ storage }) => existingJournal(kubectl, storage));
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
  const [anyJournal] = journalsOf(kubectl);
  const writerState = (component: Writer): WriterState => ({
    replicas: replicasOf(writers[component], 1),
    images: images(writers[component]),
  });
  const recorded = anyJournal?.writers ?? {
    api: writerState("api"),
    worker: writerState("worker"),
  };
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
    const { tenant, tenantUid, storageUid } = plan;
    if (tenant === undefined || tenantUid === undefined || storageUid === undefined) {
      throw new AdoptError(`${plan.storage} did not report both namespace names and UIDs`);
    }
    const location = { tenant, storage: plan.storage };
    const journal: Journal = readJournal(kubectl, plan.storage) ?? {
      format: JOURNAL_FORMAT,
      state: "applying",
      namespaceId: plan.namespaceId,
      ...location,
      storageUid,
      tenantUid,
      writers: recorded,
      running: plan.running,
      workloads: {},
      archive: resolve(archive),
      dropResources,
      claims: plan.claims.map((name) => claimEntry(kubectl, location, name)),
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
async function startOldApi(
  kubectl: Kubectl,
  recorded: Writers,
  { occNamespace, log, sleep, timeoutMs }: RecoveryOptions,
) {
  const { replicas, images: recordedImages } = recorded.api;
  const name = "openclaw-enterprise-api";
  const live = kubectl.get("deployments.apps", name, occNamespace);
  if (replicas === 0) {
    return;
  }
  if (live === undefined) {
    throw new AdoptError(`${occNamespace}/${name} disappeared before restart`);
  }
  if (JSON.stringify(images(live)) !== JSON.stringify(recordedImages)) {
    return;
  }
  if (replicasOf(live, 1) !== replicas) {
    kubectl.patch("deployments.apps", name, occNamespace, "merge", { spec: { replicas } });
    log(`scaled ${occNamespace}/${name} back to ${replicas}`);
  }
  await waitFor(
    () =>
      observedReplicas(kubectl.get("deployments.apps", name, occNamespace), "availableReplicas") >=
      replicas,
    `${name} to serve`,
    { sleep, timeoutMs },
  );
}

async function stopWriters(
  kubectl: Kubectl,
  writers: Record<Writer, KubernetesObject>,
  { occNamespace, log, sleep, timeoutMs }: RecoveryOptions,
) {
  for (const component of WRITERS) {
    const name = `openclaw-enterprise-${component}`;
    if (replicasOf(writers[component], 1) !== 0) {
      kubectl.patch("deployments.apps", name, occNamespace, "merge", { spec: { replicas: 0 } });
      log(`scaled ${occNamespace}/${name} to 0`);
    }
    await waitFor(
      () => observedReplicas(kubectl.get("deployments.apps", name, occNamespace), "replicas") === 0,
      `${name} to stop`,
      { sleep, timeoutMs },
    );
  }
}

async function adoptTenant(
  kubectl: Kubectl,
  journal: Journal,
  { archive, log, sleep, timeoutMs }: ArchiveOptions,
) {
  const { tenant, storage, namespaceId: id } = journal;
  const save = () => writeJournal(kubectl, journal);
  // The plan ran while OCC still served. With OCC stopped nothing new appears, so take in
  // what appeared meanwhile; anything adoption does not handle stops here, before any change.
  for (const resource of kubectl.resources().filter(listedResource)) {
    const [kind = ""] = resource.split(".");
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
      journal.workloads[name] = replicasOf(deployment, 1);
      save();
    }
    if (replicasOf(deployment, 1) !== 0) {
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
    ...mountingPods().map((pod) => {
      const seconds = specOf(pod)?.terminationGracePeriodSeconds;
      return isNumber(seconds) ? seconds * 1_000 : 0;
    }),
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
        journal.secrets[name] = objectUid(existing);
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
    const created = kubectl.create(copy);
    if (!isObject(created)) {
      throw new AdoptError(`kubectl did not return the created Secret ${storage}/${name}`);
    }
    journal.secrets[name] = objectUid(created);
    save();
  }
  log(`${tenant}: ${Object.keys(journal.secrets).length} Agent Secrets copied to ${storage}`);
  // Archive the routes before deleting them: revert recreates them from this file.
  const routesFile = join(archiveDirectory(archive, id), "routes.json");
  if (!journal.routesArchived) {
    const routes: ArchivedRoute[] = [];
    for (const { resource, name } of journal.routes) {
      const object = kubectl.get(resource, name, tenant);
      if (object !== undefined) {
        routes.push({ resource, object });
      }
    }
    writePrivate(routesFile, routes);
    journal.routesArchived = true;
    save();
  }
  for (const { resource, object } of readRoutes(routesFile)) {
    const live = kubectl.get(resource, object.metadata.name, tenant);
    if (live !== undefined) {
      kubectl.deleteExact(objectPath(live, resource), objectUid(live));
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
  kubectl: Kubectl,
  {
    archive,
    occNamespace = "openclaw-system",
    namespaceIds = [],
    log = () => {},
    sleep = defaultSleep,
    timeoutMs = 300_000,
  }: RevertOptions,
): Promise<Journal[]> {
  const journals = journalsOf(kubectl).filter(
    ({ namespaceId }) => namespaceIds.length === 0 || namespaceIds.includes(namespaceId),
  );
  const [first] = journals;
  if (first === undefined) {
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
    const recorded = first.writers[component];
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
      if (volumeName(kubectl.get("persistentvolumeclaims", entry.name, tenant)) !== entry.pv) {
        await rebindClaim(kubectl, entry, storage, tenant, { sleep, timeoutMs });
        log(`${storage}/${entry.name} -> ${tenant} (${entry.pv})`);
      } else if (
        specOf(kubectl.get("persistentvolumes", entry.pv))?.persistentVolumeReclaimPolicy !==
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
      for (const { resource, object } of readRoutes(routesFile)) {
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
    await startOldApi(kubectl, first.writers, { occNamespace, log, sleep, timeoutMs });
    log(
      `${remaining.map(({ storage }) => storage).join(", ")} stay adopted; the worker stays ` +
        "stopped until they are reverted or the upgrade runs",
    );
    return journals;
  }
  for (const component of WRITERS) {
    const { replicas } = first.writers[component];
    kubectl.patch("deployments.apps", `openclaw-enterprise-${component}`, occNamespace, "merge", {
      spec: { replicas },
    });
  }
  log("OCC API and worker restored; the old release serves again");
  return journals;
}

/** Deletes each adopted tenant's old Harness namespace once the new release runs. */
export async function finalizeAdoption(
  kubectl: Kubectl,
  {
    occNamespace = "openclaw-system",
    namespaceIds = [],
    controllerUpgraded = false,
    log = () => {},
    sleep = defaultSleep,
    timeoutMs = 300_000,
  }: FinalizeOptions,
): Promise<Journal[]> {
  const writers = writerDeployments(kubectl, occNamespace);
  const finalized: Journal[] = [];
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
          statusOf(kubectl.get("persistentvolumeclaims", entry.name, journal.storage))?.phase !==
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

const booleanFlags = {
  "--yes": "yes",
  "--accept-oauth-reconnect": "acceptOauthReconnect",
  "--controller-upgraded": "controllerUpgraded",
} as const;
const valueFlags = {
  "--out": "out",
  "--archive": "archive",
  "--occ-namespace": "occNamespace",
} as const;

function hasFlag<T extends object>(flags: T, flag: string): flag is keyof T & string {
  return Object.hasOwn(flags, flag);
}

function parseArgs(argv: string[]): CliOptions {
  const [command, ...rest] = argv;
  const options: CliOptions = { command, namespaceIds: [], dropResources: [], kubectlArgs: [] };
  const flags = rest.entries();
  for (const [, flag] of flags) {
    if (hasFlag(booleanFlags, flag)) {
      options[booleanFlags[flag]] = true;
      continue;
    }
    const value = flags.next().value?.[1];
    if (value === undefined) {
      throw new AdoptError(`unknown argument ${flag}\n${usage}`);
    }
    if (flag === "--drop-resource") {
      options.dropResources.push(value);
    } else if (flag === "--context" || flag === "--kubeconfig") {
      options.kubectlArgs.push(flag, value);
    } else if (flag === "--namespace-id") {
      options.namespaceIds.push(value);
    } else if (hasFlag(valueFlags, flag)) {
      options[valueFlags[flag]] = value;
    } else {
      throw new AdoptError(`unknown argument ${flag}\n${usage}`);
    }
  }
  return options;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  const kubectl = createKubectl(
    (args, input) =>
      spawnSync("kubectl", ["--request-timeout=30s", ...options.kubectlArgs, ...args], {
        input,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 256 * 1024 * 1024,
      }),
    { warn: log },
  );
  const common = {
    ...(options.occNamespace === undefined ? {} : { occNamespace: options.occNamespace }),
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
  const { archive, command } = options;
  if (!options.yes) {
    throw new AdoptError(usage);
  }
  if (command === "apply" && archive) {
    await applyAdoption(kubectl, { ...common, archive });
    // Earlier runs may have adopted some tenants already; list every journal's Agents.
    const running = journalsOf(kubectl).flatMap(({ running }) => running);
    log(
      "adopted; the old API serves and the worker stays stopped. Upgrade the controller now, " +
        "then deploy the Agents that " +
        `were running: ${running.join(" ") || "none"}`,
    );
  } else if (command === "revert" && archive) {
    await revertAdoption(kubectl, { ...common, archive });
  } else if (command === "finalize") {
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
