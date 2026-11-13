import type { Route } from "playwright";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";

// Validate successful API input before patching it. Output may intentionally be malformed
// for fault injection; retain upstream status, useful metadata, and JSON media type.
export async function fulfillPatchedJson<T extends TSchema>(
  route: Route,
  schema: T,
  patch: (body: Static<T>) => unknown,
): Promise<void> {
  const response = await route.fetch();
  if (!response.ok()) {
    await route.fulfill({ response });
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
  const headers = { ...response.headers() };
  // Do not reuse the original body's length, encoding, or cache validators.
  delete headers["content-length"];
  delete headers["content-encoding"];
  delete headers.etag;
  delete headers["last-modified"];
  await route.fulfill({
    response,
    headers,
    json: patch(body),
    contentType: headers["content-type"] ?? "application/json",
  });
}
