import { existsSync } from "node:fs";
import { createServer } from "node:http";

const server = createServer((request, response) => {
  if (request.url !== "/readyz") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // A durable fixture marker lets integration exercise an actual unready
  // replacement without replacing the Driver or Kubernetes readiness checks.
  const ready = !existsSync("/home/node/workspace/.fixture-unready");
  response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ ready }));
});

server.listen(8080, "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close());
}
