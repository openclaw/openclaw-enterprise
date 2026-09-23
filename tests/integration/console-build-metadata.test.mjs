import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("console image metadata preserves the supplied revision and rejects invalid build inputs", async (t) => {
  // Exercise the same build command and HTML artifact copied into both image targets.
  const directory = await mkdtemp(join(tmpdir(), "occ-console-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, "apps/controller/src/console"), { recursive: true });
  const script = join(directory, "scripts/build-console-metadata.mjs");
  const shell = join(directory, "apps/controller/src/console/index.html");
  await cp(new URL("../../scripts/build-console-metadata.mjs", import.meta.url), script);
  await cp(new URL("../../apps/controller/src/console/index.html", import.meta.url), shell);
  const revision = "abcdef1234567890abcdef1234567890abcdef12";
  await execute(process.execPath, [script, revision]);
  assert.ok(
    (await readFile(shell, "utf8")).includes(`name="occ-build-revision" content="${revision}"`),
  );

  for (const invalid of ["abcdef12", "unknown", "<script>alert(1)</script>"]) {
    await assert.rejects(
      execute(process.execPath, [script, invalid]),
      /must be a full lowercase Git commit hash or empty/,
    );
  }
  // Missing metadata clears an earlier stamp, even when Git or unrelated env metadata exists.
  await execute(process.execPath, [script], { env: { ...process.env, GITHUB_SHA: revision } });
  assert.ok((await readFile(shell, "utf8")).includes('name="occ-build-revision" content=""'));
});
