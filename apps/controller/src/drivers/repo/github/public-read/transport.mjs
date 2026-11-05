import { spawn, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Agent, request } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// Codex composes these startup inputs with its process-local interception CA.
// Read them again inside each tool invocation, before selecting child TLS trust.
const caEnvironment = [
  "CODEX_CA_CERTIFICATE",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSL_CAINFO",
  "CARGO_HTTP_CAINFO",
  "PIP_CERT",
  "BUNDLE_SSL_CA_CERT",
  "npm_config_cafile",
  "NPM_CONFIG_CAFILE",
];
const trustLimit = 4 * 1024 * 1024;
let trustDirectory;
let refusalPhase = "invocation";

function refusalReceipt(error) {
  // Never serialize the exception: filesystem/OpenSSL messages can contain paths,
  // input bytes or secrets. Both fields have a closed output vocabulary.
  const phase = [
    "invocation",
    "configuration",
    "authorization",
    "trust-input",
    "trust-composition",
    "trust-files",
    "child-setup",
    "child-dispatch",
  ].includes(refusalPhase)
    ? refusalPhase
    : "unknown";
  const codes = [
    "ENOENT",
    "EACCES",
    "EPERM",
    "EISDIR",
    "ENOTDIR",
    "ELOOP",
    "ENOSPC",
    "EROFS",
    "EMFILE",
    "ENFILE",
    "ERR_INVALID_ARG_TYPE",
    "ERR_INVALID_ARG_VALUE",
    "ERR_OSSL_PEM_NO_START_LINE",
  ];
  let code = "unknown";
  if (codes.includes(error?.code)) {
    code = error.code;
  } else if (error instanceof SyntaxError) {
    code = "SYNTAX_ERROR";
  } else if (error instanceof TypeError) {
    code = "TYPE_ERROR";
  }
  process.stderr.write(`public-git-refusal:${phase}:${code}\n`);
}

function readTrust(path, limit) {
  refusalPhase = "trust-input";
  if (!isAbsolute(path ?? "")) {
    throw new Error("TLS trust requires an absolute file path.");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) {
      throw new Error("TLS trust exceeds its file bound.");
    }
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) {
        break;
      }
      length += count;
    }
    if (length > limit) {
      throw new Error("TLS trust exceeds its file bound.");
    }
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function composeTrust(readerTrust) {
  const certificates = new Map();
  let size = 0;
  function append(pem) {
    refusalPhase = "trust-composition";
    size += Buffer.byteLength(pem);
    if (size > trustLimit) {
      throw new Error("TLS trust exceeds its aggregate bound.");
    }
    // Mozilla/curl and system bundles can carry # comments and underlined
    // certificate labels. Strip only that metadata; reject all other payloads.
    const certificatesOnly = pem
      .replace(/^#[^\r\n]*(?:\r?\n|$)/gm, "")
      .replace(/^[^\r\n]{1,256}\r?\n={3,}\r?\n/gm, "");
    const blocks = certificatesOnly.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    );
    if (
      !blocks?.length ||
      certificatesOnly
        .replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "")
        .trim()
    ) {
      throw new Error("TLS trust must contain only public certificates.");
    }
    for (const block of blocks) {
      const certificate = new X509Certificate(block);
      certificates.set(certificate.raw.toString("base64"), certificate.toString());
    }
  }
  append(readerTrust);
  for (const file of new Set(caEnvironment.map((key) => process.env[key]).filter(Boolean))) {
    append(readTrust(file, 1024 * 1024));
  }
  refusalPhase = "trust-composition";
  const bundle = [...certificates.values()].join("\n");
  if (Buffer.byteLength(bundle) > 1024 * 1024) {
    throw new Error("TLS trust exceeds its bundle bound.");
  }
  return bundle;
}

function operationTrust(config) {
  const bundle = composeTrust(readTrust(config.caPath, 1024 * 1024));
  refusalPhase = "trust-files";
  // A restricted native profile admits the runtime workspace, not ambient
  // /tmp. Git may run its helper inside .git, so do not use the helper cwd.
  // A selected runtime root is authoritative; never retry elsewhere.
  const root = process.env.OPENCLAW_WORKSPACE_DIR ?? tmpdir();
  if (!isAbsolute(root)) {
    throw new Error("Operation trust requires an absolute scratch root.");
  }
  trustDirectory = mkdtempSync(join(root, "oce-public-trust-"));
  chmodSync(trustDirectory, 0o700);
  const file = join(trustDirectory, "ca.pem");
  writeFileSync(file, bundle, { mode: 0o400, flag: "wx" });
  return file;
}

