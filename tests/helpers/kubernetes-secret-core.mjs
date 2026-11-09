import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import {
  FakeNamespaceCoreV1Api,
  injectedFailure,
  stallUntilAborted,
} from "./kubernetes-core-api.mjs";

export class FakeSecretCoreV1Api extends FakeNamespaceCoreV1Api {
  secretUid = undefined;
  secrets = new Map();
  reads = 0;
  deletes = [];
  readSecretFailureCodes = [];
  // Holds each Secret read until its request is aborted.
  readSecretStalls = false;
  // Failures queued per method, each thrown before the call takes effect.
  failureCodes = {
    listNamespace: [],
    createNamespacedSecret: [],
    replaceNamespacedSecret: [],
    deleteNamespacedSecret: /** @type {number[]} */ ([]),
  };
  // Failures thrown after a create took effect, as when its response is lost.
  createAppliedFailureCodes = [];
  // Rewrites a Secret the create stored, before a later failure is thrown.
  createAppliedMutation = undefined;
  calls = {
    listNamespace: 0,
    createNamespacedSecret: 0,
    replaceNamespacedSecret: 0,
    deleteNamespacedSecret: 0,
  };

  called(method) {
    this.calls[method] += 1;
    const failureCode = this.failureCodes[method].shift();
    if (failureCode !== undefined) {
      throw injectedFailure(failureCode, method);
    }
  }

  async listNamespace(request) {
    this.called("listNamespace");
    return super.listNamespace(request);
  }

  async createNamespacedSecret({ namespace, body }) {
    this.called("createNamespacedSecret");
    const key = `${namespace}/${body.metadata.name}`;
    if (this.secrets.has(key)) {
      throw Object.assign(new Error("conflict"), { code: 409 });
    }
    const stored = {
      ...structuredClone(body),
      metadata: {
        ...body.metadata,
        uid: this.secretUid ?? `uid-${this.secrets.size + 1}`,
        resourceVersion: "1",
      },
      data: Object.fromEntries(
        Object.entries(body.stringData).map(([name, value]) => [
          name,
          Buffer.from(value, "utf8").toString("base64"),
        ]),
      ),
    };
    delete stored.stringData;
    this.secrets.set(key, stored);
    const appliedFailure = this.createAppliedFailureCodes.shift();
    if (appliedFailure !== undefined) {
      this.createAppliedMutation?.(stored);
      throw injectedFailure(appliedFailure, "createNamespacedSecret");
    }
    return structuredClone(stored);
  }

  async readNamespacedSecret({ namespace, name }) {
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

  async replaceNamespacedSecret({ namespace, name, body }) {
    this.called("replaceNamespacedSecret");
    const key = `${namespace}/${name}`;
    const existing = this.secrets.get(key);
    if (existing === undefined) {
      throw Object.assign(new Error("missing secret"), { code: 404 });
    }
    if (body.metadata.resourceVersion !== existing.metadata.resourceVersion) {
      throw Object.assign(new Error("resource version conflict"), { code: 409 });
    }
    const stored = {
      ...structuredClone(body),
      metadata: {
        ...body.metadata,
        uid: existing.metadata.uid,
        resourceVersion: String(Number(existing.metadata.resourceVersion) + 1),
      },
      data: Object.fromEntries(
        Object.entries(body.stringData).map(([dataKey, value]) => [
          dataKey,
          Buffer.from(value, "utf8").toString("base64"),
        ]),
      ),
    };
    delete stored.stringData;
    this.secrets.set(key, stored);
    return structuredClone(stored);
  }

  async deleteNamespacedSecret({ namespace, name, body }) {
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
export function useInstallationSecretDriver(controller) {
  const core = new FakeSecretCoreV1Api();
  const driver = new KubernetesSecretDriver(
    { authentication: { mode: "inCluster" } },
    { id: "template-kubernetes", installationSecretNamespace: "oce-installation-secrets" },
  );
  driver.client = Promise.resolve(core);
  controller.registerDriver(driver);
  controller.selectDriver("secret", driver.id);
  return { core, driver };
}
