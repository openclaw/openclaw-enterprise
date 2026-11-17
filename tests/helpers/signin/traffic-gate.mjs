// verifiedOperatorExec is the scoped fixture executor checking acknowledged namespace/Pod UID
// and the private mounted volume. No management route is exposed over HTTPS.
export function trafficGate(verifiedOperatorExec, consoleFetch, origin) {
  const marker = "/operator/signin-gate";
  async function assertClosedRoutes() {
    const statuses = {};
    for (const [method, path] of [
      ["POST", "start"],
      ["GET", "callback"],
      ["POST", "result"],
    ]) {
      const response = await consoleFetch(new URL("/api/auth/providers/oidc/" + path, origin), {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      if (response.status !== 503 || response.headers.get("x-rehearsal-gate") !== "closed") {
        throw new Error("issuer or result route not closed");
      }
      await response.arrayBuffer();
      statuses[path] = response.status;
    }
    return statuses;
  }
  return {
    assertClosedRoutes,
    async closeAndProbeRoutes() {
      await verifiedOperatorExec(
        "node",
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],'',{mode:0o600})",
        marker,
      );
      return assertClosedRoutes();
    },
    async openTarget() {
      await assertClosedRoutes();
      await verifiedOperatorExec(
        "node",
        "-e",
        "const fs=require('node:fs'),p=process.argv[1]; fs.copyFileSync(p+'.generation',p+'.new'); fs.renameSync(p+'.new',p)",
        marker,
      );
    },
  };
}
