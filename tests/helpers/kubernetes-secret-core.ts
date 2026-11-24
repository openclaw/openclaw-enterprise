import assert from "node:assert/strict";
import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import {
  FakeNamespaceCoreV1Api,
  injectedFailure,
  stallUntilAborted,
} from "./kubernetes-core-api.ts";

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type CoreApi = InstanceType<KubernetesSdk["CoreV1Api"]>;
type CreateRequest = Parameters<CoreApi["createNamespacedSecret"]>[0];
type ReplaceRequest = Parameters<CoreApi["replaceNamespacedSecret"]>[0];
type ReadRequest = Parameters<CoreApi["readNamespacedSecret"]>[0];
type DeleteRequest = Parameters<CoreApi["deleteNamespacedSecret"]>[0];
type SecretRecord = CreateRequest["body"] & {
  metadata: NonNullable<CreateRequest["body"]["metadata"]>;
  data: Record<string, string>;
};
type Failure = Parameters<typeof injectedFailure>[0];

// Model the API's write-only stringData conversion without retaining plaintext input fields.
function storedSecret(
  body: CreateRequest["body"],
  uid: string,
  resourceVersion: string,
): SecretRecord {
  const { stringData, ...fields } = structuredClone(body);
  assert.ok(stringData, "Secret fixture writes require stringData");
  return {
    ...fields,
    metadata: { ...body.metadata, uid, resourceVersion },
    data: Object.fromEntries(
      Object.entries(stringData).map(([key, value]) => [
        key,
        Buffer.from(value, "utf8").toString("base64"),
      ]),
    ),
  };
}

export class FakeSecretCoreV1Api
  extends FakeNamespaceCoreV1Api
  implements
    Pick<
      CoreApi,
      | "createNamespacedSecret"
      | "readNamespacedSecret"
      | "replaceNamespacedSecret"
      | "deleteNamespacedSecret"
    >
{
  secretUid: string | undefined;
  secrets = new Map<string, SecretRecord>();
  reads = 0;
  deletes: Array<NonNullable<DeleteRequest["body"]>["preconditions"]> = [];
  readSecretFailureCodes: Failure[] = [];
  // Holds each Secret read until its request is aborted.
  readSecretStalls = false;
  // Failures queued per method, each thrown before the call takes effect.
  failureCodes: Record<keyof FakeSecretCoreV1Api["calls"], Failure[]> = {
    listNamespace: [],
    createNamespacedSecret: [],
    replaceNamespacedSecret: [],
    deleteNamespacedSecret: [],
  };
  // Failures thrown after a create took effect, as when its response is lost.
  createAppliedFailureCodes: Failure[] = [];
  // Rewrites a Secret the create stored, before a later failure is thrown.
  createAppliedMutation: ((secret: SecretRecord) => void) | undefined;
  calls = {
    listNamespace: 0,
    createNamespacedSecret: 0,
    replaceNamespacedSecret: 0,
    deleteNamespacedSecret: 0,
  };

  called(method: keyof FakeSecretCoreV1Api["calls"]) {
    this.calls[method] += 1;
    const failureCode = this.failureCodes[method].shift();
    if (failureCode !== undefined) {
      throw injectedFailure(failureCode, method);
    }
  }

  override async listNamespace(request: Parameters<FakeNamespaceCoreV1Api["listNamespace"]>[0]) {
    this.called("listNamespace");
    return super.listNamespace(request);
  }

  async createNamespacedSecret({ namespace, body }: CreateRequest) {
    this.called("createNamespacedSecret");
    assert.ok(body.metadata);
    const key = `${namespace}/${body.metadata.name}`;
    if (this.secrets.has(key)) {
      throw Object.assign(new Error("conflict"), { code: 409 });
    }
    const stored = storedSecret(body, this.secretUid ?? `uid-${this.secrets.size + 1}`, "1");
    this.secrets.set(key, stored);
    const appliedFailure = this.createAppliedFailureCodes.shift();
    if (appliedFailure !== undefined) {
      this.createAppliedMutation?.(stored);
      throw injectedFailure(appliedFailure, "createNamespacedSecret");
    }
    return structuredClone(stored);
  }

  async readNamespacedSecret({ namespace, name }: ReadRequest) {
    this.reads += 1;
    const failureCode = this.readSecretFailureCodes.shift();
    if (failureCode !== undefined) {
      throw injectedFailure(failureCode, "read");
    }
    if (this.readSecretStalls) {
      await stallUntilAborted("readNamespacedSecret");
    }
    const secret = this.secrets.get(`${namespace}/${name}`);
    if (secret === undefined) {
      throw Object.assign(new Error("missing secret"), { code: 404 });
    }
    return structuredClone(secret);
  }

  async replaceNamespacedSecret({ namespace, name, body }: ReplaceRequest) {
    this.called("replaceNamespacedSecret");
    const key = `${namespace}/${name}`;
    const existing = this.secrets.get(key);
    if (existing === undefined) {
      throw Object.assign(new Error("missing secret"), { code: 404 });
    }
    assert.ok(body.metadata);
    if (body.metadata.resourceVersion !== existing.metadata.resourceVersion) {
      throw Object.assign(new Error("resource version conflict"), { code: 409 });
    }
    assert.ok(
      typeof existing.metadata.uid === "string",
      "A stored Secret must have a UID before replacement",
    );
    const stored = storedSecret(
      body,
      existing.metadata.uid,
      String(Number(existing.metadata.resourceVersion) + 1),
    );
    this.secrets.set(key, stored);
    return structuredClone(stored);
  }

  async deleteNamespacedSecret({ namespace, name, body }: DeleteRequest) {
    this.called("deleteNamespacedSecret");
    const key = `${namespace}/${name}`;
    const existing = this.secrets.get(key);
    if (existing === undefined) {
      throw Object.assign(new Error("missing secret"), { code: 404 });
    }
    const preconditions = body?.preconditions;
    this.deletes.push(structuredClone(preconditions));
    if (
      preconditions?.uid !== existing.metadata.uid ||
      preconditions?.resourceVersion !== existing.metadata.resourceVersion
    ) {
      throw Object.assign(new Error("delete precondition conflict"), { code: 409 });
    }
    this.secrets.delete(key);
    return {};
  }
}

/** Uses the Kubernetes driver for Installation-private credentials, substituting only its API transport. */
export function useInstallationSecretDriver(controller: OpenClawController) {
  const core = new FakeSecretCoreV1Api();
  const driver = new KubernetesSecretDriver(
    { authentication: { mode: "inCluster" } },
    { id: "template-kubernetes", installationSecretNamespace: "oce-installation-secrets" },
  );
  Object.assign(driver, { client: Promise.resolve(core) });
  controller.registerDriver(driver);
  controller.selectDriver("secret", driver.id);
  return { core, driver };
}
