export default {
  id: "oce-outbound-proof",
  name: "Gateway outbound integration proof",
  register(api) {
    // Run actual global fetch in the native Gateway process, including its client-side TLS checks.
    api.registerGatewayMethod(
      "outbound-proof.fetch",
      async ({ params, respond }) => {
        try {
          const response = await fetch(params.url, {
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          });
          const body = await response.text();
          respond(true, {
            connected: true,
            status: response.status,
            body: body.slice(0, 256),
            nodeVersion: process.versions.node,
          });
        } catch {
          respond(true, { connected: false, nodeVersion: process.versions.node });
        }
      },
      { scope: "operator.admin", profileAccess: "independent" },
    );
  },
};
