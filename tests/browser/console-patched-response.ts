import type { Route } from "playwright";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";

// Validate successful API input before patching it. Output may intentionally be malformed
// for fault injection; retain upstream status, useful metadata, and JSON media type.
export async function fulfillPatchedJson<T extends TSchema>(
  route: Route,
  schema: T,
  patch: (body: Static<T>) => unknown,
  fetchRequest?: (request: Request) => Promise<Response>,
): Promise<void> {
  const original = route.request();
  const requestBody = original.postData();
  const response = fetchRequest
    ? await fetchRequest(
        new Request(original.url(), {
          method: original.method(),
          headers: await original.allHeaders(),
          ...(requestBody === null ? {} : { body: requestBody }),
        }),
      )
    : await route.fetch();
  const status = response instanceof Response ? response.status : response.status();
  const headers =
    response instanceof Response ? Object.fromEntries(response.headers) : { ...response.headers() };
  if (!(response instanceof Response ? response.ok : response.ok())) {
    await route.fulfill(
      response instanceof Response
        ? { status, headers, body: Buffer.from(await response.arrayBuffer()) }
        : { response },
    );
    return;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Cannot patch successful API response: invalid JSON");
  }
  if (!Check(schema, body)) {
    throw new Error("Cannot patch successful API response: response schema mismatch");
  }
  // Do not reuse the original body's length, encoding, or cache validators.
  delete headers["content-length"];
  delete headers["content-encoding"];
  delete headers.etag;
  delete headers["last-modified"];
  await route.fulfill({
    status,
    headers,
    json: patch(body),
    contentType: headers["content-type"] ?? "application/json",
  });
}
