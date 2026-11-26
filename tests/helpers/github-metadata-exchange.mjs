import assert from "node:assert/strict";

// The test plays the enrolled supervisor. OCE owns the genuine signed installation
// exchange, private response acceptance and material/dispatch/response decisions.
/**
 * @typedef {ReturnType<ReturnType<typeof import("./static-egress-exchange.ts").createStaticEgressExchange>["capture"]>} Capture
 * @typedef {Pick<ReturnType<typeof import("./static-egress-exchange.ts").createStaticEgressExchange>, "capture"> & {
 *   installation: import("../../packages/contracts/src/index.ts").EgressInstallation
 * }} MetadataFixture
 */
/**
 * @param {MetadataFixture} f
 * @param {{target?: Partial<Capture["request"]["target"]>, headers?: Capture["request"]["headers"], body?: Buffer}} [changed]
 */
export function captureMetadata(f, changed = {}) {
  const captured = f.capture();
  const [route] = f.installation.plan.routes;
  assert.ok(route, "the fixture has an installed metadata route");
  const origin = new URL(route.origin);
  Object.assign(captured.request, {
    target: {
      scheme: "https",
      host: origin.hostname,
      port: Number(origin.port || 443),
      method: "GET",
      path: route.path,
      ...changed.target,
    },
    headers: changed.headers ?? [],
    body: changed.body ?? Buffer.alloc(0),
  });
  return captured;
}
