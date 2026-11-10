import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

type FixtureObject = {
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    generation?: number;
    uid?: string;
    resourceVersion?: string;
    [field: string]: unknown;
  };
  status?: unknown;
  [field: string]: unknown;
};

type NamespacedName = { name: string; namespace?: string };
type SelectorRequest = { labelSelector?: string };
type WriteRequest = { body: FixtureObject };
type DeleteRequest = NamespacedName & { body: { preconditions: { uid?: string } } };

export function createEmbeddedReplacementKubernetesFixture(
  namespaceId: string,
  gatewayName: string,
) {
  const objects = new Map<string, FixtureObject>();
  const patches: Array<{ kind: string; name: string }> = [];
  const readyDeployments = new Set<string>();
  let replacementDeploymentPatched = false;

  const key = (kind: string, name: string) => `${kind}:${name}`;
  const save = (object: FixtureObject) =>
    objects.set(key(object.kind, object.metadata.name), structuredClone(object));
  const missing = (name: string) =>
    Object.assign(new Error(`${name} not found`), { statusCode: 404 });

  function readObject(kind: string, name: string) {
    const current = objects.get(key(kind, name));
    if (current === undefined) {
      throw missing(name);
    }
    return structuredClone(current);
  }

  function deleteObject(kind: string, { name, body }: DeleteRequest) {
    const objectKey = key(kind, name);
    assert.equal(objects.get(objectKey)?.metadata.uid, body.preconditions.uid);
    objects.delete(objectKey);
  }

  function recordPatch(body: FixtureObject) {
    patches.push({ kind: body.kind, name: body.metadata.name });
  }

  function patchObject(body: FixtureObject) {
    recordPatch(body);
    save(body);
  }

  const clients = {
    core: {
      async readNamespacedSecret({ name, namespace: target }: NamespacedName) {
        if (name === "occ-model-key") {
          return {
            apiVersion: "v1",
            kind: "Secret",
            metadata: { name, namespace: target, uid: "model-secret-uid" },
            data: { value: Buffer.from("fixture-model").toString("base64") },
          };
        }
        const observed = objects.get(key("Secret", name));
        if (!observed || observed.metadata.namespace !== target) {
          throw missing(name);
        }
        return structuredClone(observed);
      },
      async createNamespacedSecret({ body }: WriteRequest) {
        const value = {
          ...body,
          metadata: { ...body.metadata, uid: `${body.metadata.name}-uid`, resourceVersion: "1" },
        };
        save(value);
        return value;
      },
      async deleteNamespacedSecret(request: DeleteRequest) {
        deleteObject("Secret", request);
      },
      async deleteNamespacedConfigMap(request: DeleteRequest) {
        deleteObject("ConfigMap", request);
      },
      async listNamespacedPod() {
        return { items: [] };
      },
      async listNamespace({ labelSelector }: SelectorRequest) {
        assert.equal(labelSelector, `openclaw.dev/namespace=${namespaceId}`);
        return { items: [] };
      },
      async readNamespace({ name }: NamespacedName): Promise<FixtureObject | Error> {
        return structuredClone(objects.get(key("Namespace", name)) ?? missing(name));
      },
      async readNamespacedConfigMap({ name }: NamespacedName) {
        return readObject("ConfigMap", name);
      },
      async patchNamespacedConfigMap({ body }: WriteRequest) {
        patchObject(body);
      },
      async readNamespacedServiceAccount({ name }: NamespacedName) {
        return readObject("ServiceAccount", name);
      },
      async patchNamespacedServiceAccount({ body }: WriteRequest) {
        patchObject(body);
      },
      async readNamespacedService({ name }: NamespacedName) {
        return readObject("Service", name);
      },
      async patchNamespacedService({ body }: WriteRequest) {
        patchObject(body);
      },
      async readNamespacedPersistentVolumeClaim({ name }: NamespacedName) {
        return readObject("PersistentVolumeClaim", name);
      },
      async patchNamespacedPersistentVolumeClaim({ body }: WriteRequest) {
        patchObject(body);
      },
    },
    apps: {
      async readNamespacedDeployment({ name }: NamespacedName) {
        const observed = readObject("Deployment", name);
        // Readiness is an explicit transport observation, never inferred from a successful write.
        if (readyDeployments.has(name)) {
          observed.status = {
            observedGeneration: observed.metadata.generation,
            replicas: 1,
            updatedReplicas: 1,
            readyReplicas: 1,
          };
        }
        return observed;
      },
      async patchNamespacedDeployment({ body }: WriteRequest) {
        recordPatch(body);
        if (body.metadata.name === gatewayName) {
          replacementDeploymentPatched = true;
        }
        const previous = objects.get(key("Deployment", body.metadata.name));
        save({
          ...previous,
          ...body,
          metadata: {
            ...body.metadata,
            generation: previous?.metadata.generation ?? 1,
            uid: previous?.metadata.uid ?? `${body.metadata.name}-uid`,
          },
        });
      },
    },
    discovery: {
      async listNamespacedEndpointSlice() {
        assert.equal(
          replacementDeploymentPatched,
          true,
          "replacement preparation must not wait on the unready previous gateway",
        );
        return {
          items: [
            {
              metadata: {
                labels: { "kubernetes.io/service-name": gatewayName },
                ownerReferences: [
                  { kind: "Service", name: gatewayName, uid: `${gatewayName}-uid` },
                ],
              },
              endpoints: [{ conditions: { ready: true } }],
            },
          ],
        };
      },
    },
    networking: {
      async readNamespacedNetworkPolicy({ name }: NamespacedName) {
        return readObject("NetworkPolicy", name);
      },
      async patchNamespacedNetworkPolicy({ body }: WriteRequest) {
        patchObject(body);
      },
    },
    objects: {
      async read({ metadata }: Pick<FixtureObject, "metadata">) {
        return readObject("HTTPRoute", metadata.name);
      },
      async patch(body: FixtureObject) {
        recordPatch(body);
        save({ ...body, metadata: { ...body.metadata, uid: "route-uid" } });
      },
    },
  };

  return { objects, key, save, patches, readyDeployments, clients };
}
