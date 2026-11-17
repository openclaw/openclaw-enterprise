import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createProvisioningApiFixture,
  createProvisioningContext,
  readProvisioningResponse,
} from "../helpers/kubernetes-provisioning-api.ts";
import { ConnectionTemplateResponse } from "../../packages/contracts/src/api/connection-templates.ts";
import {
  assertKubernetesFixtureAvailable,
  createDriver,
  createScopedController,
  deleteNamespaces,
  hash,
  kubectl,
  requiresKubernetesAndPostgres,
} from "../helpers/kubernetes-compute-real.mjs";

test(
  "connection templates pin a named Kubernetes Service and version target port changes",
  requiresKubernetesAndPostgres,
  async (context) => {
    await assertKubernetesFixtureAvailable();
    const installationId = `ins_${randomUUID()}`;
    const platformNamespace = `oce-platform-${hash(installationId)}`;
    const modelNamespace = `oce-model-${hash(installationId)}`;
    context.after(() => deleteNamespaces(platformNamespace, modelNamespace));
    await kubectl("create", "namespace", platformNamespace);
    await kubectl("create", "namespace", modelNamespace);
    const controller = await createScopedController(context, installationId, platformNamespace);
    const { driver } = await createDriver({ authentication: controller.authentication });
    const { request } = await createProvisioningApiFixture(
      createProvisioningContext(context),
      driver,
      controller.authentication,
      () => {},
    );

    const service = JSON.parse(
      await kubectl(
        "create",
        "service",
        "clusterip",
        "inference",
        "-n",
        modelNamespace,
        "--tcp=443:8443",
        "-o",
        "json",
      ),
    );
    const host = `inference.${modelNamespace}.svc.cluster.local`;
    const settings = {
      mode: "static_bearer",
      baseUrl: `https://${host}/v1`,
      protocol: "openai-responses",
      privatePeer: { kind: "kubernetes_service", name: "inference", namespace: modelNamespace },
    };
    const create = () =>
      request("POST", "/connection-templates", {
        displayName: "Private inference",
        ...settings,
      });
    // Knowing the DNS name cannot substitute for permission from the Service owner.
    const denied = await create();
    assert.equal(denied.status, 409, JSON.stringify(denied.body));
    await kubectl(
      "create",
      "role",
      "read-model",
      "-n",
      modelNamespace,
      "--verb=get",
      "--resource=services",
      "--resource-name=inference",
    );
    await kubectl(
      "create",
      "rolebinding",
      "read-model",
      "-n",
      modelNamespace,
      "--role=read-model",
      `--serviceaccount=${platformNamespace}:${controller.account}`,
    );
    const created = await create();
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const createdTemplate = readProvisioningResponse(ConnectionTemplateResponse, created).data;
    assert.equal(createdTemplate.current.mode, "static_bearer");
    if (createdTemplate.current.mode !== "static_bearer") {
      assert.fail("Expected a static-key template");
    }
    const peer = {
      ...settings.privatePeer,
      uid: service.metadata.uid,
      address: service.spec.clusterIP,
      podSelector: { app: "inference" },
      targetPort: 8443,
    };
    const templatePath = `/connection-templates/${createdTemplate.id}`;
    assert.deepEqual(createdTemplate.current.privatePeer, peer);
    assert.deepEqual(createdTemplate.current.destinations, [
      { host, port: 443, path: "/v1/responses", method: "POST" },
    ]);

    // The URL and Service identity stay the same, but saving a different backend
    // port requires a new template version. Reading the saved version must not re-resolve it.
    await kubectl(
      "patch",
      "service",
      "inference",
      "-n",
      modelNamespace,
      "--type=json",
      "--patch",
      JSON.stringify([{ op: "replace", path: "/spec/ports/0/targetPort", value: 9443 }]),
    );
    const saved = await request("GET", templatePath, undefined);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const savedTemplate = readProvisioningResponse(ConnectionTemplateResponse, saved).data;
    assert.equal(savedTemplate.current.mode, "static_bearer");
    assert.deepEqual(
      savedTemplate.current.mode === "static_bearer" && savedTemplate.current.privatePeer,
      peer,
    );
    const updated = await request("PATCH", templatePath, settings);
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const updatedTemplate = readProvisioningResponse(ConnectionTemplateResponse, updated).data;
    assert.equal(updatedTemplate.current.version, createdTemplate.current.version + 1);
    assert.deepEqual(
      updatedTemplate.current.mode === "static_bearer" && updatedTemplate.current.privatePeer,
      { ...peer, targetPort: 9443 },
    );
    const deleted = await request("DELETE", templatePath, undefined);
    assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  },
);
