import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModelProbeCertificates } from "./runtime-model-probe-certificates.mjs";

// Shared by the launcher case and FirstAgentSmoke; callers own resources,
// subprocess policy, image selection, and cleanup.
export async function createModelProviderFiles({ directory, caName, run }) {
  await mkdir(directory, { recursive: true });
  const file = (name) => join(directory, name);
  await createModelProbeCertificates({ directory, caName, run });
  await copyFile(
    new URL("../fixtures/runtime-model-probe-endpoint.mjs", import.meta.url),
    file("endpoint.mjs"),
  );
  await chmod(directory, 0o755);
  for (const name of ["ca.pem", "cert.pem", "key.pem", "endpoint.mjs"]) {
    await chmod(file(name), 0o644);
  }
}

export async function writeModelProviderTrust({ context, caPath }) {
  await mkdir(context, { recursive: true });
  await copyFile(caPath, join(context, "smoke-ca.crt"));
  await writeFile(
    join(context, "Dockerfile"),
    [
      "ARG RUNTIME_IMAGE",
      "FROM ${RUNTIME_IMAGE}",
      "USER root",
      "COPY smoke-ca.crt /usr/local/share/ca-certificates/oce-first-agent-smoke.crt",
      "RUN update-ca-certificates",
      "ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
      "ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/oce-first-agent-smoke.crt",
      "USER node",
      "",
    ].join("\n"),
  );
}

export async function configureModelProviderDNS({
  kubectl,
  waitFor,
  modelAddress,
  platformNamespace,
  serverFile,
}) {
  // k3s CoreDNS imports *.server files from the optional coredns-custom ConfigMap.
  const configMap = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "coredns-custom", namespace: "kube-system" },
    data: {
      [serverFile]: `api.openai.com:53 {\n    hosts {\n        ${modelAddress} api.openai.com\n    }\n}\n`,
    },
  };
  await kubectl(["apply", "-f", "-"], { input: JSON.stringify(configMap) });
  await kubectl(["-n", "kube-system", "rollout", "restart", "deployment/coredns"]);
  await kubectl(["-n", "kube-system", "rollout", "status", "deployment/coredns", "--timeout=120s"]);
  // The Local Setup API proxy resolves the API Service for every connection,
  // so API calls made while the old resolver Pod terminates fail after a DNS
  // timeout. Wait until only the new Pod remains and, from the proxy Pod, the
  // API Service resolves and api.openai.com resolves to the stand-in provider.
  const lookup = `const dns = require("node:dns").promises;
const address = (name) => dns.lookup(name, { family: 4 }).then((r) => r.address, () => null);
Promise.all([address("api.openai.com"), address("openclaw-enterprise-api")]).then(([provider, api]) =>
  process.stdout.write(JSON.stringify({ provider, api })));`;
  await waitFor(
    "cluster DNS to answer through the restarted resolver",
    async () => {
      const { stdout } = await kubectl([
        "-n",
        "kube-system",
        "get",
        "pods",
        "-l",
        "k8s-app=kube-dns",
        "-o",
        "json",
      ]);
      const pods = JSON.parse(stdout).items;
      if (pods.length !== 1 || pods[0].metadata.deletionTimestamp) {
        return { done: false, state: pods.map((pod) => pod.metadata.name) };
      }
      try {
        const result = JSON.parse(
          (
            await kubectl(
              [
                "-n",
                platformNamespace,
                "exec",
                "deployment/occ-development-api-proxy",
                "--",
                "node",
                "-e",
                lookup,
              ],
              { timeout: 30_000 },
            )
          ).stdout,
        );
        return { done: result.provider === modelAddress && Boolean(result.api), state: result };
      } catch (error) {
        return { done: false, state: error.message.slice(0, 300) };
      }
    },
    120_000,
  );
}
