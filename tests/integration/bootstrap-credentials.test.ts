import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  BootstrapInputError,
  bootstrapCredentials,
} from "../../scripts/lib/bootstrap-credentials.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

test("bootstrap reads read-only projected credential inputs without trimming password spaces", async (t) => {
  const directory = await temporaryDirectory(t, "occ-bootstrap-inputs-");
  const password = " preserved password spaces ";
  const serviceKey = `occ_${randomBytes(32).toString("base64url")}`;
  await writeFile(join(directory, "password-target"), `${password}\r\n`, { mode: 0o400 });
  await writeFile(join(directory, "key-target"), serviceKey, { mode: 0o400 });
  await symlink("password-target", join(directory, "password"));
  await symlink("key-target", join(directory, "key"));
  assert.deepEqual(
    await bootstrapCredentials({
      OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE: join(directory, "password"),
      OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE: join(directory, "key"),
    }),
    { password, serviceKey },
  );
});

test("bootstrap rejects padded keys, nonzero base64url pad bits and repeated terminators", async (t) => {
  const directory = await temporaryDirectory(t, "occ-bootstrap-input-refusals-");
  const passwordPath = join(directory, "password");
  const keyPath = join(directory, "key");
  const environment = {
    OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE: passwordPath,
    OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE: keyPath,
  };
  const key = `occ_${randomBytes(32).toString("base64url")}`;
  await writeFile(passwordPath, "valid-admin-password");
  // A 32-byte base64url value has two unused zero bits in its final sextet.
  // Alphabet and length checks alone would accept another spelling of the key.
  for (const value of [key + "=", key.slice(0, -1) + "B", key + "\n\n"]) {
    await writeFile(keyPath, value);
    await assert.rejects(bootstrapCredentials(environment), BootstrapInputError);
  }
});
