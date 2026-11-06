import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Public source is delivered through the same owned runtime projection as its
// configuration. The launch command binds these exact bytes before execution.
export const PUBLIC_GITHUB_READ_TRANSPORT_FILE = "public-github-read-transport.mjs";
export const PUBLIC_GITHUB_READ_TRANSPORT_ENV = "OCE_PUBLIC_GITHUB_READ_TRANSPORT_FILE";
export const PUBLIC_GITHUB_READ_TRANSPORT_SOURCE = readFileSync(
  new URL("./transport.mjs", import.meta.url),
  "utf8",
);
if (Buffer.byteLength(PUBLIC_GITHUB_READ_TRANSPORT_SOURCE) > 65_536) {
  throw new Error("Public reader runtime source exceeds its delivery bound.");
}
export const PUBLIC_GITHUB_READ_TRANSPORT_SHA256 = createHash("sha256")
  .update(PUBLIC_GITHUB_READ_TRANSPORT_SOURCE)
  .digest("hex");
