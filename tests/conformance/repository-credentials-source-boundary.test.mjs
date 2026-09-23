import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyRepositoryCredentialBoundary } from "../../scripts/verify-repository-credentials-boundary.mjs";

const sourceRoot = fileURLToPath(new URL("../../apps/controller/src/", import.meta.url));

async function appendSource(root, file, source, check) {
  const path = join(root, file);
  const previous = await readFile(path, "utf8").catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${previous ?? ""}\n${source}\n`);
  try {
    await check();
  } finally {
    if (previous === undefined) {
      await rm(path);
    } else {
      await writeFile(path, previous);
    }
  }
}

test("credential source boundary rejects new raw capabilities in the real source tree", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "repository-credentials-boundary-"));
  const root = join(temporary, "src");
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await cp(sourceRoot, root, { recursive: true });
  assert.ok((await verifyRepositoryCredentialBoundary(root)) > 0);

  await t.test("type-only imports and ordinary object methods remain valid", () =>
    appendSource(
      root,
      "drivers/repo/credentials/boundary-types.ts",
      `import type * as Http from "node:http";
       import type { RequestOptions } from "node:https";
       export type { Socket } from "node:net";
       export type { IncomingMessage } from "node:http";
       type Fetch = typeof fetch;
       const client = { fetch() { return 1; }, WebSocket: 2 };
       client.fetch(); void client.WebSocket;`,
      () => verifyRepositoryCredentialBoundary(root),
    ),
  );
  await t.test("the outgoing header owner can validate names and values", () =>
    appendSource(
      root,
      "drivers/repo/credentials/transport/request-headers.ts",
      `import { validateHeaderName as checkName, validateHeaderValue as checkValue } from "node:http";
       checkName("accept"); checkValue("accept", "application/json");`,
      () => verifyRepositoryCredentialBoundary(root),
    ),
  );

  await t.test("the platform Driver can render portable session files", () =>
    appendSource(
      root,
      "drivers/repo/github/driver.ts",
      'import { encodeRepositoryCredentialSessionFiles as encodeFiles } from "./credentials/client/config.js"; void encodeFiles;',
      () => verifyRepositoryCredentialBoundary(root),
    ),
  );
  await t.test("the bootstrap can load only the emitted process main", () =>
    appendSource(
      root,
      "repository-credentials.mjs",
      'import { main as emittedMain } from "../dist/repository-credentials.js"; void emittedMain;',
      () => verifyRepositoryCredentialBoundary(root),
    ),
  );

  for (const file of [
    "composition/repository-credentials",
    "drivers/repo/credentials",
    "drivers/repo/github",
    "providers/repository-credentials",
    "repository-credentials.ts",
    "repository-credentials.mjs",
  ]) {
    await t.test(`missing ${file} fails closed`, async () => {
      const path = join(root, file);
      const saved = join(temporary, "missing-source");
      await rename(path, saved);
      try {
        await assert.rejects(verifyRepositoryCredentialBoundary(root), (error) => {
          if (file === "repository-credentials.ts" || file === "repository-credentials.mjs") {
            assert.match(
              error.message,
              /^Repository credential boundary requires security review:\n/,
            );
            assert.ok(
              error.message.split("\n").includes(`Missing credential entrypoint: ${file}`),
              error.message,
            );
          } else {
            assert.equal(error.message, `Missing or invalid credential source root: ${file}`);
          }
          return true;
        });
      } finally {
        await rename(saved, path);
      }
    });
  }

  const cases = [
    [
      "shared client metadata cannot acquire network authority",
      'import { request } from "node:https";',
      /unreviewed runtime import from node:https/,
      "drivers/repo/credentials/client-contracts.ts",
    ],
    [
      "the native hook dispatcher cannot open credential files directly",
      'import { readFile } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises/,
      "drivers/repo/github/credentials/client/hook-dispatch.ts",
    ],
    [
      "the native hook dispatcher cannot create a network sender",
      'import { request } from "node:https";',
      /unreviewed runtime import from node:https/,
      "drivers/repo/github/credentials/client/hook-dispatch.ts",
    ],
    [
      "configuration composition cannot open files outside the protected reader",
      'import { open } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises/,
      "composition/repository-credentials/config.ts",
    ],
    [
      "configuration composition cannot inspect the process user directly",
      "process.getuid?.();",
      /raw process capability/,
      "composition/repository-credentials/config.ts",
    ],
    [
      "the protected reader cannot write files",
      'import { writeFile } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises/,
      "composition/repository-credentials/protected-file.ts",
    ],
    [
      "new composition source is scanned",
      'import { request } from "node:http";',
      /unreviewed runtime import from node:http/,
      "composition/repository-credentials/boundary-regression.ts",
    ],
    [
      "new Provider source is scanned",
      'import { request } from "node:https";',
      /unreviewed runtime import from node:https/,
      "providers/repository-credentials/boundary-regression.ts",
    ],
    [
      "the process entrypoint cannot use a raw network global",
      'fetch("https://example.test");',
      /raw global fetch/,
      "repository-credentials.ts",
    ],
    [
      "the emitted bootstrap cannot use a raw network global",
      'fetch("https://example.test");',
      /raw global fetch/,
      "repository-credentials.mjs",
    ],
    [
      "direct HTTPS request",
      'import { request } from "node:https";',
      /unreviewed runtime import from node:https/,
    ],
    ["bare builtin alias", 'import https from "https";', /unreviewed runtime import from https/],
    [
      "raw re-export",
      'export { request } from "node:http";',
      /unreviewed runtime export from node:http/,
    ],
    ["new network dependency", 'export * from "undici";', /unreviewed runtime export from undici/],
    [
      "mixed type and value import",
      'import { type RequestOptions, request } from "node:https";',
      /unreviewed runtime import from node:https \(request\)/,
    ],
    [
      "inline type import retains its module side effect",
      'import { type Dispatcher } from "undici";',
      /unreviewed runtime import from undici \(<side-effect>\)/,
    ],
    [
      "inline type export retains its module side effect",
      'export { type Dispatcher } from "undici";',
      /unreviewed runtime export from undici \(<side-effect>\)/,
    ],
    ["side-effect import", 'import "node:tls";', /unreviewed runtime import from node:tls/],
    [
      "empty runtime import",
      'import {} from "node:net";',
      /unreviewed runtime import from node:net/,
    ],
    [
      "dynamic raw import",
      'await import("node:http2");',
      /unreviewed runtime import from node:http2/,
    ],
    [
      "nonliteral loader",
      "export const load = (specifier: string) => import(specifier);",
      /nonliteral module loading/,
    ],
    [
      "CommonJS import",
      'import http = require("node:http");',
      /unreviewed runtime import from node:http/,
    ],
    ["fetch alias", "const send = fetch; void send;", /raw global fetch/],
    ["optional fetch", 'fetch?.("https://example.test");', /raw global fetch/],
    ["global property", 'const send = globalThis["fetch"];', /raw global globalThis/],
    ["global destructuring", "const { fetch: send } = globalThis;", /raw global globalThis/],
    ["WebSocket alias", "const Socket = WebSocket;", /raw global WebSocket/],
    ["builtin loader", 'process.getBuiltinModule("https");', /raw process capability/],
    [
      "process alias",
      'const runtime = process; runtime.getBuiltinModule("https");',
      /raw process capability/,
    ],
    ["CommonJS loader", 'require("node:dns");', /raw global require/],
    ["dynamic code", 'Function("return fetch")();', /raw global Function/],
    [
      "filesystem sink",
      'import { writeFile } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises/,
    ],
    ["console sink", 'console.log("credential");', /raw global console/],
    ["process output sink", 'process.stdout.write("credential");', /raw process capability stdout/],
    [
      "process warning sink",
      'process.emitWarning("credential");',
      /raw process capability emitWarning/,
    ],
    [
      "process report sink",
      'process.report.writeReport("/tmp/credential.json");',
      /raw process capability report/,
    ],
    [
      "process execution sink",
      'process.execve("/usr/bin/git", ["git", "status"]);',
      /raw process capability execve/,
    ],
    [
      "raw upstream helper",
      'import { createUpstreamSender } from "./transport/upstream.ts";',
      /raw sender drivers\/repo\/credentials\/transport\/upstream.ts/,
    ],
    [
      "raw provider helper through emitted extension",
      'import { sendProviderRequest } from "../github/credentials/provider-transport/request.js";',
      /raw sender drivers\/repo\/github\/credentials\/provider-transport\/request.ts/,
    ],
    [
      "client command owner",
      'import { launchClient } from "../github/credentials/client/launch.ts";',
      /service code cannot load client command owner/,
    ],
    [
      "unscanned source",
      'import { send } from "../../../../dist/unchecked.js";',
      /runtime import escapes credential source/,
    ],
    [
      "listener cannot become sender",
      'import { request as rawRequest } from "node:https";',
      /unreviewed runtime import from node:https \(request\)/,
      "drivers/repo/credentials/server.ts",
    ],
    [
      "header validator cannot become sender",
      'import { request as rawRequest } from "node:http";',
      /unreviewed runtime import from node:http \(request\)/,
      "drivers/repo/credentials/transport/request-headers.ts",
    ],
    [
      "unrelated controller source is not part of the credential boundary",
      'import { loadConfiguration } from "../../composition/installation-config.ts";',
      /runtime import has no scanned credential source/,
    ],
    [
      "the platform Driver cannot load private client files",
      'import { readClientConfiguration as readClient } from "./credentials/client/config.ts";',
      /service code cannot load client command owner/,
      "drivers/repo/github/driver.ts",
    ],
    [
      "the encoder exception cannot re-export client code",
      'export { encodeRepositoryCredentialSessionFiles } from "./credentials/client/config.ts";',
      /service code cannot load client command owner/,
      "drivers/repo/github/driver.ts",
    ],
    [
      "the platform Driver cannot spawn client commands",
      'import { launchClient } from "./credentials/client/launch.ts";',
      /service code cannot load client command owner/,
      "drivers/repo/github/driver.ts",
    ],
    [
      "the platform Driver cannot import another platform capability",
      'import { PostgresPlatformState } from "@openclaw-enterprise/occ";',
      /unreviewed runtime import from @openclaw-enterprise\/occ/,
      "drivers/repo/github/driver.ts",
    ],
    [
      "the bootstrap cannot load a different emitted module",
      'import { main as unrelatedMain } from "../dist/main.js";',
      /runtime import escapes credential source/,
      "repository-credentials.mjs",
    ],
    [
      "the bootstrap cannot load another emitted binding",
      'import { runService } from "../dist/repository-credentials.js";',
      /runtime import escapes credential source/,
      "repository-credentials.mjs",
    ],
    [
      "the bootstrap cannot re-export its emitted main",
      'export { main } from "../dist/repository-credentials.js";',
      /runtime import escapes credential source/,
      "repository-credentials.mjs",
    ],
    [
      "other source cannot use the emitted bootstrap exception",
      'import { main } from "../dist/repository-credentials.js";',
      /runtime import escapes credential source/,
      "repository-credentials.ts",
    ],
    [
      "the control client cannot send HTTPS traffic",
      'import { request as sendHttps } from "node:https";',
      /unreviewed runtime import from node:https/,
      "providers/repository-credentials/control-client.ts",
    ],
    [
      "the control client is available only to its reviewed consumers",
      'import { UnixRepositoryCredentialControlClient } from "../../../providers/repository-credentials/control-client.ts";',
      /raw sender providers\/repository-credentials\/control-client.ts/,
    ],
    [
      "registry loading cannot write files",
      'import { writeFile } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises/,
      "composition/repository-credentials/registry.ts",
    ],
    [
      "public CA composition cannot import an additional file reader",
      'import { readFile } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises/,
      "composition/repository-credentials/platform.ts",
    ],
    [
      "projected inputs cannot remove directories recursively",
      'import { rm } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises/,
      "composition/repository-credentials/projected-inputs.ts",
    ],
    [
      "socket recovery cannot create raw listeners",
      'import { createServer as rawServer } from "node:net";',
      /unreviewed runtime import from node:net/,
      "drivers/repo/credentials/server.ts",
    ],
    [
      "the platform composition cannot re-export its local control client",
      "export { UnixRepositoryCredentialControlClient };",
      /raw I\/O binding cannot be re-exported/,
      "composition/repository-credentials/platform.ts",
    ],
    [
      "the platform Driver cannot re-export its local encoder",
      "export { encodeRepositoryCredentialSessionFiles };",
      /raw I\/O binding cannot be re-exported/,
      "drivers/repo/github/driver.ts",
    ],
    [
      "the bootstrap cannot re-export its local emitted main",
      "export { main };",
      /raw I\/O binding cannot be re-exported/,
      "repository-credentials.mjs",
    ],
    [
      "the Provider transport cannot re-export its local raw sender",
      "export { sendProviderRequest };",
      /raw I\/O binding cannot be re-exported/,
      "drivers/repo/github/credentials/provider-transport.ts",
    ],
    [
      "the Agent transport cannot expose its local sender through a type assertion",
      "export const rawSender = createUpstreamSender as typeof createUpstreamSender;",
      /raw I\/O binding cannot be re-exported/,
      "drivers/repo/credentials/transport/agent.ts",
    ],
    [
      "an emitted-extension alias cannot hide a restricted default export",
      'import { UnixRepositoryCredentialControlClient as Control } from "../../providers/repository-credentials/control-client.js"; export default Control satisfies typeof Control;',
      /raw I\/O binding cannot be re-exported/,
      "composition/repository-credentials/platform.ts",
    ],
    [
      "approved sender cannot re-export raw HTTPS",
      "export { httpsRequest as rawRequest };",
      /raw I\/O binding cannot be re-exported/,
      "drivers/repo/github/credentials/provider-transport/request.ts",
    ],
    [
      "a type assertion cannot hide an exported raw sender",
      "export const rawRequest = httpsRequest as typeof httpsRequest;",
      /raw I\/O binding cannot be re-exported/,
      "drivers/repo/github/credentials/provider-transport/request.ts",
    ],
    [
      "a default export cannot hide an asserted raw sender",
      "export default httpsRequest satisfies typeof httpsRequest;",
      /raw I\/O binding cannot be re-exported/,
      "drivers/repo/github/credentials/provider-transport/request.ts",
    ],
  ];
  for (const [
    label,
    source,
    expected,
    file = "drivers/repo/credentials/boundary-regression.ts",
  ] of cases) {
    await t.test(label, () =>
      appendSource(root, file, source, () =>
        assert.rejects(verifyRepositoryCredentialBoundary(root), (error) => {
          assert.match(error.message, /Repository credential boundary requires security review/);
          assert.ok(error.message.includes(`${file}:`), error.message);
          assert.match(error.message, expected);
          return true;
        }),
      ),
    );
  }
});