function cleanupTrust() {
  if (trustDirectory !== undefined) {
    rmSync(trustDirectory, { recursive: true, force: true });
    trustDirectory = undefined;
  }
}
process.once("exit", cleanupTrust);

function authorization(config) {
  refusalPhase = "authorization";
  return capability(
    config.capabilityEnvironment
      ? process.env.OCE_PUBLIC_GITHUB_READ_CAPABILITY
      : readFileSync(config.capabilityPath, "utf8").trim(),
    Boolean(config.capabilityEnvironment),
  );
}

function responseMetadata(status, rawHeaders, route) {
  const links = rawHeaders.filter(
    (_, index) => index % 2 && rawHeaders[index - 1].toLowerCase() === "link",
  );
  if (links.length > 1) {
    throw new Error("Ambiguous API pagination metadata.");
  }
  const link = links.length ? links[0].trim() : null;
  if (link !== null) {
    if (!link || link.length > 8192) {
      throw new Error("API pagination metadata exceeds its bound.");
    }
    const relations = new Set();
    for (const entry of link.split(/,\s*/)) {
      const match = /^<([^>]+)>;\s*rel="(next|prev|first|last)"$/.exec(entry);
      if (!match || relations.has(match[2])) {
        throw new Error("Invalid API pagination metadata.");
      }
      validateApiRoute(match[1]);
      if (match[1].split("?")[0] !== route.split("?")[0]) {
        throw new Error("API pagination changed its resource.");
      }
      relations.add(match[2]);
    }
  }
  return { status, link };
}

