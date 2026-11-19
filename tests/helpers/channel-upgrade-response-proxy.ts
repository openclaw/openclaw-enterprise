import assert from "node:assert/strict";
import { createServer, request } from "node:https";

/** Drop one genuine accepted Deploy response; the upstream mutation still commits. */
export async function loseOneDeploymentResponse(options: {
  upstream: string;
  key: string;
  cert: string;
  agentPath: string;
}) {
  let deployment: Record<string, unknown> | undefined;
  let deploymentRequests = 0;
  const server = createServer({ key: options.key, cert: options.cert }, (incoming, outgoing) => {
    const isDeploy = incoming.method === "POST" && incoming.url === `${options.agentPath}/deploy`;
    if (isDeploy) {
      deploymentRequests++;
    }
    const upstream = request(
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
