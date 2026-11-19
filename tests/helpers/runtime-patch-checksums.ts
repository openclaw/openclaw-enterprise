import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export async function readRuntimePatchChecksums(): Promise<[string, string][]> {
  const dockerfile = await readFile(
    new URL("../../deploy/runtime/Dockerfile", import.meta.url),
    "utf8",
  );
  return [
    ...dockerfile.matchAll(
      /^COPY deploy\/runtime\/(\S+\.patch) \/tmp\/\1\nRUN echo '([a-f0-9]{64}) {2}\/tmp\/\1' \| sha256sum --check --strict \\\n\s+&& git apply /gm,
    ),
  ].map(([, file, sha256]) => {
    assert.ok(file && sha256, "Expected an applied patch path and digest");
    return [file, sha256];
  });
}
