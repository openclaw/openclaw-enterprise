import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import { selfSigned } from "./certificates.mjs";
import type { CleanupRegistrar } from "./console-file-app.ts";
import { listen } from "./listen.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

export interface KubernetesSdkRequest {
  readonly method: string;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  readonly headers: Readonly<IncomingHttpHeaders>;
  readonly body: unknown;
}

export interface KubernetesSdkResponse {
  readonly status?: number;
  readonly body: object;
}

interface KubernetesSdkApi {
  readonly authentication: {
    readonly mode: "kubeconfig";
    readonly kubeconfigPath: string;
    readonly context: string;
  };
  readonly requests: readonly KubernetesSdkRequest[];
}

interface KubernetesSdkApiOptions {
  readonly name: string;
  readonly respond: (
    request: KubernetesSdkRequest,
  ) => KubernetesSdkResponse | undefined | Promise<KubernetesSdkResponse | undefined>;
}

export function kubernetesNotFound(
  kind: string,
  name: string,
  group?: string,
): KubernetesSdkResponse {
  return {
    status: 404,
    body: {
      apiVersion: "v1",
      kind: "Status",
      status: "Failure",
      message: `${group === undefined ? kind : `${kind}.${group}`} "${name}" not found`,
      reason: "NotFound",
      details: { kind, name, ...(group === undefined ? {} : { group }) },
      code: 404,
    },
  };
}

export function kubernetesList<T extends object>(
  apiVersion: string,
  kind: string,
  items: readonly T[],
) {
  return { apiVersion, kind: `${kind}List`, metadata: { resourceVersion: "1" }, items };
}

export function persistedKubernetesObject<T extends { readonly metadata: object }>(
  object: T,
  uid: string,
  resourceVersion = "1",
) {
  return { ...object, metadata: { ...object.metadata, uid, resourceVersion } };
}

// A wire fixture for the production SDK. The scenario supplies the API observations
// and records their effects through the public Driver operation.
export async function startKubernetesSdkApi(
  t: CleanupRegistrar,
  { name, respond }: KubernetesSdkApiOptions,
): Promise<KubernetesSdkApi> {
  assert.match(name, /^[a-z][a-z0-9-]*$/);
  const cleanups: (() => void | Promise<void>)[] = [];
  const registrar = {
    after(cleanup: () => void | Promise<void>) {
      cleanups.push(cleanup);
    },
  };
  const requests: KubernetesSdkRequest[] = [];
  const unexpected: Error[] = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
    if (unexpected.length > 0) {
      throw new AggregateError(unexpected, unexpected.map(({ message }) => message).join("\n"));
    }
  });

  const directory = await temporaryDirectory(registrar, `occ-kube-sdk-${name}-`);
  const certificate = await selfSigned(directory, { subjectAltName: "IP:127.0.0.1" });

  async function dispatch(incoming: IncomingMessage, outgoing: ServerResponse) {
    const target = new URL(incoming.url ?? "/", "https://127.0.0.1");
    let body: unknown;
    const request: KubernetesSdkRequest = {
      method: incoming.method ?? "",
      pathname: target.pathname,
      searchParams: target.searchParams,
      headers: incoming.headers,
      get body() {
        return body;
      },
    };
    requests.push(request);
    try {
      const raw = await text(incoming);
      body = raw === "" ? undefined : JSON.parse(raw);
      const answer = await respond(request);
      assert.ok(
        answer,
        `Unexpected Kubernetes request ${request.method} ${target.pathname}${target.search}`,
      );
      const responseBody = JSON.stringify(answer.body);
      outgoing.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      outgoing.end(responseBody);
    } catch (error) {
      const message = `Kubernetes fixture failed for ${request.method} ${target.pathname}${target.search}`;
      unexpected.push(error instanceof Error ? error : new Error(message, { cause: error }));
      if (outgoing.destroyed) {
        return;
      }
      // Fail unexpected requests immediately, so read retry logic cannot mask a bad script.
      outgoing.writeHead(400, { "content-type": "application/json" });
      outgoing.end(
        JSON.stringify({
          apiVersion: "v1",
          kind: "Status",
          status: "Failure",
          reason: "BadRequest",
          message,
          code: 400,
        }),
      );
    }
  }

  const server = createServer(
    { key: certificate.key, cert: certificate.cert },
    (incoming, outgoing) => {
      void dispatch(incoming, outgoing);
    },
  );
  const port = await listen(registrar, server);
  const url = `https://127.0.0.1:${port}`;
  const kubeconfigPath = join(directory, "kubeconfig");
  await writeFile(
    kubeconfigPath,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name, cluster: { server: url, "certificate-authority": certificate.certPath } }],
      users: [{ name, user: {} }],
      contexts: [{ name, context: { cluster: name, user: name } }],
      "current-context": name,
    }),
    { mode: 0o600 },
  );
  return {
    authentication: { mode: "kubeconfig", kubeconfigPath, context: name },
    requests,
  };
}
