import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import type { CleanupRegistrar } from "./console-file-app.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

type Cluster = { name: string; cluster: { server: string } };
type Context = { name: string; context: { cluster: string; user: string } };
type User = { name: string; user: { token: string } };

type Scenario = {
  name: string;
  context?: string;
  contexts?: readonly Context[];
  clusters?: readonly Cluster[];
  users?: readonly User[];
  server?: string;
  skipTLSVerify?: boolean;
};

type WrittenKubeconfig = {
  name: string;
  kubeconfigPath: string;
  context: string;
};

// Kubeconfigs that the official Kubernetes client parses but whose identity or transport a
// Driver must refuse before contacting the API server: each differs from a safe kubeconfig
// (one token user, one verified-HTTPS cluster at the API root, one explicit context) in one
// way. Every parseable API server is an unreachable loopback port, so an unrefused fixture
// fails late.
const context = "unsafe-fixture-context";
const cluster = { name: "unsafe-fixture-cluster", cluster: { server: "https://127.0.0.1:1" } };
const contextEntry = {
  name: context,
  context: { cluster: "unsafe-fixture-cluster", user: "unsafe-fixture-user" },
};
const scenarios: readonly Scenario[] = [
  { name: "unselected-context", context: "missing-context" },
  { name: "duplicate-context", contexts: [contextEntry, contextEntry] },
  {
    name: "ambiguous-cluster",
    clusters: [cluster, { ...cluster, cluster: { server: "https://127.0.0.1:2" } }],
  },
  {
    name: "context-without-cluster",
    contexts: [{ ...contextEntry, context: { ...contextEntry.context, cluster: "missing" } }],
  },
  { name: "missing-credential-identity", users: [] },
  { name: "plaintext-api-endpoint", server: "http://127.0.0.1:1" },
  { name: "unverified-tls", skipTLSVerify: true },
  {
    name: "embedded-api-username",
    server: syntheticCredentialUrl({ username: "user", password: "", host: "127.0.0.1", port: 1 }),
  },
  {
    name: "embedded-api-password",
    server: syntheticCredentialUrl({
      username: "",
      password: "password",
      host: "127.0.0.1",
      port: 1,
    }),
  },
  { name: "unexpected-api-path", server: "https://127.0.0.1:1/untrusted" },
  { name: "api-query", server: "https://127.0.0.1:1/?untrusted=1" },
  { name: "api-fragment", server: "https://127.0.0.1:1/#untrusted" },
  { name: "invalid-api-url", server: "not a url" },
];

async function writeKubeconfig(directory: string, scenario: Scenario): Promise<WrittenKubeconfig> {
  const kubeconfigPath = join(directory, `${scenario.name}.json`);
  await writeFile(
    kubeconfigPath,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: scenario.clusters ?? [
        {
          ...cluster,
          cluster: {
            server: scenario.server ?? cluster.cluster.server,
            ...(scenario.skipTLSVerify ? { "insecure-skip-tls-verify": true } : {}),
          },
        },
      ],
      users: scenario.users ?? [
        { name: "unsafe-fixture-user", user: { token: "test-only-fixture-token" } },
      ],
      contexts: scenario.contexts ?? [contextEntry],
      "current-context": context,
    }),
    { mode: 0o600 },
  );
  return { name: scenario.name, kubeconfigPath, context: scenario.context ?? context };
}

const directoryPrefix = "openclaw-unsafe-kubeconfig-";

/**
 * Writes one kubeconfig per unsafe scenario into a private temporary directory that `t`
 * removes afterwards. Returns `{ name, kubeconfigPath, context }` per scenario, where
 * `context` is the context a Driver should be configured to request.
 */
export async function writeUnsafeKubeconfigs(t: CleanupRegistrar): Promise<WrittenKubeconfig[]> {
  const directory = await temporaryDirectory(t, directoryPrefix);
  const written: WrittenKubeconfig[] = [];
  for (const scenario of scenarios) {
    written.push(await writeKubeconfig(directory, scenario));
  }
  return written;
}

/**
 * Writes the safe kubeconfig every unsafe scenario departs from, as `{ name, kubeconfigPath,
 * context }`. A Driver must accept it and only then fail to reach the unreachable API server.
 */
export async function writeSafeKubeconfig(t: CleanupRegistrar): Promise<WrittenKubeconfig> {
  return writeKubeconfig(await temporaryDirectory(t, directoryPrefix), { name: "safe" });
}
