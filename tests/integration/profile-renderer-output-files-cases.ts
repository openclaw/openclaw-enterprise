import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, linkSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileTemporaryDirectory } from "../helpers/temporary-directory.ts";
import { baseInput, codexInput } from "./profile-renderer-inputs.ts";
import {
  repository,
  render,
  renderError,
  profileFailure,
  readPreflight,
} from "./profile-renderer-fixture.ts";

export function registerOutputFileCases(): void {
  test("profile renderer refuses input paths owned by its output directory without deleting files", async (t) => {
    for (const name of ["values.yaml", "installation.yaml", "preflight.json"]) {
      for (const alias of ["direct", "input-directory", "output-directory", "file", "hardlink"]) {
        await t.test(`${name}, alias=${alias}`, async () => {
          const directory = fileTemporaryDirectory("occ-profile-input-collision-");
          const output = join(directory, "output");
          mkdirSync(output);
          // Seed real rendered files. A naming mistake must not destroy the input or its siblings.
          await render("openclaw", baseInput(), output);
          const input = join(output, name);
          writeFileSync(input, JSON.stringify(baseInput()));
          const before = new Map(
            ["values.yaml", "installation.yaml", "preflight.json"].map((file) => [
              file,
              readFileSync(join(output, file)),
            ]),
          );
          let inputPath = input;
          let outputPath = output;
          if (alias === "input-directory" || alias === "output-directory") {
            const link = join(directory, "output-alias");
            symlinkSync(output, link, "dir");
            if (alias === "input-directory") {
              inputPath = join(link, name);
            } else {
              outputPath = link;
            }
          } else if (alias === "file" || alias === "hardlink") {
            inputPath = join(directory, "input-alias.json");
            if (alias === "file") {
              symlinkSync(input, inputPath);
            } else {
              linkSync(input, inputPath);
            }
          }
          assert.throws(
            () =>
              execFileSync(
                process.execPath,
                [
                  "scripts/render-installation-profile.ts",
                  "--profile",
                  "openclaw",
                  "--input",
                  inputPath,
                  "--out-dir",
                  outputPath,
                ],
                { cwd: repository, stdio: "pipe" },
              ),
            /input must not name a generated output file/,
          );
          for (const [file, contents] of before) {
            assert.deepEqual(readFileSync(join(output, file)), contents, file);
          }
        });
      }
    }
  });

  test("failed rerenders remove stale deployable artifacts from a reused directory", async () => {
    for (const profile of ["openclaw", "codex"]) {
      const input = profile === "codex" ? codexInput() : baseInput();
      const output = await render(profile, input);
      const notes = join(output.directory, "operator-notes.txt");
      writeFileSync(notes, "Retain operator-owned files.\n");

      // A failed second run must not leave the first run's configuration deployable.
      const invalid = structuredClone(input);
      invalid.controlPlane.databaseCidrs = ["invalid-cidr"];
      const error = await renderError(() => render(profile, invalid, output.directory));
      assert.match(profileFailure(error).output, /must be an IPv4 \/32 CIDR/);
      for (const name of ["values.yaml", "installation.yaml"]) {
        assert.equal(existsSync(join(output.directory, name)), false);
      }
      const preflight = readPreflight(output.directory);
      assert.equal(preflight.ok, false);
      assert.deepEqual(preflight.outputs, { preflight: join(output.directory, "preflight.json") });
      assert.equal(readFileSync(notes, "utf8"), "Retain operator-owned files.\n");

      // Recovery regenerates both artifacts; malformed JSON must also invalidate that success.
      assert.equal((await render(profile, input, output.directory)).preflight.ok, true);
      writeFileSync(join(output.directory, "input.json"), "{");
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              "scripts/render-installation-profile.ts",
              "--profile",
              profile,
              "--input",
              join(output.directory, "input.json"),
              "--out-dir",
              output.directory,
            ],
            { cwd: repository, stdio: "pipe" },
          ),
        /unavailable or invalid JSON/,
      );
      for (const name of ["values.yaml", "installation.yaml", "preflight.json"]) {
        assert.equal(existsSync(join(output.directory, name)), false);
      }
      assert.equal(readFileSync(notes, "utf8"), "Retain operator-owned files.\n");

      // A filesystem metadata failure must still revoke stale success before reporting bad input.
      assert.equal((await render(profile, input, output.directory)).preflight.ok, true);
      const loop = join(output.directory, "loop.json");
      symlinkSync(loop, loop);
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              "scripts/render-installation-profile.ts",
              "--profile",
              profile,
              "--input",
              loop,
              "--out-dir",
              output.directory,
            ],
            { cwd: repository, stdio: "pipe" },
          ),
        /unavailable or invalid JSON/,
      );
      for (const name of ["values.yaml", "installation.yaml", "preflight.json"]) {
        assert.equal(existsSync(join(output.directory, name)), false);
      }
      assert.equal(readFileSync(notes, "utf8"), "Retain operator-owned files.\n");
    }
  });
}
