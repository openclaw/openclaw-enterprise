import assert from "node:assert/strict";
import { isIPv4 } from "node:net";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  protectedJSON,
  type FixtureRun,
  type LocalRehearsalCluster,
  type RehearsalCustody,
} from "../production-rehearsal-custody.ts";

const versionedConfigMap = Type.Object({
  metadata: Type.Object({ uid: Type.String(), resourceVersion: Type.String() }),
  data: Type.Optional(Type.Record(Type.String(), Type.String())),
});
const providerService = Type.Object({
  metadata: Type.Object({ uid: Type.String() }),
  spec: Type.Object({ clusterIP: Type.String(), type: Type.String() }),
});
const dnsDeployment = Type.Object({
  spec: Type.Object({
    template: Type.Object({
      spec: Type.Object({
        volumes: Type.Array(
          Type.Object({
            name: Type.String(),
            configMap: Type.Optional(Type.Object({ name: Type.String() })),
          }),
        ),
        containers: Type.Array(
          Type.Object({
            name: Type.String(),
            volumeMounts: Type.Optional(
              Type.Array(Type.Object({ name: Type.String(), mountPath: Type.String() })),
            ),
          }),
        ),
      }),
    }),
  }),
});
const corefileConfigMap = Type.Object({ data: Type.Object({ Corefile: Type.String() }) });

export function providerDns({
  system,
  suffix,
  custody,
  localCluster,
  kubectl,
  kubeArgs,
  run,
}: {
  system: string;
  suffix: string;
  custody: Pick<RehearsalCustody, "assertUID">;
  localCluster: Pick<LocalRehearsalCluster, "assertCluster">;
  kubectl: (...args: string[]) => Promise<string>;
  kubeArgs: readonly string[];
  run: FixtureRun;
}) {
  let owned: { uid: string; rv: string; data: Record<string, string> } | undefined;
  const namespace = "kube-system";
  const name = "coredns-custom";
  const path = "/api/v1/namespaces/kube-system/configmaps/coredns-custom";
  const core = (...args: string[]) => kubectl("-n", namespace, ...args);
  const get = async (item: string) => protectedJSON<unknown>(await core("get", item, "-o", "json"));
  async function verifyOwner() {
    await localCluster.assertCluster();
    const cm = await get("configmap/" + name);
    assert(Check(versionedConfigMap, cm), "invalid CoreDNS override");
    assert(owned && cm.metadata.uid === owned.uid && cm.metadata.resourceVersion === owned.rv);
    assert.deepEqual(cm.data, owned.data);
  }
  return {
    async bindProviderDns({
      hostname,
      serviceName,
      namespace: ns,
      serviceUid,
      clusterIP,
    }: {
      hostname: string;
      serviceName: string;
      namespace: string;
      serviceUid: string;
      clusterIP: string;
    }) {
      assert(
        !owned &&
          ns === system &&
          hostname === "idp.signin-rehearsal.test" &&
          serviceName === "signin-rehearsal-oidc" &&
          isIPv4(clusterIP),
      );
      await localCluster.assertCluster();
      const service = protectedJSON<unknown>(
        await kubectl("-n", system, "get", "svc/" + serviceName, "-o", "json"),
      );
      assert(Check(providerService, service), "invalid provider Service");
      custody.assertUID("service/" + serviceName, serviceUid);
      assert(
        service.metadata.uid === serviceUid &&
          service.spec.clusterIP === clusterIP &&
          service.spec.type === "ClusterIP",
      );
      const deployment = await get("deployment/coredns");
      const source = await get("configmap/coredns");
      assert(Check(dnsDeployment, deployment), "invalid CoreDNS Deployment");
      assert(Check(corefileConfigMap, source), "invalid CoreDNS configuration");
      const spec = deployment.spec.template.spec;
      const mount = spec.volumes.find((v) => v.configMap?.name === name);
      assert(
        mount &&
          spec.containers.some(
            (c) =>
              c.name === "coredns" &&
              c.volumeMounts?.some(
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
      const result = protectedJSON<unknown>(
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
      assert(Check(versionedConfigMap, result), "invalid CoreDNS create response");
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
