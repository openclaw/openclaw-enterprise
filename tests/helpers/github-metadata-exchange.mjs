import assert from "node:assert/strict";
import { get } from "node:https";

// The test plays the enrolled supervisor. OCE owns the genuine signed installation
// exchange, private response acceptance and material/dispatch/response decisions.
export function captureMetadata(f, changed = {}) {
  const captured = f.capture();
  const [route] = f.installation.plan.routes;
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

export async function dispatchMetadata(
  f,
  gh,
  captured,
  ready,
  forbiddenTrailer = false,
  expectedStatus = 200,
) {
  const decision = await f.authorize(f.permitRequest(captured, ready));
  assert.ok(decision.allowed, "specific dispatch must be acknowledged before sending to origin");
  const { target } = captured.request;
  const response = await new Promise((resolve, reject) => {
    get(
      new URL(target.path, gh.origin),
      {
        ca: gh.tls.ca,
        headers: Object.fromEntries(
          ready.credential_headers.map(({ name, value }) => [name, value]),
        ),
      },
      async (res) => {
        const body = [];
        for await (const bytes of res) {
          body.push(bytes);
        }
        assert.equal(
          res.statusCode,
          expectedStatus,
          "synthetic issuer must return the expected response for the prepared credential",
        );
        assert.deepEqual(res.rawTrailers, forbiddenTrailer ? ["x-forbidden-last", "last"] : []);
        resolve({
          status: res.statusCode,
          headers: [{ name: "content-type", value: res.headers["content-type"] }],
          trailers: res.rawTrailers.flatMap((name, i, raw) =>
            i % 2 ? [] : [{ name, value: raw[i + 1] }],
          ),
          body: Buffer.concat(body),
          response_complete: res.complete,
        });
      },
    ).once("error", reject);
  });
  const protectedResponse = await f.protect(captured, response);
  if (forbiddenTrailer) {
    assert.deepEqual(
      protectedResponse,
      { blocked: true },
      "no response message released on the exchange",
    );
  }
  return protectedResponse;
}
