// @ts-check

import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { asRecord } from "../../packages/utils/src/objects.ts";
import { createModelProbeCertificates } from "./runtime-model-probe-certificates.mjs";

// Shared by the launcher case and FirstAgentSmoke; callers own resources,
// subprocess policy, image selection, and cleanup.
/**
 * @param {{directory: string, caName: string, run: (command: string, args: string[]) => Promise<unknown>}} options
 */
export async function createModelProviderFiles({ directory, caName, run }) {
  await mkdir(directory, { recursive: true });
  /** @param {string} name */
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

/** @param {{context: string, caPath: string}} options */
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

/**
 * @param {{
 *   kubectl: (args: string[], options?: {input?: string, timeout?: number}) => Promise<{stdout: string}>,
 *   waitFor: (description: string, operation: () => Promise<{done: boolean, state: unknown}>,
 *     timeout: number) => Promise<unknown>,
 *   modelAddress: string,
 *   platformNamespace: string,
 *   serverFile: string,
 * }} options
 */
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
      const items = asRecord(JSON.parse(stdout))?.items;
      if (!Array.isArray(items)) {
        throw new Error("CoreDNS response has no Pod list");
      }
      /** @type {readonly unknown[]} */
      const pods = items;
      const metadata = (/** @type {unknown} */ pod) => {
        const value = asRecord(asRecord(pod)?.metadata);
        if (value === undefined) {
          throw new Error("CoreDNS Pod has no metadata");
        }
        return value;
      };
      if (pods.length !== 1 || metadata(pods[0]).deletionTimestamp) {
        return { done: false, state: pods.map((pod) => metadata(pod).name) };
      }
      try {
        /** @type {unknown} */
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
        if (result === null) {
          throw new Error("DNS lookup returned null");
        }
        const observed = asRecord(result);
        return {
          done: observed?.provider === modelAddress && Boolean(observed?.api),
          state: result,
        };
      } catch (error) {
        const message = asRecord(error)?.message;
        if (typeof message !== "string") {
          throw error;
        }
        return { done: false, state: message.slice(0, 300) };
      }
    },
    120_000,
  );
}
