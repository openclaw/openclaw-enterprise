import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { FixtureCommandError, type FixtureRun } from "./production-rehearsal-custody.ts";

type ObjectMetadata = {
  name: string;
  namespace: string;
  uid: string;
  resourceVersion: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  ownerReferences?: { kind: string; name: string; uid: string }[];
};
type KubernetesObject = {
  kind: string;
  metadata: ObjectMetadata;
  spec?: { selector?: Record<string, string> };
  status?: {
    phase?: string;
    conditions?: { type: string; status: string; lastTransitionTime?: string }[];
  };
  endpoints?: {
    conditions?: { ready?: boolean; serving?: boolean; terminating?: boolean };
    targetRef?: { kind: string; namespace: string; name: string; uid: string };
  }[];
};
type ReadObservation = {
  startedAt: string;
  finishedAt: string;
  startOffsetMs: number;
  finishOffsetMs: number;
  status: "ok" | "read-error" | "invalid-response";
  objects?: object[];
};

// Polling brackets observations; it cannot supply exact EndpointSlice transition
// times or prove Service reachability. The authenticated HTTP sampler stays separate.
export async function observeControllerEndpoints<T>(
  {
    run,
    kubeArgs,
    namespace,
    release,
    directory,
  }: {
    run: FixtureRun;
    kubeArgs: string[];
    namespace: string;
    release: string;
    directory: string;
  },
  upgrade: () => Promise<T>,
): Promise<T> {
  const serviceName = "openclaw-enterprise-api";
  const selector = {
    "app.kubernetes.io/name": "openclaw-enterprise",
    "app.kubernetes.io/instance": release,
    "app.kubernetes.io/component": "api",
  };
  const labelSelector = Object.entries(selector)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  const origin = performance.now();
  const intervalAfterSampleMs = 1_000;
  let boundServiceUID: string | null = null;
  let writeError: unknown;
  let cleanupError: unknown;
  const samples: {
    phase: "before" | "during" | "after";
    service: ReadObservation;
    slices: ReadObservation;
    pods: ReadObservation;
  }[] = [];
  const identity = (object: KubernetesObject, kind: string) => {
    assert.equal(object.kind, kind);
    const { metadata } = object;
    assert.equal(metadata.namespace, namespace);
    for (const value of [metadata.name, metadata.uid, metadata.resourceVersion]) {
      assert.ok(typeof value === "string" && value.length > 0);
    }
    return {
      name: metadata.name,
      uid: metadata.uid,
      resourceVersion: metadata.resourceVersion,
      deletionTimestamp: metadata.deletionTimestamp ?? null,
    };
  };
  const read = async (
    resource: string,
    selection: string[],
    project: (object: KubernetesObject) => object,
  ): Promise<ReadObservation> => {
    const startedAt = new Date().toISOString();
    const startOffsetMs = performance.now() - origin;
    let status: ReadObservation["status"] = "read-error";
    let objects: object[] | undefined;
    try {
      const output = await run(
        "kubectl",
        [
          ...kubeArgs,
          "--namespace",
          namespace,
          "--request-timeout=2s",
          "get",
          resource,
          ...selection,
          "-o",
          "json",
        ],
        { timeout: 3_000, protectedInput: true },
      );
      status = "invalid-response";
      const list = JSON.parse(output) as {
        apiVersion: string;
        kind: string;
        items: KubernetesObject[];
      };
      // kubectl get with selectors emits a v1 List even for discovery.k8s.io resources.
      assert.equal(list.apiVersion, "v1");
      assert.equal(list.kind, "List");
      assert.ok(Array.isArray(list.items));
      objects = list.items.map(project);
      status = "ok";
    } catch (error) {
      // Neither command errors nor full Pod JSON belong in the timing receipt.
      // A failed read is unknown, never an observed empty endpoint set.
      if (error instanceof FixtureCommandError && !error.settled) {
        cleanupError ??= error;
      }
    }
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      startOffsetMs,
      finishOffsetMs: performance.now() - origin,
      status,
      ...(objects === undefined ? {} : { objects }),
    };
  };
  const sample = async (
    phase: (typeof samples)[number]["phase"],
    succeeded: boolean | null = null,
  ) => {
    const [service, slices, pods] = await Promise.all([
      read("services", ["--field-selector", `metadata.name=${serviceName}`], (object) => {
        const metadata = identity(object, "Service");
        assert.equal(metadata.name, serviceName);
        assert.ok(isDeepStrictEqual(object.spec?.selector, selector));
        return { ...metadata, selector };
      }),
      read(
        "endpointslices.discovery.k8s.io",
        ["-l", `kubernetes.io/service-name=${serviceName}`],
        (object) => {
          const metadata = identity(object, "EndpointSlice");
          assert.equal(object.metadata.labels?.["kubernetes.io/service-name"], serviceName);
          assert.ok(Array.isArray(object.endpoints));
          return {
            ...metadata,
            serviceUIDs: (object.metadata.ownerReferences ?? [])
              .filter(({ kind, name }) => kind === "Service" && name === serviceName)
              .map(({ uid }) => uid),
            endpoints: object.endpoints.map(({ conditions, targetRef }) => ({
              ready: conditions?.ready ?? null,
              serving: conditions?.serving ?? null,
              terminating: conditions?.terminating ?? null,
              targetRef: targetRef
                ? {
                    kind: targetRef.kind,
                    namespace: targetRef.namespace,
                    name: targetRef.name,
                    uid: targetRef.uid,
                  }
                : null,
            })),
          };
        },
      ),
      read("pods", ["-l", labelSelector], (object) => {
        const metadata = identity(object, "Pod");
        assert.ok(
          Object.entries(selector).every(([key, value]) => object.metadata.labels?.[key] === value),
        );
        return {
          ...metadata,
          phase: object.status?.phase ?? null,
          conditions: (object.status?.conditions ?? [])
            .filter(({ type }) =>
              ["Ready", "ContainersReady", "PodScheduled", "Initialized"].includes(type),
            )
            .map(({ type, status, lastTransitionTime }) => ({
              type,
              status,
              lastTransitionTime: lastTransitionTime ?? null,
            })),
        };
      }),
    ]);
    if (phase === "before" && service.status === "ok" && service.objects?.length === 1) {
      boundServiceUID = (service.objects[0] as { uid: string }).uid;
    }
    samples.push({ phase, service, slices, pods });
    const path = join(directory, "controller-api-endpoints.json");
    try {
      await writeFile(
        `${path}.tmp`,
        JSON.stringify({
          schemaVersion: 1,
          namespace,
          release,
          serviceName,
          boundServiceUID,
          intervalAfterSampleMs,
          requestTimeoutMs: 2_000,
          commandTimeoutMs: 3_000,
          complete: succeeded !== null && !cleanupError,
          actionSucceeded: succeeded,
          samples,
        }) + "\n",
        { mode: 0o600 },
      );
      await rename(`${path}.tmp`, path);
    } catch (error) {
      writeError ??= error;
    }
  };
  await sample("before");
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  const stopped = new AbortController();
  let observing: Promise<void> | undefined;
  let result: { succeeded: true; value: T } | { succeeded: false; error: unknown };
  try {
    const upgrading = upgrade();
    observing = (async () => {
      while (!stopped.signal.aborted && !cleanupError) {
        await sample("during");
        await delay(intervalAfterSampleMs, undefined, { signal: stopped.signal }).catch(() => {});
      }
    })();
    result = { succeeded: true, value: await upgrading };
  } catch (error) {
    result = { succeeded: false, error };
  }
  stopped.abort();
  await observing;
  if (!cleanupError) {
    await sample("after", result.succeeded);
  }
  const observationErrors = [cleanupError, writeError].filter((error) => error !== undefined);
  if (!result.succeeded) {
    if (observationErrors.length) {
      throw new AggregateError(
        [result.error, ...observationErrors],
        "Upgrade and endpoint observation recording failed",
        { cause: result.error },
      );
    }
    throw result.error;
  }
  if (observationErrors.length === 1) {
    throw observationErrors[0];
  }
  if (observationErrors.length > 1) {
    throw new AggregateError(observationErrors, "Endpoint observations could not be completed");
  }
  return result.value;
}
