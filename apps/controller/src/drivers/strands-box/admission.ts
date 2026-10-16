import { isDeepStrictEqual } from "node:util";
import { compareResourceQuantities } from "../compute/kubernetes/resource-quantities.ts";

type Json = Record<string, unknown>;
type Container = Json & { image: string; volumeMounts?: Json[] };
type Resources = Record<string, Record<string, string>>;
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function sameResources(desired: Resources = {}, live: Resources = {}): boolean {
  if (!isDeepStrictEqual(Object.keys(desired).sort(), Object.keys(live).sort())) {
    return false; // Includes resource claims or removal of the entire limits/requests map.
  }
  return Object.entries(desired).every(([kind, expected]) => {
    const actual = live[kind]!;
    return (
      (kind === "limits" || kind === "requests") &&
      isDeepStrictEqual(Object.keys(expected).sort(), Object.keys(actual).sort()) &&
      Object.entries(expected).every(
        ([name, quantity]) => compareResourceQuantities(quantity, actual[name]!) === 0,
      )
    );
  });
}

/** Only default fields of an existing probe; never synthesize a missing probe or discard a handler. */
function probe(value: Json) {
  const { httpGet, ...rest } = value as Json & { httpGet?: Json };
  return {
    timeoutSeconds: 1,
    periodSeconds: 10,
    successThreshold: 1,
    failureThreshold: 3,
    ...rest,
    ...(httpGet ? { httpGet: { scheme: "HTTP", ...httpGet } } : {}),
  };
}

function containerFields(container: Container) {
  const { image, volumeMounts, resources: _resources, ...fields } = container;
  for (const name of ["livenessProbe", "readinessProbe", "startupProbe"] as const) {
    if (fields[name]) {
      fields[name] = probe(fields[name] as Json);
    }
  }
  const tag = image.split("/").at(-1)!.split(":")[1];
  const pinned = image.includes("@") || (tag && tag !== "latest");
  return {
    image,
    imagePullPolicy: pinned ? "IfNotPresent" : "Always",
    terminationMessagePath: "/dev/termination-log",
    terminationMessagePolicy: "File",
    ...fields,
    volumeMounts: volumeMounts?.map((mount) => ({ readOnly: false, subPath: "", ...mount })),
  };
}

function sameContainers(desired: Container[] = [], live: Container[] = []): boolean {
  if (desired.length !== live.length) {
    return false;
  }
  return desired.every((expected, index) => {
    const actual = live[index]!;
    return (
      sameResources(
        expected.resources as Resources | undefined,
        actual.resources as Resources | undefined,
      ) && isDeepStrictEqual(containerFields(expected), containerFields(actual))
    );
  });
}

function volumeFields(volumes: (Json & { name: string })[]) {
  return volumes.map(({ name, ...sources }) => {
    const [type] = Object.keys(sources);
    // JSONB may reorder keys. Volumes, including injected ones, must remain in their admitted array order.
    if (type && Object.keys(sources).length === 1) {
      const value = sources[type] as Json;
      if (["projected", "configMap", "secret"].includes(type)) {
        sources[type] = { defaultMode: 420, ...value };
      }
      if (type === "persistentVolumeClaim") {
        sources[type] = { readOnly: false, ...value };
      }
    }
    return { name, ...sources };
  });
}

function defaultEvictionToleration(value: Json): boolean {
  return ["node.kubernetes.io/not-ready", "node.kubernetes.io/unreachable"].some((key) =>
    isDeepStrictEqual(value, {
      key,
      operator: "Exists",
      effect: "NoExecute",
      tolerationSeconds: 300,
    }),
  );
}

function podFields(spec: Json) {
  const {
    containers: _containers,
    initContainers: _init,
    volumes,
    serviceAccountName = "default",
    tolerations,
    ...fields
  } = spec;
  return {
    dnsPolicy: "ClusterFirst",
    restartPolicy: "Always",
    terminationGracePeriodSeconds: 30,
    schedulerName: "default-scheduler",
    priority: 0,
    preemptionPolicy: "PreemptLowerPriority",
    serviceAccount: serviceAccountName,
    serviceAccountName,
    ...fields,
    tolerations: ((tolerations ?? []) as Json[]).filter((t) => !defaultEvictionToleration(t)),
    volumes: volumeFields(volumes as (Json & { name: string })[]),
  };
}

/**
 * Compare the admitted Pod, not just familiar security fields. New executable, host, resource or
 * identity fields therefore fail closed. Normalize only the API defaults used by these managed Pods
 * and the scheduler's node assignment. This is a release/association guard, not pre-admission policy.
 */
export function exactStrandsPodAdmission(desired: Json, observed: Json): boolean {
  // At create time desired has optional undefined fields; the immutable admission seal has its JSON wire shape.
  const expected = wire(desired);
  const live = { ...observed };
  if (live.automountServiceAccountToken !== false || live.enableServiceLinks !== false) {
    return false;
  }
  if (expected.nodeName === undefined) {
    delete live.nodeName;
  }
  return (
    isDeepStrictEqual(podFields(expected), podFields(live)) &&
    sameContainers(expected.containers as Container[], live.containers as Container[]) &&
    sameContainers(
      expected.initContainers as Container[] | undefined,
      live.initContainers as Container[] | undefined,
    )
  );
}
