import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { withBoundedTeardown } from "../helpers/bounded-teardown.ts";
import { caAndLeaf } from "../helpers/certificates.ts";
import {
  productionTuiProxyCommand,
  productionTuiProxyData,
} from "../helpers/production-tui-proxy.ts";
import { runDocker, waitForDockerLog } from "../helpers/runtime-image-docker.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const image = process.env.OCC_TEST_CODEX_PROBE_IMAGE;

test(
  "mounted production TUI proxy preserves the sign-in gate and HTTP forwarding",
  { skip: image === undefined && "Prepare the Images and Packaging lane for its Node image." },
  async (context) => {
    assert.ok(image);
    assert.ok(process.getuid && process.getgid);
    const t = withBoundedTeardown(context);
    const directory = await temporaryDirectory(t, "oce-production-tui-proxy-");
    const code = join(directory, "code");
    const tls = join(directory, "tls");
    const operator = join(directory, "operator");
    const authority = join(directory, "authority");
    for (const path of [code, tls, operator, authority]) {
      await mkdir(path, { mode: 0o700 });
    }
    const paths = await caAndLeaf(authority, {
      caName: "Production TUI fixture CA",
      commonName: "localhost",
      subjectAltName: "IP:127.0.0.1",
    });
    for (const [path, filename] of [
      [paths.caPath, "ca.pem"],
      [paths.certPath, "tls.crt"],
      [paths.keyPath, "tls.key"],
    ] as const) {
      await writeFile(join(tls, filename), await readFile(path), { mode: 0o600 });
    }
    for (const [filename, source] of Object.entries(await productionTuiProxyData())) {
      await writeFile(join(code, filename), source, { mode: 0o600 });
    }

    // Run the Pod's exact entrypoint with read-only code and TLS mounts and a
    // private writable gate. The witness reaches the origin and proxy only on
    // the container's loopback interface, without publishing any ports.
    const name = `oce-tui-proxy-${randomUUID()}`;
    t.after(async () => {
      const filter = ["--filter", `name=^/${name}$`];
      if ((await runDocker(["ps", "-aq", ...filter])).stdout.trim() !== "") {
        await runDocker(["rm", "--force", name], { timeout: 10_000 });
      }
      assert.equal((await runDocker(["ps", "-aq", ...filter])).stdout.trim(), "");
    });
    const [entrypoint, script] = productionTuiProxyCommand;
    await runDocker([
      "run",
      "--detach",
      "--pull=never",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--volume",
      `${code}:/code:ro`,
      "--volume",
      `${tls}:/tls:ro`,
      "--volume",
      `${operator}:/operator`,
      "--env",
      "TLS_CERT_FILE=/tls/tls.crt",
      "--env",
      "TLS_KEY_FILE=/tls/tls.key",
      "--env",
      "TARGET_URL=http://127.0.0.1:8080",
      "--env",
      "OCC_SIGNIN_PROXY=1",
      "--entrypoint",
      entrypoint,
      image,
      script,
    ]);
    await waitForDockerLog(name, /production-tui HTTPS proxy listening on 8443/);
    const witness = await readFile(
      new URL("../fixtures/production-tui/proxy-observation.ts", import.meta.url),
      "utf8",
    );
    await runDocker(
      ["exec", "-i", name, "node", "--input-type=module", "-"],
      { timeout: 35_000 },
      stripTypeScriptTypes(witness),
    );
    await runDocker(["stop", "--time", "1", name], { timeout: 10_000 });
    const { stdout } = await runDocker(["inspect", "--format", "{{.State.Status}}", name]);
    assert.equal(stdout.trim(), "exited", "Stopping the operator must end its process");
  },
);
