import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { image, imageTestOptions, runDocker } from "./production-image-controller-startup-cases.ts";

// This case builds the occ CLI with Go, so only the images-packaging suite runs it.
// The native image smoke runs production-image-startup.test.mjs, which needs no Go.

test(
  "development bootstrap mount copies support a different reader UID",
  imageTestOptions,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "occ-bootstrap-mounts-"));
    const project = `occ-mounts-${randomBytes(6).toString("hex")}`;
    const file = join(directory, "compose.json");
    const compose = ["compose", "--project-name", project, "-f", file];
    t.after(async () => {
      await runDocker([...compose, "down", "--remove-orphans"]);
      await rm(directory, { recursive: true, force: true });
    });
    const reader = process.getuid() === 1001 ? 1002 : 1001;
    const password = "synthetic-admin-password";
    const key = `occ_${randomBytes(32).toString("base64url")}`;
    for (const [name, value] of Object.entries({
      "admin-password": password,
      "admin-service-key": key,
    })) {
      await writeFile(join(directory, name), value, { mode: 0o600 });
      await writeFile(join(directory, `mount-${name}`), value, { mode: 0o600 });
    }
    const probe = `import {bootstrapCredentials} from '/app/scripts/lib/bootstrap-credentials.ts'; await bootstrapCredentials({OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE:'/run/secrets/password', OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE:'/run/secrets/key'}); console.log('credentials-readable');`;
    await writeFile(
      file,
      JSON.stringify({
        services: {
          bootstrap: {
            image,
            user: `${reader}:${reader}`,
            network_mode: "none",
            read_only: true,
            cap_drop: ["ALL"],
            security_opt: ["no-new-privileges:true"],
            entrypoint: ["node"],
            command: ["--input-type=module", "-e", probe],
            secrets: [
              { source: "password", target: "password" },
              { source: "key", target: "key" },
            ],
          },
        },
        secrets: {
          password: { file: join(directory, "mount-admin-password") },
          key: { file: join(directory, "mount-admin-service-key") },
        },
      }),
    );
    // Prove the real Secret mount is unreadable before launcher ownership preparation.
    await assert.rejects(runDocker([...compose, "run", "--rm", "--no-deps", "bootstrap"]), {
      code: 1,
      stderr: /must be readable regular UTF-8 text/,
    });
    const cli = join(directory, "occ");
    execFileSync("go", ["build", "-o", cli, "./cmd/occ"], { stdio: "pipe" });
    execFileSync(
      cli,
      ["dev", "prepare-bootstrap-mounts", "--directory", directory, "--", ...compose.slice(1)],
      { env: { ...process.env, OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker" }, stdio: "pipe" },
    );
    assert.match(
      (await runDocker([...compose, "run", "--rm", "--no-deps", "bootstrap"])).stdout,
      /credentials-readable/,
    );
    for (const name of ["admin-password", "admin-service-key"]) {
      const input = await open(join(directory, name), "r");
      try {
        const metadata = await input.stat();
        assert.equal(metadata.uid, process.getuid());
        assert.equal(metadata.mode & 0o777, 0o600);
        assert.equal(
          (await input.readFile("utf8")) === (name === "admin-password" ? password : key),
          true,
        );
      } finally {
        await input.close();
      }
    }
  },
);
