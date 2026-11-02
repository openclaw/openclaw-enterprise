import assert from "node:assert/strict";
import { cp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parsers } from "prettier/plugins/typescript";
import { verifyRepositoryCredentialBoundary as verify } from "../../scripts/verify-repository-credentials-boundary.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const sourceRoot = fileURLToPath(new URL("../../apps/controller/src/", import.meta.url));
const sharedFields = "composition/installation-fields.ts";
const installation = "drivers/repo/github/installation.ts";
const preparedConfiguration = "drivers/repo/github/credentials/prepared-configuration.ts";
const preparedGit = "drivers/repo/github/credentials/prepared-repository-git.ts";
const entrypoints = ["repository-credentials.ts", "repository-credentials.mjs", sharedFields];

async function appendSource(root, file, source, check) {
  const path = join(root, file);
  const previous = await readFile(path, "utf8").catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${previous ?? ""}\n${source}\n`);
  try {
    await check();
  } finally {
    await (previous === undefined ? rm(path) : writeFile(path, previous));
  }
}

test("credential source boundary rejects new raw capabilities in the real source tree", async (t) => {
  // Each check re-parses every credential source, but a case changes one file. The verifier
  // never mutates the AST, so this test reuses the real parser's output by source text.
  const parse = parsers.typescript.parse.bind(parsers.typescript);
  const parsed = new Map();
  t.mock.method(parsers.typescript, "parse", (text, ...options) => {
    if (options.length) {
      return parse(text, ...options);
    }
    if (!parsed.has(text)) {
      parsed.set(text, parse(text));
    }
    return parsed.get(text);
  });
  const temporary = await temporaryDirectory(t, "repository-credentials-boundary-");
  const root = join(temporary, "src");
  await cp(sourceRoot, root, { recursive: true });
  assert.ok((await verify(root)) > 0);

  for (const [label, file, source] of [
    [
      "shared fields admit their exact pure dependencies",
      sharedFields,
      'import { asRecord as record, isNonEmptyString as nonemptyString } from "@openclaw-enterprise/utils"; import { isAbsolute as absolute } from "node:path"; void record; void nonemptyString; void absolute;',
    ],
    [
      "prepared configuration admits the exact field helpers",
      preparedConfiguration,
      'import { object as record, closed as check, nonempty as text } from "../../../../composition/installation-fields.ts"; void record; void check; void text;',
    ],
    [
      "repository installation admits its exact field helpers",
      installation,
      'import { object as record, closed as check, nonempty as text, openShellRepositoryConfiguration as repository } from "../../../composition/installation-fields.ts"; void record; void check; void text; void repository;',
    ],
    [
      "prepared Git admits its existing transaction class and worker identity",
      preparedGit,
      'import { CredentialDeliveries as Deliveries } from "@openclaw-enterprise/occ"; import { randomUUID as uuid } from "node:crypto"; void Deliveries; void uuid;',
    ],
    [
      "repository installation admits hashing and its recipient error",
      installation,
      'import { createHash as hash } from "node:crypto"; import { SandboxRepositoryRecipientUnverifiedError as RecipientError } from "@openclaw-enterprise/occ"; void hash; void RecipientError;',
    ],

    [
      "type-only imports and ordinary object methods remain valid",
      "drivers/repo/credentials/boundary-types.ts",
      `import type * as Http from "node:http";
       import type { RequestOptions } from "node:https";
       export type { Socket } from "node:net";
       export type { IncomingMessage } from "node:http";
       type Fetch = typeof fetch;
       const client = { fetch() { return 1; }, WebSocket: 2 };
       client.fetch(); void client.WebSocket;`,
    ],
    [
      "the outgoing header owner can validate names and values",
      "drivers/repo/credentials/transport/request-headers.ts",
      `import { validateHeaderName as checkName, validateHeaderValue as checkValue } from "node:http";
       checkName("accept"); checkValue("accept", "application/json");`,
    ],
    [
      "the platform Driver can render portable session files",
      "drivers/repo/github/driver.ts",
      'import { encodeRepositoryCredentialSessionFiles as encodeFiles } from "./credentials/client/config.js"; void encodeFiles;',
    ],
    [
      "the bootstrap can load only the emitted process main",
      "repository-credentials.mjs",
      'import { main as emittedMain } from "../dist/repository-credentials.js"; void emittedMain;',
    ],
  ]) {
    await t.test(label, () => appendSource(root, file, source, () => verify(root)));
  }

  for (const file of [
    "composition/repository-credentials",
    "drivers/repo/credentials",
    "drivers/repo/github",
    "backends/repository-credentials",
    ...entrypoints,
  ]) {
    await t.test(`missing ${file} fails closed`, async () => {
      const path = join(root, file);
      const saved = join(temporary, "missing-source");
      await rename(path, saved);
      try {
        await assert.rejects(verify(root), (error) => {
          if (entrypoints.includes(file)) {
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

  await t.test("a symlinked credential source fails closed", async () => {
    const path = join(root, "drivers/repo/credentials/linked.ts");
    await symlink("sessions.ts", path);
    try {
      await assert.rejects(verify(root), {
        message: `Credential source must not be a symlink: ${path}`,
      });
    } finally {
      await rm(path);
    }
  });

  await t.test("the shared field owner cannot be replaced with a symlink", async () => {
    const path = join(root, sharedFields);
    const saved = join(temporary, "shared-fields.ts");
    await rename(path, saved);
    try {
      await symlink(saved, path);
      await assert.rejects(verify(root), {
        message: `Invalid credential entrypoint: ${sharedFields}`,
      });
    } finally {
      await rm(path);
      await rename(saved, path);
    }
  });

  const cases = [
    [
      "issuer trust identity cannot import private keys",
      'import { createPrivateKey } from "node:crypto";',
      /unreviewed runtime import from node:crypto \(createPrivateKey\)/,
      "drivers/repo/github/credentials/origin.ts",
    ],
    [
      "shared fields reject direct file IO",
      'import { readFile } from "node:fs/promises";',
      /unreviewed shared field validation/,
      sharedFields,
    ],
    [
      "shared fields reject remote IO",
      'import { request } from "node:https";',
      /unreviewed shared field validation/,
      sharedFields,
    ],
    [
      "shared fields reject ordinary builtin expansion",
      'import { hostname } from "node:os";',
      /unreviewed shared field validation/,
      sharedFields,
    ],
    [
      "shared fields reject adjacent utility symbols",
      'import { deepFreeze } from "@openclaw-enterprise/utils";',
      /unreviewed shared field validation/,
      sharedFields,
    ],
    [
      "shared fields reject adjacent path symbols",
      'import { resolve } from "node:path";',
      /unreviewed shared field validation/,
      sharedFields,
    ],
    [
      "shared fields reject relative sender",
      'import { sendProviderRequest } from "../drivers/repo/github/credentials/provider-transport/request.ts";',
      /unreviewed shared field validation/,
      sharedFields,
    ],
    [
      "shared fields reject dynamic import",
      'void import("node:path");',
      /unreviewed shared field validation/,
      sharedFields,
    ],
    [
      "shared fields reject side-effect import",
      'import "@openclaw-enterprise/utils";',
      /unreviewed shared field validation/,
      sharedFields,
    ],
    [
      "shared fields reject namespace import",
      'import * as utils from "@openclaw-enterprise/utils";',
      /unreviewed shared field validation/,
      sharedFields,
    ],
    [
      "shared fields reject direct re-export",
      'export { asRecord } from "@openclaw-enterprise/utils";',
      /unreviewed shared field validation/,
      sharedFields,
    ],
    [
      "shared fields reject environment access",
      "void process.env;",
      /raw process capability env/,
      sharedFields,
    ],
    [
      "shared fields reject global network access",
      'void fetch("https://example.invalid");',
      /raw global fetch/,
      sharedFields,
    ],
    [
      "shared fields reject local dependency re-exports",
      "export { asRecord };",
      /raw I\/O binding cannot be re-exported/,
      sharedFields,
    ],
    [
      "field consumers reject new consumer",
      'import { object } from "../../../composition/installation-fields.ts";',
      /unreviewed shared field validation/,
      "drivers/repo/github/new-consumer.ts",
    ],
    [
      "field consumers reject extra symbol",
      'import { egressAuthorityConfiguration } from "../../../composition/installation-fields.ts";',
      /unreviewed shared field validation/,
      installation,
    ],
    [
      "field consumers reject repository parser at the wrong caller",
      'import { openShellRepositoryConfiguration } from "../../../../composition/installation-fields.ts";',
      /unreviewed shared field validation/,
      preparedConfiguration,
    ],
    [
      "field consumers reject emitted extension",
      'import { object as another } from "../../../composition/installation-fields.js";',
      /unreviewed shared field validation/,
      installation,
    ],
    [
      "field consumers reject alternate path",
      'import { object as another } from "../../../composition/./installation-fields.ts";',
      /unreviewed shared field validation/,
      installation,
    ],
    [
      "field consumers reject direct helper re-export",
      'export { object } from "../../../composition/installation-fields.ts";',
      /unreviewed shared field validation/,
      installation,
    ],
    [
      "field consumers reject dynamic helper import",
      'void import("../../../composition/installation-fields.ts");',
      /unreviewed shared field validation/,
      installation,
    ],
    [
      "field consumers reject local helper re-export",
      "export { object };",
      /raw I\/O binding cannot be re-exported/,
      installation,
    ],
    [
      "old startup import stays denied for installation",
      'import { startupConfiguration } from "../../../composition/startup-file.ts";',
      /runtime import has no scanned credential source/,
      installation,
    ],
    [
      "direct IO stays denied for installation",
      'import { readFile } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises/,
      installation,
    ],
    [
      "old startup import stays denied for preparedConfiguration",
      'import { startupConfiguration } from "../../../../composition/startup-file.ts";',
      /runtime import has no scanned credential source/,
      preparedConfiguration,
    ],
    [
      "direct IO stays denied for preparedConfiguration",
      'import { readFile } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises/,
      preparedConfiguration,
    ],
    [
      "transport composition stays outside the credential graph",
      'import { openShellProxyConfiguration } from "../../egress-proxy/openshell-configuration.ts";',
      /runtime import has no scanned credential source/,
      installation,
    ],
    [
      "adjacent crypto symbol stays denied for installation",
      'import { createPrivateKey } from "node:crypto";',
      /unreviewed runtime import from node:crypto/,
      installation,
    ],
    [
      "adjacent OCC class stays denied for installation",
      'import { InstalledDriver } from "@openclaw-enterprise/occ";',
      /unreviewed runtime import from @openclaw-enterprise\/occ/,
      installation,
    ],
    [
      "remote IO stays denied for installation",
      'import { request } from "node:https";',
      /unreviewed runtime import from node:https/,
      installation,
    ],
    [
      "adjacent crypto symbol stays denied for preparedGit",
      'import { createPrivateKey } from "node:crypto";',
      /unreviewed runtime import from node:crypto/,
      preparedGit,
    ],
    [
      "adjacent OCC class stays denied for preparedGit",
      'import { InstalledDriver } from "@openclaw-enterprise/occ";',
      /unreviewed runtime import from @openclaw-enterprise\/occ/,
      preparedGit,
    ],
    [
      "remote IO stays denied for preparedGit",
      'import { request } from "node:https";',
      /unreviewed runtime import from node:https/,
      preparedGit,
    ],
    [
      "transaction class remains limited to its existing caller",
      'import { CredentialDeliveries } from "@openclaw-enterprise/occ";',
      /unreviewed runtime import from @openclaw-enterprise\/occ/,
      installation,
    ],
    [
      "recipient error remains limited to its existing caller",
      'import { SandboxRepositoryRecipientUnverifiedError } from "@openclaw-enterprise/occ";',
      /unreviewed runtime import from @openclaw-enterprise\/occ/,
      preparedGit,
    ],
    [
      "transaction class cannot be re-exported directly",
      'export { CredentialDeliveries } from "@openclaw-enterprise/occ";',
      /unreviewed runtime export/,
      preparedGit,
    ],
    [
      "transaction class cannot be re-exported locally",
      "export { CredentialDeliveries };",
      /raw I\/O binding cannot be re-exported/,
      preparedGit,
    ],
    [
      "configuration hash cannot be re-exported locally",
      "export { createHash };",
      /raw I\/O binding cannot be re-exported/,
      installation,
    ],

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
      "client code cannot load a service owner",
      'import { bearerDigest } from "../../../credentials/sessions.ts";',
      /client runtime cannot load service owner drivers\/repo\/credentials\/sessions.ts/,
      "drivers/repo/github/credentials/client/router.ts",
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
      "the anonymous reader cannot load token custody",
      'import "../credentials/material.js";',
      /public GitHub reader and repository credential owners cannot load one another/,
      "drivers/repo/github/public-read/server.ts",
    ],
    [
      "credential owners cannot delegate to the anonymous listener",
      'import "../public-read/server.js";',
      /public GitHub reader and repository credential owners cannot load one another/,
      "drivers/repo/github/credentials/static-token.ts",
    ],
    [
      "the anonymous reader cannot read credential files",
      'import { readFile } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises/,
      "drivers/repo/github/public-read/server.ts",
    ],
    [
      "new composition source is scanned",
      'import { request } from "node:http";',
      /unreviewed runtime import from node:http/,
      "composition/repository-credentials/boundary-regression.ts",
    ],
    [
      "the shared protected Git installation predicate cannot become a sender",
      'import { request } from "node:https";',
      /unreviewed runtime import from node:https/,
      "drivers/repo/credentials/protected-repository-git-installation.ts",
    ],
    [
      "new Backend source is scanned",
      'import { request } from "node:https";',
      /unreviewed runtime import from node:https/,
      "backends/repository-credentials/boundary-regression.ts",
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
      "a reviewed sender consumer cannot re-export the sender",
      'export { createUpstreamSender } from "./upstream.ts";',
      /raw sender drivers\/repo\/credentials\/transport\/upstream.ts is not reviewed for drivers\/repo\/credentials\/transport\/agent.ts/,
      "drivers/repo/credentials/transport/agent.ts",
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
    // The encoder must come first: the exception checks names[0], so this order is what
    // guards its single-name rule.
    [
      "the encoder exception cannot carry other client bindings",
      'import { encodeRepositoryCredentialSessionFiles as encode, readClientConfiguration as readClient } from "./credentials/client/config.ts";',
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
      "backends/repository-credentials/control-client.ts",
    ],
    [
      "the control client is available only to its reviewed consumers",
      'import { UnixRepositoryCredentialControlClient } from "../../../backends/repository-credentials/control-client.ts";',
      /raw sender backends\/repository-credentials\/control-client.ts/,
    ],
    [
      "the journal client cannot send HTTPS traffic",
      'import { request as sendHttps } from "node:https";',
      /unreviewed runtime import from node:https/,
      "drivers/repo/credentials/receipt-client.ts",
    ],
    [
      "the journal client is available only to its reviewed consumer",
      'import { RepositoryReceiptClient } from "./receipt-client.ts";',
      /raw sender drivers\/repo\/credentials\/receipt-client.ts/,
    ],
    [
      "the journal listener cannot create outbound HTTP requests",
      'import { request as rawRequest } from "node:http";',
      /unreviewed runtime import from node:http \(request\)/,
      "backends/repository-credentials/receipt-server.ts",
    ],
    [
      "receipt handling no longer owns the raw listener or socket files",
      'import { createServer } from "node:http";',
      /unreviewed runtime import from node:http \(createServer\)/,
      "backends/repository-credentials/receipt-server.ts",
    ],
    [
      "the private socket owner cannot become an HTTP sender",
      'import { request } from "node:http";',
      /unreviewed runtime import from node:http \(request\)/,
      "backends/repository-credentials/private-request-server.ts",
    ],
    [
      "an unreviewed caller cannot open a private request listener",
      'import { servePrivateRepositoryRequest } from "../../../backends/repository-credentials/private-request-server.js";',
      /private-request-server.ts is not reviewed for/,
    ],
    [
      "the broker use client cannot load the worker App and custody key owner",
      'await import("../../../../backends/repository-credentials/prepared-git-owner.js");',
      /prepared-git-owner.ts is not reviewed for/,
      "drivers/repo/github/credentials/warm-use.ts",
    ],
    [
      "credential code cannot bypass the prepared Git owner to use its store",
      'import { PreparedRepositoryGitStore } from "../github/credentials/prepared-repository-git.js";',
      /prepared-repository-git.ts is not reviewed for/,
    ],
    [
      "credential code cannot acquire a prepared Git use outside its selected factory",
      'import { authorizePreparedGitSend } from "../github/credentials/warm-use.js";',
      /warm-use.ts is not reviewed for/,
    ],
    [
      "the prepared use client cannot export its raw HTTP capability",
      "export { request };",
      /raw I\/O binding cannot be re-exported/,
      "drivers/repo/github/credentials/warm-use.ts",
    ],
    [
      "configuration cannot replace the public CA loader with an unbounded file read",
      'import { readFile } from "node:fs/promises";',
      /unreviewed runtime import from node:fs\/promises \(readFile\)/,
      "composition/repository-credentials/config.ts",
    ],
    [
      "an unreviewed caller cannot acquire the projected public CA reader",
      'import { loadPublicCa } from "../../../composition/repository-credentials/public-ca.js";',
      /public-ca.ts is not reviewed for/,
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
      'import { UnixRepositoryCredentialControlClient as Control } from "../../backends/repository-credentials/control-client.js"; export default Control satisfies typeof Control;',
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
        assert.rejects(verify(root), (error) => {
          assert.match(error.message, /Repository credential boundary requires security review/);
          assert.ok(error.message.includes(`${file}:`), error.message);
          assert.match(error.message, expected);
          return true;
        }),
      ),
    );
  }
});
