// kubectl port-forward enters the Pod's network namespace through loopback.
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { createServer } from "node:tls";

const server = createServer(
  {
    cert: readFileSync("/tls/tls.crt"),
    key: readFileSync("/tls/tls.key"),
    minVersion: "TLSv1.2",
  },
  (client) => {
    const upstream = connect(8080, "openclaw-enterprise-api.oce-system.svc.cluster.local");
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
    client.pipe(upstream).pipe(client);
  },
);
server.listen(8443, "127.0.0.1");
