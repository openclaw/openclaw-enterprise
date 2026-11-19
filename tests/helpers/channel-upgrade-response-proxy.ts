import assert from "node:assert/strict";
import { createServer, request } from "node:https";
import { request as httpRequest } from "node:http";

/** Drop one genuine accepted Deploy response; the upstream mutation still commits. */
export async function createUpgradeResponseProxy(options: {
  upstream: string;
  key: string;
  cert: string;
  agentPath?: string;
}) {
  let deployment: Record<string, unknown> | undefined;
  let deploymentRequests = 0;
  let allDeploymentRequests = 0;
  let stopRequests = 0;
  const server = createServer({ key: options.key, cert: options.cert }, (incoming, outgoing) => {
    if (
      incoming.method === "POST" &&
      /^\/namespaces\/[^/]+\/agents\/[^/]+\/deploy$/.test(incoming.url ?? "")
    ) {
      allDeploymentRequests++;
    }
    if (
      incoming.method === "POST" &&
      /^\/namespaces\/[^/]+\/agents\/[^/]+\/stop$/.test(incoming.url ?? "")
    ) {
      stopRequests++;
    }
    const isDeploy =
      options.agentPath !== undefined &&
      incoming.method === "POST" &&
      incoming.url === `${options.agentPath}/deploy`;
    if (isDeploy) {
      deploymentRequests++;
    }
    const send = options.upstream.startsWith("https:") ? request : httpRequest;
    const upstream = send(
      new URL(incoming.url!, options.upstream),
      {
        method: incoming.method,
        headers: incoming.headers,
        ca: options.cert,
      },
      (response) => {
        if (isDeploy && deployment === undefined && response.statusCode === 202) {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            deployment = JSON.parse(Buffer.concat(chunks).toString()).data;
            outgoing.destroy();
          });
          return;
        }
        outgoing.writeHead(response.statusCode!, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `https://localhost:${address.port}`,
    acceptedDeployment: () => deployment,
    deploymentRequests: () => deploymentRequests,
    allDeploymentRequests: () => allDeploymentRequests,
    stopRequests: () => stopRequests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
