import assert from "node:assert/strict";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import {
  bootstrapOutputPath,
  requireAbsentBootstrapOutput,
  writeProtectedBootstrapFile,
} from "../../apps/controller/src/composition/bootstrap-output.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

test("protected bootstrap output rejects relative paths, existing files, symlinks, and public parents", async (t) => {
  const directory = await temporaryDirectory(t, "openclaw-bootstrap-output-");
  assert.throws(
    () => bootstrapOutputPath("relative.json", "OCC_BOOTSTRAP_SERVICE_KEY_FILE"),
    /absolute output path/,
  );

  const existing = join(directory, "existing.json");
  await writeFile(existing, "existing", { mode: 0o600 });
  await assert.rejects(
    writeProtectedBootstrapFile(existing, "replacement"),
    /EEXIST|file already exists/i,
  );
  assert.equal(await readFile(existing, "utf8"), "existing");

  const linked = join(directory, "linked.json");
  await symlink(existing, linked);
  await assert.rejects(
    writeProtectedBootstrapFile(linked, "replacement"),
    /EEXIST|file already exists/i,
  );
  assert.equal(await readFile(existing, "utf8"), "existing");

  const publicDirectory = await temporaryDirectory(t, "openclaw-bootstrap-public-");
  await chmod(publicDirectory, 0o705);
  await assert.rejects(
    writeProtectedBootstrapFile(join(publicDirectory, "key.json"), "secret"),
    /private to the runtime identity/,
  );
});

test("protected bootstrap output rejects oversized basenames", () => {
  const longBasename = "a".repeat(256);
  assert.throws(
    () =>
      bootstrapOutputPath(
        `/var/lib/openclaw/bootstrap/${longBasename}`,
        "OCC_BOOTSTRAP_PASSWORD_FILE",
      ),
    /255 characters/,
  );
});

test("protected bootstrap output rejects a trailing path separator", () => {
  const output = join(tmpdir(), "credential");
  assert.equal(bootstrapOutputPath(output, "CREDENTIAL_FILE"), output);
  assert.throws(() => bootstrapOutputPath(output + sep, "CREDENTIAL_FILE"), {
    message: "CREDENTIAL_FILE must identify a file, not a directory path.",
  });
});

test("bootstrap distinguishes an absent output, a dangling link, and an unverified parent", async (t) => {
  const directory = await temporaryDirectory(t, "occ-bootstrap-preflight-");
  const output = join(directory, "output");
  await requireAbsentBootstrapOutput(output);
  await symlink("missing", output);
  await assert.rejects(requireAbsentBootstrapOutput(output), { code: "BOOTSTRAP_OUTPUT_EXISTS" });
  await assert.rejects(requireAbsentBootstrapOutput(join(directory, "missing", "output")), {
    code: "BOOTSTRAP_OUTPUT_UNVERIFIED",
  });
});