// Serialized into a fixed, isolated Node child. Only bounded stdin carries
// authorization and public trust; no path-based CA carrier or protocol shim.
async function apiClient() {
  const input = [];
  let inputSize = 0;
  for await (const chunk of process.stdin) {
    inputSize += chunk.length;
    if (inputSize > 4 * 1024 * 1024) {
      throw new Error("API input exceeds its bound.");
    }
    input.push(chunk);
  }
  const { endpoint, route, token, ca, defaults, proxy, metadata } = JSON.parse(
    Buffer.concat(input),
  );
  setDefaultCACertificates([...defaults, ca]);
  const agent = new Agent({
    ca,
    rejectUnauthorized: true,
    keepAlive: false,
    maxCachedSessions: 0,
    proxyEnv: { https_proxy: proxy, HTTPS_PROXY: proxy, no_proxy: "", NO_PROXY: "" },
  });
  try {
    await new Promise((resolve, reject) => {
      let headerSize = 0;
      const headers = (response) => {
        headerSize += Buffer.byteLength(
          `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n\r\n`,
          "latin1",
        );
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          headerSize += Buffer.byteLength(
            response.rawHeaders[index] + ": " + response.rawHeaders[index + 1] + "\r\n",
            "latin1",
          );
        }
        if (headerSize > 16 * 1024) {
          throw new Error("API response headers exceed their bound.");
        }
      };
      const req = request(
        endpoint + route,
        {
          agent,
          method: "GET",
          headers: { authorization: "Bearer " + token },
          maxHeaderSize: 16 * 1024,
          insecureHTTPParser: false,
          timeout: 24_000,
        },
        (response) => {
          const chunks = [];
          let size = 0;
          let details;
          try {
            headers(response);
            if (response.statusCode < 200 || response.statusCode >= 300) {
              throw Object.assign(new Error("Unsuccessful API response."), {
                exitCode: response.statusCode >= 400 ? 22 : 1,
              });
            }
            if (metadata) {
              details = responseMetadata(response.statusCode, response.rawHeaders, route);
            }
          } catch (error) {
            response.destroy();
            reject(error);
            return;
          }
          response.on("error", reject);
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 12 * 1024 * 1024) {
              response.destroy(new Error("API body exceeds its bound."));
            } else {
              chunks.push(chunk);
            }
          });
          response.on("end", () => {
            try {
              const body = Buffer.concat(chunks);
              process.stdout.write(
                metadata
                  ? JSON.stringify({ ...details, body: JSON.parse(body.toString("utf8")) }) + "\n"
                  : body,
              );
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("information", (response) => {
        try {
          headers(response);
        } catch (error) {
          req.destroy(error);
        }
      });
      req.on("upgrade", (_response, socket) => {
        socket.destroy();
        reject(new Error("API upgrade refused."));
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    agent.destroy();
  }
}

function runChild(binary, args, env, input) {
  refusalPhase = "child-dispatch";
  const child = spawn(binary, args, {
    env,
    stdio: input === undefined ? "inherit" : ["pipe", "pipe", "pipe"],
  });
  refusalPhase = "child-setup";
  const chunks = [];
  let responseSize = 0;
  let invalidResponse = false;
  let timedOut = false;
  let requestedSignal;
  // The parent owns the whole operation, including DNS and pending CONNECT
  // sockets not yet assigned to the Node request. Process death closes them all.
  const deadline =
    input === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, 24_000);
  deadline?.unref();
  if (input !== undefined) {
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.stderr.resume(); // Never forward Node/OpenSSL errors or startup diagnostics.
    child.stdout.on("data", (chunk) => {
      responseSize += chunk.length;
      if (responseSize > 12 * 1024 * 1024 + 16 * 1024) {
        invalidResponse = true;
        child.kill("SIGTERM");
      } else {
        chunks.push(chunk);
      }
    });
  }
  const term = () => {
    requestedSignal = "SIGTERM";
    child.kill(requestedSignal);
  };
  const interrupt = () => {
    requestedSignal = "SIGINT";
    child.kill(requestedSignal);
  };
  process.on("SIGTERM", term);
  process.on("SIGINT", interrupt);
  child.once("error", (error) => {
    process.stderr.write("The managed public reader child could not start.\n");
    refusalPhase = "child-dispatch";
    refusalReceipt(error);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    clearTimeout(deadline);
    process.off("SIGTERM", term);
    process.off("SIGINT", interrupt);
    cleanupTrust();
    if (timedOut) {
      process.stderr.write("The managed public API read timed out.\n");
      process.exitCode = 28;
    } else if (requestedSignal !== undefined) {
      process.kill(process.pid, requestedSignal);
    } else if (invalidResponse) {
      process.stderr.write("The managed public API read refused the response.\n");
      process.exitCode = 1;
    } else if (signal) {
      process.kill(process.pid, signal);
    } else if (input !== undefined && code === 0) {
      process.stdout.write(Buffer.concat(chunks));
    } else {
      if (input !== undefined) {
        process.stderr.write("The managed public API read refused the response.\n");
      }
      process.exitCode = code !== null && code >= 0 ? code : 1;
    }
  });
}

function validateApiRoute(route) {
  refusalPhase = "invocation";
  // Origin-form only; the reader validates supported resources and query fields.
  // Reject dot/encoded path segments before URL normalization can change them.
  if (typeof route !== "string" || route.length > 2048 || /[^\x21-\x7e]|[\\#]/.test(route)) {
    throw new Error("A reader-relative API route is required.");
  }
  const [pathname, , extra] = route.split("?");
  if (
    extra !== undefined ||
    !/^\/repos\/[a-z\d][a-z\d-]{0,38}\/[a-z\d._-]{1,100}(?:\/[a-z\d._-]{1,100})*$/i.test(
      pathname,
    ) ||
    pathname.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("A reader-relative API route is required.");
  }
}

function apiGet(route, metadata = false) {
  validateApiRoute(route);
  const config = configuration(process.env.OCE_PUBLIC_GITHUB_READ_CONFIG);
  const token = authorization(config);
  const ca = composeTrust(readTrust(config.caPath, 1024 * 1024));
  const env = process.env;
  const selected = env.https_proxy ?? env.HTTPS_PROXY ?? env.all_proxy ?? env.ALL_PROXY ?? "";
  let proxy = "";
  if (selected !== "") {
    const parsed = new URL(selected);
    if (
      !/^https?:\/\//.test(selected) ||
      !["http:", "https:"].includes(parsed.protocol) ||
      Array.from(selected).some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      ) ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("Unsupported API proxy.");
    }
    proxy = parsed.href;
  }
  // Preserve Node defaults plus the OS roots curl used for the HTTPS proxy leg
  // before stripping child startup controls. Origin trust remains explicit ca.
  const input = JSON.stringify({
    endpoint: config.endpoint,
    route,
    token,
    ca,
    defaults: [...new Set([...getCACertificates("default"), ...getCACertificates("system")])],
    proxy,
    metadata,
  });
  if (Buffer.byteLength(input) > 4 * 1024 * 1024) {
    throw new Error("API input exceeds its bound.");
  }
  const program = `import { Agent, request } from "node:https";
import { setDefaultCACertificates } from "node:tls";
let refusalPhase;
${validateApiRoute.toString()}
${responseMetadata.toString()}
(${apiClient.toString()})().catch(error => {
  const tls = ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(error?.code);
  process.exitCode = tls ? 60 : error?.exitCode === 22 ? 22 : 1;
});`;
  // No inherited Node options/debugging, proxy bypass, CA paths, client identity,
  // preload or key-log settings. All request/trust data arrives only on stdin.
  // Without proc, Node can report bare argv[0] as execPath. Search only image-
  // owned executable directories, never the Agent's ambient PATH.
  runChild(
    process.execPath,
    ["--input-type=module", "-e", program],
    {
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
    input,
  );
}

function configuration(path) {
  refusalPhase = "configuration";
  if (!isAbsolute(path ?? "")) {
    throw new Error("A managed public Git configuration is required.");
  }
  const bytes = readFileSync(path);
  if (bytes.length > 64 * 1024) {
    throw new Error("The managed public Git configuration is too large.");
  }
  const value = JSON.parse(bytes.toString("utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "endpoint",
          "caPath",
          "capabilityPath",
          "capabilityEnvironment",
          "authenticatedRepositories",
        ].includes(key),
    ) ||
    !Array.isArray(value.authenticatedRepositories) ||
    !value.authenticatedRepositories.every(
      (repo) => typeof repo === "string" && /^[a-z\d][a-z\d-]*\/[a-z\d._-]+$/i.test(repo),
    ) ||
    !isAbsolute(value.caPath ?? "") ||
    (!isAbsolute(value.capabilityPath ?? "") &&
      value.capabilityEnvironment !== "OCE_PUBLIC_GITHUB_READ_CAPABILITY")
  ) {
    throw new Error("The managed public Git configuration is invalid.");
  }
  const endpoint = new URL(value.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("The public reader requires an exact HTTPS origin.");
  }
  return { ...value, endpoint: endpoint.origin };
}

function capability(value, allowPlaceholder = false) {
  refusalPhase = "authorization";
  if (
    typeof value !== "string" ||
    (!/^[a-z\d_-]{1,128}\.[A-Za-z\d_-]{43}$/i.test(value) &&
      !(
        allowPlaceholder &&
        /^openshell:resolve:env:s[0-9a-f]{64}_OCE_PUBLIC_GITHUB_READ_CAPABILITY$/.test(value)
      ))
  ) {
    throw new Error("Public reader authorization is unavailable.");
  }
  return value;
}

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

function install(configPath, directory, script = fileURLToPath(import.meta.url)) {
  configuration(configPath);
  if (process.env.GIT_EXEC_PATH) {
    throw new Error("Managed public Git cannot replace a configured GIT_EXEC_PATH.");
  }
  const result = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  const original = result.stdout?.trim();
  if (result.status !== 0 || !isAbsolute(original ?? "")) {
    throw new Error("The image Git helper directory is unavailable.");
  }
  const helper = realpathSync(join(original, "git-remote-https"));
  directory ??= mkdtempSync(join(tmpdir(), "oce-public-git-"));
  chmodSync(directory, 0o700);
  writeFileSync(
    join(directory, "git-remote-https"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} --remote-helper "$@"\n`,
    { mode: 0o500 },
  );
  // Git searches GIT_EXEC_PATH before PATH. Keep the image's other external
  // helpers discoverable without copying or replacing their implementations.
  return {
    GIT_EXEC_PATH: directory,
    PATH: original + ":" + (process.env.PATH ?? ""),
    OCE_PUBLIC_GITHUB_READ_CONFIG: configPath,
    OCE_PUBLIC_GITHUB_REAL_HTTP_HELPER: helper,
  };
}

function gitHubRepository(value) {
  const url = new URL(value);
  if (url.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }
  const match =
    /^https:\/\/github\.com(?::443)?\/([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/(?!\.{1,2}(?:\.git)?$)([a-z\d._-]{1,104})$/i.exec(
      value,
    );
  if (!match) {
    throw new Error("Public Git requires a canonical GitHub HTTPS repository URL.");
  }
  const repository = match[2].replace(/\.git$/i, "");
  if (!repository || repository.length > 100 || repository === "." || repository === "..") {
    throw new Error("The GitHub repository URL is invalid.");
  }
  return `${match[1]}/${repository}`.toLowerCase();
}

function appendGitConfig(env, entries) {
  const count = Number(env.GIT_CONFIG_COUNT ?? "0");
  if (!Number.isSafeInteger(count) || count < 0 || count > 256) {
    throw new Error("Inherited Git configuration is invalid.");
  }
  for (let index = 0; index < entries.length; index++) {
    env[`GIT_CONFIG_KEY_${count + index}`] = entries[index][0];
    env[`GIT_CONFIG_VALUE_${count + index}`] = entries[index][1];
  }
  env.GIT_CONFIG_COUNT = String(count + entries.length);
}

function remoteHelper(remote, originalUrl) {
  const config = configuration(process.env.OCE_PUBLIC_GITHUB_READ_CONFIG);
  refusalPhase = "child-setup";
  const helper = process.env.OCE_PUBLIC_GITHUB_REAL_HTTP_HELPER;
  if (!isAbsolute(helper ?? "") || !remote || !originalUrl) {
    throw new Error("The managed Git transport is not installed.");
  }
  const repository = gitHubRepository(originalUrl);
  let url = originalUrl;
  const env = { ...process.env };
  const admittedBindings =
    process.env.OCE_PUBLIC_GITHUB_AUTHENTICATED_REPOSITORIES === undefined
      ? []
      : JSON.parse(process.env.OCE_PUBLIC_GITHUB_AUTHENTICATED_REPOSITORIES);
  if (
    !Array.isArray(admittedBindings) ||
    !admittedBindings.every(
      (bound) => typeof bound === "string" && /^[a-z\d][a-z\d-]*\/[a-z\d._-]+$/i.test(bound),
    )
  ) {
    throw new Error("Authenticated Git routing is unavailable.");
  }
  if (
    repository &&
    ![...config.authenticatedRepositories, ...admittedBindings].some(
      (bound) => bound.toLowerCase() === repository,
    )
  ) {
    const token = authorization(config);
    url = `${config.endpoint}/git/${repository}.git`;
    // Git's -c parameters outrank GIT_CONFIG_COUNT, and URL-specific options
    // outrank origin-wide ones. Reset command configuration, then constrain the
    // exact rewritten repository URL. Authenticated delegates retain every input.
    for (const name of Object.keys(env)) {
      if (/^GIT_CONFIG(?:_(?:COUNT|KEY_.*|VALUE_.*|PARAMETERS))?$/.test(name)) {
        delete env[name];
      }
    }
    for (const name of [
      "GIT_SSL_NO_VERIFY",
      "GIT_SSL_CERT",
      "GIT_SSL_KEY",
      "GIT_SSL_CAPATH",
      "GIT_SSL_CERT_PASSWORD_PROTECTED",
      "GIT_PROXY_SSL_CERT",
      "GIT_PROXY_SSL_KEY",
      "GIT_PROXY_SSL_CERT_PASSWORD_PROTECTED",
    ]) {
      delete env[name];
    }
    // An empty sslCert value still activates native Git's client-certificate
    // credential path. Refuse configured client identities rather than sending
    // them to a different service or relying on an ineffective empty override.
    const inheritedHttp = spawnSync("git", ["config", "--null", "--get-urlmatch", "http", url], {
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    if (
      inheritedHttp.error ||
      ![0, 1].includes(inheritedHttp.status) ||
      inheritedHttp.stdout.split("\0").some((entry) => {
        const separator = entry.indexOf("\n");
        return (
          ["http.sslcert", "http.sslkey", "http.proxysslcert", "http.proxysslkey"].includes(
            entry.slice(0, separator).toLowerCase(),
          ) && entry.slice(separator + 1).length > 0
        );
      })
    ) {
      throw new Error("Inherited Git TLS client identities are unavailable for public reads.");
    }
    const ca = operationTrust(config);
    refusalPhase = "child-setup";
    env.GIT_SSL_CAINFO = ca;
    // Keep the Sandbox's environment proxy route; inherited Git config cannot
    // replace it with a proxy that receives repository credentials.
    const proxy = env.https_proxy ?? env.HTTPS_PROXY ?? env.all_proxy ?? env.ALL_PROXY ?? "";
    const http = `http.${url}/`;
    appendGitConfig(env, [
      ["http.extraHeader", ""],
      [`${http}.extraHeader`, ""],
      [`${http}.extraHeader`, `Authorization: Bearer ${token}`],
      [`${http}.sslCAInfo`, ca],
      [`${http}.sslCAPath`, env.GIT_EXEC_PATH],
      [`${http}.sslVerify`, "true"],
      [`${http}.followRedirects`, "false"],
      [`${http}.cookieFile`, ""],
      [`${http}.saveCookies`, "false"],
      [`${http}.proxy`, proxy],
      [`${http}.emptyAuth`, "false"],
      [`${http}.delegation`, "none"],
      [`remote.${remote}.proxy`, proxy],
      ["credential.helper", ""],
      [`credential.${url}.helper`, ""],
      [`credential.${url}.username`, ""],
      ["credential.interactive", "false"],
    ]);
    // Older Git checks askpass before terminal prompting and ignores
    // credential.interactive. A present empty value also blocks config/SSH fallback.
    env.GIT_ASKPASS = "";
    env.GIT_TERMINAL_PROMPT = "0";
  }
  runChild(helper, [remote, url], env);
}

function installMaterial(materialPath) {
  const bytes = readFileSync(materialPath);
  if (bytes.length > 1024 * 1024) {
    throw new Error("Public reader material exceeds its bound.");
  }
  const material = JSON.parse(bytes.toString("utf8"));
  if (
    !material ||
    Object.keys(material).sort().join(" ") !== "authenticatedRepositories caBundle endpoint" ||
    typeof material.caBundle !== "string"
  ) {
    throw new Error("Invalid public reader material.");
  }
  // This exact nonsecret subtree is projected read-only by the native translator.
  // HOME follows the selected provider, including OpenShell's relocated home.
  const home = process.env.HOME;
  if (!isAbsolute(home ?? "")) {
    throw new Error("Public Git requires a private runtime home.");
  }
  const homeStat = lstatSync(home);
  if (
    !homeStat.isDirectory() ||
    homeStat.uid !== process.getuid() ||
    (homeStat.mode & 0o022) !== 0
  ) {
    throw new Error("Public Git requires an owned runtime home.");
  }
  const root = join(home, ".oce-public-git");
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error("Public Git material must have a private owned directory.");
  }
  const directory = mkdtempSync(join(root, "material-"));
  chmodSync(directory, 0o700);
  const ca = composeTrust(material.caBundle);
  const caPath = join(directory, "ca.pem");
  writeFileSync(caPath, ca, { mode: 0o400 });
  const token =
    process.env.OCE_PUBLIC_GITHUB_READ_CAPABILITY === undefined
      ? capability(readFileSync(process.env.OCE_PUBLIC_GITHUB_READ_CAPABILITY_FILE, "utf8").trim())
      : capability(process.env.OCE_PUBLIC_GITHUB_READ_CAPABILITY, true);
  const configPath = join(directory, "transport.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      endpoint: material.endpoint,
      caPath,
      capabilityEnvironment: "OCE_PUBLIC_GITHUB_READ_CAPABILITY",
      authenticatedRepositories: material.authenticatedRepositories,
    }),
    { mode: 0o400 },
  );
  const script = join(directory, "transport.mjs");
  writeFileSync(script, readFileSync(fileURLToPath(import.meta.url)), { mode: 0o400 });
  return {
    ...install(configPath, directory, script),
    OCE_PUBLIC_GITHUB_READ_CA_FILE: caPath,
    CODEX_CA_CERTIFICATE: caPath,
    OCE_PUBLIC_GITHUB_READ_CAPABILITY: token,
  };
}

try {
  if (process.argv[2] === "--install-material" && process.argv.length === 4) {
    process.stdout.write(JSON.stringify(installMaterial(process.argv[3])) + "\n");
  } else if (process.argv[2] === "--install" && process.argv.length === 4) {
    process.stdout.write(JSON.stringify(install(process.argv[3])) + "\n");
  } else if (process.argv[2] === "--remote-helper" && process.argv.length === 5) {
    remoteHelper(process.argv[3], process.argv[4]);
  } else if (process.argv[2] === "--api-get" && process.argv.length === 4) {
    apiGet(process.argv[3]);
  } else if (process.argv[2] === "--api-get-metadata" && process.argv.length === 4) {
    apiGet(process.argv[3], true);
  } else {
    throw new Error("Unsupported managed Git invocation.");
  }
} catch (error) {
  // Neither native arguments nor configuration contents belong in diagnostics.
  process.stderr.write("The managed public Git transport refused this invocation.\n");
  refusalReceipt(error);
  process.exitCode = 1;
}
