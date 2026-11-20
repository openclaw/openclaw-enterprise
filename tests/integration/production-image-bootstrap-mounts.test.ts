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
    if (process.getuid === undefined) {
      throw new Error("The bootstrap mount test requires POSIX UID support.");
    }
    const hostUid = process.getuid();
    const compose: string[] = [];
    const directory = await mkdtemp(join(tmpdir(), "occ-bootstrap-mounts-"));
    t.after(async () => {
      const errors: Error[] = [];
      try {
        if (compose.length > 0) {
          await runDocker([...compose, "down", "--remove-orphans"]);
        }
      } catch (error) {
        errors.push(
          error instanceof Error
            ? error
            : new Error("Docker Compose teardown failed", { cause: error }),
        );
      } finally {
        // Remove the private credential files even if Compose teardown fails.
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (error) {
          errors.push(
            error instanceof Error
              ? error
              : new Error("Private directory cleanup failed", { cause: error }),
          );
        }
      }
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Docker Compose teardown and private directory cleanup failed",
        );
      }
      const [error] = errors;
      if (error !== undefined) {
        throw error;
      }
    });
    const project = `occ-mounts-${randomBytes(6).toString("hex")}`;
    const file = join(directory, "compose.json");
    compose.push("compose", "--project-name", project, "-f", file);
    const reader = hostUid === 1001 ? 1002 : 1001;
    const password = "synthetic-admin-password";
    const key = `occ_${randomBytes(32).toString("base64url")}`;
    for (const [name, value] of Object.entries({
      "admin-password": password,
      "admin-service-key": key,
    })) {
      await writeFile(join(directory, name), value, { mode: 0o600 });
      await writeFile(join(directory, `mount-${name}`), value, { mode: 0o600 });
    }
    const probe = `
      import assert from 'node:assert/strict';
      import { lstat } from 'node:fs/promises';
      import { bootstrapCredentials } from '/app/scripts/lib/bootstrap-credentials.ts';
      const paths = ['/run/secrets/password', '/run/secrets/key'];
      await bootstrapCredentials({
        OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE: paths[0],
        OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE: paths[1],
      });
      // Check ownership in the reader's namespace, where mount UID/GID mapping applies.
      for (const path of paths) {
        const metadata = await lstat(path);
        assert.equal(metadata.isFile(), true);
        assert.equal(metadata.mode & 0o7777, 0o600);
        assert.equal(metadata.uid, process.getuid());
        assert.equal(metadata.gid, process.getgid());
      }
      console.log('credentials-readable');
    `;
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
    // Exercise the Go-built launcher's actual mount-copy ownership preparation.
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
    // The host recovery inputs must keep their ownership, private mode, and contents.
    for (const name of ["admin-password", "admin-service-key"]) {
      const input = await open(join(directory, name), "r");
      try {
        const metadata = await input.stat();
        assert.equal(metadata.uid, hostUid);
        assert.equal(metadata.mode & 0o7777, 0o600);
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
