import assert from "node:assert/strict";
import { isIPv4 } from "node:net";

export function providerDns({ system, suffix, custody, localCluster, kubectl, kubeArgs, run }) {
  let owned;
  const namespace = "kube-system";
  const name = "coredns-custom";
  const path = "/api/v1/namespaces/kube-system/configmaps/coredns-custom";
  const core = (...args) => kubectl("-n", namespace, ...args);
  const get = async (item) => JSON.parse(await core("get", item, "-o", "json"));
  async function verifyOwner() {
    await localCluster.assertCluster();
    const cm = await get("configmap/" + name);
    assert(owned && cm.metadata.uid === owned.uid && cm.metadata.resourceVersion === owned.rv);
    assert.deepEqual(cm.data, owned.data);
  }
  return {
    async bindProviderDns({ hostname, serviceName, namespace: ns, serviceUid, clusterIP }) {
      assert(
        !owned &&
          ns === system &&
          hostname === "idp.signin-rehearsal.test" &&
          serviceName === "signin-rehearsal-oidc" &&
          isIPv4(clusterIP),
      );
      await localCluster.assertCluster();
      const service = JSON.parse(
        await kubectl("-n", system, "get", "svc/" + serviceName, "-o", "json"),
      );
      custody.assertUID("service/" + serviceName, serviceUid);
      assert(
        service.metadata.uid === serviceUid &&
          service.spec.clusterIP === clusterIP &&
          service.spec.type === "ClusterIP",
      );
      const deployment = await get("deployment/coredns");
      const source = await get("configmap/coredns");
      const spec = deployment.spec.template.spec;
      const mount = spec.volumes.find((v) => v.configMap?.name === name);
      assert(
        mount &&
          spec.containers.some(
            (c) =>
              c.name === "coredns" &&
              c.volumeMounts.some(
                (m) => m.name === mount.name && m.mountPath === "/etc/coredns/custom",
              ),
          ),
      );
      assert(/^\s*import\s+\/etc\/coredns\/custom\/\*\.override\s*$/m.test(source.data.Corefile));
      assert.equal(
        (await core("get", "configmap/" + name, "--ignore-not-found", "-o", "name")).trim(),
        "",
      );
      const data = {
        "signin.override": `rewrite name exact ${hostname} ${serviceName}.${system}.svc.cluster.local\n`,
      };
      // Server-side create is exclusive, even if another object races the absence read.
      const result = JSON.parse(
        await run("kubectl", [...kubeArgs, "-n", namespace, "create", "-f", "-", "-o", "json"], {
          input: JSON.stringify({
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: { name, namespace, labels: { "oce-test": suffix } },
            immutable: true,
            data,
          }),
          protectedInput: true,
        }),
      );
      owned = { uid: result.metadata.uid, rv: result.metadata.resourceVersion, data };
      await verifyOwner();
    },
    async assertBound() {
      await verifyOwner();
    },
    async close() {
      if (!owned) {
        return;
      }
      await verifyOwner();
      await run("kubectl", [...kubeArgs, "delete", "--raw=" + path, "-f", "-"], {
        input: JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: owned.uid, resourceVersion: owned.rv },
        }),
      });
      owned = undefined;
    },
  };
}
