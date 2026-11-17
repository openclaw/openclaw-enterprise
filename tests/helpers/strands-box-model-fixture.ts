import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import type { TestContext } from "node:test";
import type { ModelGatewayConfiguration } from "../../deploy/examples/strands-box/driver/model-gateway.ts";
import { harnessTlsFixture } from "./harness-tls.ts";

// Test stand-ins for the protected Strands Box model route. The Kubernetes API is a stand-in
// HTTPS server that implements only the Secret verbs the example's Role grants (get, create,
// update, delete in one namespace) and records each call; no cluster or credential is read.

export const MODEL_SECRET_NAMESPACE = "oce-strands-model";

interface StoredSecret {
  metadata: Record<string, unknown> & { resourceVersion: string };
  data: Record<string, string>;
  [key: string]: unknown;
}

/** A generated test key: printable, never a real credential, never printed. */
export function testModelKey(): string {
  return `sk-test-${randomBytes(24).toString("base64url")}`;
}

export async function fakeKubernetesSecrets(t: TestContext) {
  const tls = await harnessTlsFixture(t);
  const token = randomBytes(32).toString("base64url");
  const tokenFile = join(tls.directory, "token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const secrets = new Map<string, StoredSecret>();
  /** `<VERB> <namespace> <name|->`, never a body. */
  const calls: string[] = [];
  let version = 0;
  let failNext: number | undefined;
  /** Each DELETE's preconditions, as the store sent them. */
  const deletes: unknown[] = [];
  /** Runs once before the next DELETE is decided: a concurrent change stand-in. */
  let beforeDelete: ((name: string) => void) | undefined;
  const prefix = `/api/v1/namespaces/`;
  const server = createServer(tls, (req, res) => {
    void (async () => {
      const raw = await text(req);
      const reply = (status: number, value?: unknown) =>
        res
          .writeHead(status, { "content-type": "application/json" })
          .end(value === undefined ? "" : JSON.stringify(value));
      if (req.headers.authorization !== `Bearer ${token}`) {
        reply(401, { kind: "Status", code: 401 });
        return;
      }
      const url = req.url ?? "";
      const match = /^\/api\/v1\/namespaces\/([a-z0-9-]+)\/secrets(?:\/([a-z0-9-]+))?$/.exec(url);
      const verb = req.method ?? "";
      calls.push(`${verb} ${match?.[1] ?? url.slice(prefix.length)} ${match?.[2] ?? "-"}`);
      // Least privilege: anything outside Secrets in the one namespace is forbidden.
      if (match === null || match[1] !== MODEL_SECRET_NAMESPACE) {
        reply(403, { kind: "Status", code: 403 });
        return;
      }
      if (failNext !== undefined) {
        const status = failNext;
        failNext = undefined;
        reply(status, { kind: "Status", code: status });
        return;
      }
      const name = match[2];
      if (verb === "POST" && name === undefined) {
        const body = JSON.parse(raw) as StoredSecret;
        const key = String(body.metadata.name);
        if (secrets.has(key)) {
          reply(409, { kind: "Status", code: 409 });
          return;
        }
        body.metadata.resourceVersion = String(++version);
        body.metadata.uid = randomUUID();
        secrets.set(key, body);
        reply(201, body);
        return;
      }
      if (name === undefined) {
        reply(405);
        return;
      }
      const current = secrets.get(name);
      if (verb === "GET") {
        reply(current === undefined ? 404 : 200, current ?? { kind: "Status", code: 404 });
        return;
      }
      if (verb === "PUT") {
        const body = JSON.parse(raw) as StoredSecret;
        if (current === undefined) {
          reply(404);
          return;
        }
        if (body.metadata.resourceVersion !== current.metadata.resourceVersion) {
          reply(409, { kind: "Status", code: 409 });
          return;
        }
        body.metadata.resourceVersion = String(++version);
        body.metadata.uid = current.metadata.uid;
        secrets.set(name, body);
        reply(200, body);
        return;
      }
      if (verb === "DELETE") {
        const hook = beforeDelete;
        beforeDelete = undefined;
        hook?.(name);
        const options = raw === "" ? undefined : (JSON.parse(raw) as Record<string, unknown>);
        const preconditions = options?.preconditions as Record<string, unknown> | undefined;
        deletes.push(preconditions);
        const stored = secrets.get(name);
        if (stored === undefined) {
          reply(404);
          return;
        }
        // As the API server: a precondition that no longer holds is a 409, nothing deleted.
        if (
          preconditions !== undefined &&
          ((preconditions.uid !== undefined && preconditions.uid !== stored.metadata.uid) ||
            (preconditions.resourceVersion !== undefined &&
              preconditions.resourceVersion !== stored.metadata.resourceVersion))
        ) {
          reply(409, { kind: "Status", code: 409, reason: "Conflict" });
          return;
        }
        secrets.delete(name);
        reply(200, { kind: "Status", status: "Success" });
        return;
      }
      reply(405);
    })().catch(() => res.destroy());
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as { port: number };
  const configuration: ModelGatewayConfiguration = {
    secretNamespace: MODEL_SECRET_NAMESPACE,
    kubernetes: { url: `https://localhost:${port}`, caFile: tls.rootCertificatePath, tokenFile },
  };
  return {
    configuration,
    secrets,
    calls,
    deletes,
    /** The next Secret call gets this status (an API failure stand-in). */
    failNext(status: number) {
      failNext = status;
    },
    /** Change a Secret between the store's read and its DELETE, once. */
    beforeNextDelete(change: (name: string) => void) {
      beforeDelete = change;
    },
    /** Bump a Secret's resourceVersion, as any write would. */
    touch(name: string) {
      const stored = secrets.get(name);
      if (stored !== undefined) {
        stored.metadata.resourceVersion = String(++version);
      }
    },
    /** The stored value of one Secret, for the test's own comparison; never printed. */
    value(name: string): string | undefined {
      const encoded = secrets.get(name)?.data.api_key;
      return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8");
    },
  };
}

/** Box's request-time document for one model request (`[gateway.credential_source.oce-model]`). */
export function boxModelRequest(
  requestId: string,
  target: Record<string, unknown> = {},
  body: Buffer = Buffer.from('{"model":"fixture-model","input":"hello"}'),
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 1,
    request_id: requestId,
    target: {
      scheme: "https",
      host: "10.0.0.9",
      port: 8444,
      method: "POST",
      path: "/v1/responses",
      query: "",
      ...target,
    },
    headers: [
      ["content-type", "application/json"],
      ["accept", "text/event-stream"],
    ],
    body: body.toString("base64"),
    ...overrides,
  };
}

/** POST one Box source document to a host source socket, as Box does. */
export function askSource(
  socketPath: string,
  bearer: string | undefined,
  document: unknown,
): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(typeof document === "string" ? document : JSON.stringify(document));
    const call = httpRequest(
      {
        socketPath,
        method: "POST",
        path: "/",
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        },
      },
      (response) => {
        void text(response).then((raw) =>
          resolve({
            status: response.statusCode ?? 0,
            body: raw === "" ? undefined : (JSON.parse(raw) as Record<string, unknown>),
          }),
        );
      },
    );
    call.on("error", reject);
    call.end(payload);
  });
}
