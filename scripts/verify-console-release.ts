#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { readAnonymousHttps, type HttpFailure } from "./lib/anonymous-https.ts";
import {
  ASSET_PATH,
  ENTRY_PATH,
  MAX_ASSET_BYTES,
  MAX_HTML_BYTES,
  declaresStockEntry,
  loadReleasedConsole,
  matchesReleaseShell,
} from "./lib/console-release-source.ts";

const OPERATION_TIMEOUT = 5_000;
const DEADLINE = 20_000;

export type VerificationResult =
  | { result: "verified"; revision: string; assetSha256: string; entrySha256?: string }
  | { result: HttpFailure | "invalid-source" | "wrong-shell" | "wrong-asset" | "wrong-entry" };

function consoleUrl(raw: string): URL | undefined {
  const parts = /^https:\/\/([^/?#]+)(\/[^?#]*)?$/.exec(raw);
  if (!parts || /[^\x21-\x7e]|\\/.test(raw) || parts[1]!.includes("@") || !URL.canParse(raw)) {
    return undefined;
  }
  const path = parts[2] ?? "/";
  const url = new URL(raw);
  return path.startsWith("//") || url.pathname !== path || url.host !== parts[1] ? undefined : url;
}

export async function verifyConsoleRelease(
  source: string,
  revision: string,
  rawUrl: string,
  expectedEntrySha256?: string,
): Promise<VerificationResult> {
  const url = consoleUrl(rawUrl);
  if (
    source.length === 0 ||
    !url ||
    !/^[a-f0-9]{40}$/.test(revision) ||
    (expectedEntrySha256 !== undefined &&
      (expectedEntrySha256.length !== 64 || /[^a-f0-9]/.test(expectedEntrySha256)))
  ) {
    return { result: "invalid-input" };
  }
  const budget = { signal: AbortSignal.timeout(DEADLINE), timeout: OPERATION_TIMEOUT };
  const expected = await loadReleasedConsole(source, revision, budget);
  if (!expected) {
    return { result: budget.signal.aborted ? "deadline-exceeded" : "invalid-source" };
  }
  const html = await readAnonymousHttps(url, {
    ...budget,
    mediaType: "text/html",
    maxBytes: MAX_HTML_BYTES,
  });
  if ("result" in html) {
    return html;
  }
  if (
    !matchesReleaseShell(html.bytes, expected.shell) ||
    (expectedEntrySha256 !== undefined && !declaresStockEntry(expected.shell))
  ) {
    return { result: "wrong-shell" };
  }
  const asset = await readAnonymousHttps(new URL(ASSET_PATH, url), {
    ...budget,
    mediaType: "text/css",
    maxBytes: MAX_ASSET_BYTES,
  });
  if ("result" in asset) {
    return asset;
  }
  if (!asset.bytes.equals(expected.asset)) {
    return { result: "wrong-asset" };
  }
  const proof = {
    result: "verified" as const,
    revision,
    assetSha256: createHash("sha256").update(asset.bytes).digest("hex"),
  };
  if (expectedEntrySha256 === undefined) {
    return proof;
  }
  const entry = await readAnonymousHttps(new URL(ENTRY_PATH, url), {
    ...budget,
    mediaType: "text/javascript",
    maxBytes: MAX_ASSET_BYTES,
  });
  if ("result" in entry) {
    return entry;
  }
  const entrySha256 = createHash("sha256").update(entry.bytes).digest("hex");
  return entrySha256 === expectedEntrySha256
    ? { ...proof, entrySha256 }
    : { result: "wrong-entry" };
}

if (import.meta.main ?? import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["-h", "--help"].includes(args[0]!)) {
    process.stdout.write(
      "Usage: node scripts/verify-console-release.ts SOURCE REVISION URL [--entry-sha256 SHA256]\n\nVerify the served Console against a reviewed release commit. SOURCE is a local Git repository, REVISION is a full lowercase commit, and URL is the canonical user-facing HTTPS URL. To also verify the entry module, supply its 64-character lowercase SHA-256 from the selected image's independent evidence. Prints one private JSON result and exits 0 only when verified.\n",
    );
  } else {
    const result: VerificationResult =
      args.length === 3 || (args.length === 5 && args[3] === "--entry-sha256")
        ? await verifyConsoleRelease(args[0]!, args[1]!, args[2]!, args[4])
        : { result: "invalid-input" };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.result === "verified" ? 0 : 1;
  }
}
