import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import https from "node:https";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  PUBLIC_GITHUB_READ_AGENT_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { createPublicGithubReadServer } from "../../apps/controller/src/drivers/repo/github/public-read/server.ts";
import { selfSigned } from "../helpers/certificates.mjs";
import { listen } from "../helpers/listen.mjs";
import {
  startPublicGithubProvider,
  publicProviderGit,
} from "../helpers/public-github-provider.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const execute = promisify(execFile);
const helper = fileURLToPath(
  new URL(
    "../../apps/controller/src/drivers/repo/github/public-read/transport.mjs",
    import.meta.url,
  ),
);

// Execute the production launcher's inserted setup with real files and children.
// This also audits the embedded source copy, not just the standalone installer.
const insertion = 'const pluginRuntime = readPluginRuntime("codex");';
const setupOffset = AGENT_RUNTIME_ENTRYPOINT.indexOf(insertion) + insertion.length;
const materialSetup = PUBLIC_GITHUB_READ_AGENT_ENTRYPOINT.slice(
  setupOffset,
  PUBLIC_GITHUB_READ_AGENT_ENTRYPOINT.length - (AGENT_RUNTIME_ENTRYPOINT.length - setupOffset),
);
const materialProgram = `const {spawnSync} = require("node:child_process");
const material = JSON.parse(require("node:fs").readFileSync(process.env.OCE_PUBLIC_GITHUB_READ_MATERIAL_FILE, "utf8"));
const pluginRuntime = {manifest:{publicGithubRead:material}};
${materialSetup}
console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  key.startsWith("OCE_PUBLIC_GITHUB_") || key === "CODEX_CA_CERTIFICATE" || key === "GIT_EXEC_PATH" || key === "PATH"))));`;

test("managed Git transport clones and fetches ordinary URLs while the reader enforces revision scope", async (t) => {
  const directory = await temporaryDirectory(t, "public-github-transport-");
  const provider = await startPublicGithubProvider(t, { directory });
  const source = await provider.createRepository("example/project", {
    "readme.txt": "first object\n",
  });
  const connect = https.Agent.prototype.createConnection;
  t.mock.method(https.Agent.prototype, "createConnection", function (options, callback) {
    assert.equal(options.host, "github.com");
    return connect.call(
      this,
      {
        ...options,
        host: "127.0.0.1",
        port: provider.port,
        servername: "github.com",
        ca: provider.cert,
      },
      callback,
    );
  });
  const token = "revision-transport." + Buffer.alloc(32, 3).toString("base64url");
  let authorizations = {
    "revision-transport": {
      installationId: "installation-test",
      namespaceId: "namespace-test",
      agentId: "agent-test",
      revisionId: "revision-transport",
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      policy: { mode: "repositories", repositories: ["example/project"] },
      validUntil: new Date(Date.now() + 600_000).toISOString(),
    },
  };
  const serviceTls = await selfSigned(directory, {
    commonName: "localhost",
    subjectAltName: "DNS:localhost,IP:127.0.0.1",
  });
  const reader = createPublicGithubReadServer({
    tls: serviceTls,
    policy: { mode: "all" },
    loadAuthorizations: () => authorizations,
  });
  const port = await listen(t, reader);
  const configPath = path.join(directory, "transport.json");
  const caPath = path.join(directory, "reader-ca.pem");
  const capabilityPath = path.join(directory, "capability");
  await writeFile(caPath, serviceTls.cert);
  await writeFile(capabilityPath, token, { mode: 0o600 });
  await writeFile(
    configPath,
    JSON.stringify({
      endpoint: `https://127.0.0.1:${port}`,
      caPath,
      capabilityPath,
      authenticatedRepositories: [],
    }),
  );
  const baseEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  delete baseEnv.GIT_EXEC_PATH;
  const installed = await execute(process.execPath, [helper, "--install", configPath], {
    env: baseEnv,
  });
  const env = { ...baseEnv, ...JSON.parse(installed.stdout) };
  const git = (cwd, ...args) => execute("git", ["-C", cwd, ...args], { env, timeout: 30_000 });
  const clone = path.join(directory, "clone");
  const url = "https://github.com/Example/Project.git";
  await git(directory, "clone", "--depth=1", url, clone);
  assert.equal(await readFile(path.join(clone, "readme.txt"), "utf8"), "first object\n");
  assert.equal((await git(clone, "remote", "get-url", "origin")).stdout.trim(), url);
  await writeFile(path.join(source, "readme.txt"), "second object\n");
  await publicProviderGit(source, "commit", "-am", "Second object");
  await publicProviderGit(source, "push", path.join(provider.root, "example/project.git"), "main");
  await git(clone, "fetch", "origin");
  assert.equal((await git(clone, "show", "origin/main:readme.txt")).stdout, "second object\n");
  for (const request of provider.requests) {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
  }
  const before = provider.requests.length;
  await assert.rejects(git(directory, "ls-remote", "https://github.com/example/other.git"), {
    code: 128,
  });
  await assert.rejects(git(clone, "push", "origin", "HEAD:refs/heads/forbidden"), { code: 128 });
  assert.equal(provider.requests.length, before, "denials must not contact GitHub");
  // The canonical-host guard rejects forged URL origins locally. DNS failure
  // at a lookalike host would not prove this transport policy boundary.
  for (const forged of [
    "https://github.com:444/example/project.git",
    "https://user@github.com/example/project.git",
    "https://github.com/example/project.git?forged=1",
  ]) {
    await assert.rejects(
      git(directory, "ls-remote", forged),
      (error) =>
        error.code === 128 &&
        /The managed public Git transport refused this invocation\./.test(error.stderr),
    );
  }
  assert.equal(provider.requests.length, before, "noncanonical origins must not contact GitHub");
  authorizations = {};
  await assert.rejects(git(clone, "fetch", "origin"), { code: 128 });
  assert.equal(provider.requests.length, before, "withdrawn access must not fall back to GitHub");
  // GIT_EXEC_PATH redirects only the selected HTTP helper; Git still discovers
  // its other image-provided external helpers through the preserved PATH.
  await mkdir(path.join(directory, "export"));
  await git(
    clone,
    "archive",
    "--format=tar",
    "--output=" + path.join(directory, "export", "source.tar"),
    "HEAD",
  );
  await assert.rejects(
    execute(process.execPath, [helper, "--install", configPath], {
      env: { ...baseEnv, GIT_EXEC_PATH: "/unexpected/helper" },
    }),
    { code: 1 },
  );
});

async function materialFixture(t) {
  const directory = await temporaryDirectory(t, "public-github-material-");
  const provider = await startPublicGithubProvider(t, { directory });
  await provider.createRepository("example/project");
  const apiTls = await selfSigned(directory, { name: "api-provider" });
  const apiRequests = [];
  const api = https.createServer(apiTls, (req, res) => {
    apiRequests.push(req.url);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.url.endsWith("/pulls/27")
          ? { title: "provider-only-pull" }
          : { full_name: "example/project", private: false },
      ),
    );
  });
  const apiPort = await listen(t, api);
  const connect = https.Agent.prototype.createConnection;
  t.mock.method(https.Agent.prototype, "createConnection", function (options, callback) {
    return connect.call(
      this,
      {
        ...options,
        host: "127.0.0.1",
        port: options.host === "api.github.com" ? apiPort : provider.port,
        servername: options.host === "api.github.com" ? "localhost" : "github.com",
        ca: options.host === "api.github.com" ? apiTls.cert : provider.cert,
      },
      callback,
    );
  });
  const token = "revision-material." + Buffer.alloc(32, 5).toString("base64url");
  const serviceTls = await selfSigned(directory);
  const reader = createPublicGithubReadServer({
    tls: serviceTls,
    policy: { mode: "all" },
    loadAuthorizations: () => ({
      "revision-material": {
        installationId: "installation-test",
        namespaceId: "namespace-test",
        agentId: "agent-test",
        revisionId: "revision-material",
        tokenSha256: createHash("sha256").update(token).digest("hex"),
        policy: { mode: "all" },
        validUntil: new Date(Date.now() + 600_000).toISOString(),
      },
    }),
  });
  const requests = [];
  reader.on("request", (req) => requests.push({ url: req.url, headers: req.headers }));
  const port = await listen(t, reader);
  const endpoint = `https://127.0.0.1:${port}`;
  const capabilityPath = path.join(directory, "capability");
  const materialPath = path.join(directory, "material.json");
  await writeFile(capabilityPath, token, { mode: 0o600 });
  await writeFile(
    materialPath,
    JSON.stringify({ endpoint, caBundle: serviceTls.cert, authenticatedRepositories: [] }),
  );
  const baseEnv = {
    ...process.env,
    TMPDIR: directory,
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of Object.keys(baseEnv)) {
    if (
      /^GIT_CONFIG_(?:COUNT|KEY_.*|VALUE_.*|PARAMETERS)$/.test(name) ||
      name === "GIT_EXEC_PATH" ||
      name === "OPENCLAW_WORKSPACE_DIR" ||
      name.startsWith("OCE_PUBLIC_GITHUB_")
    ) {
      delete baseEnv[name];
    }
  }
  const install = async (overrides = {}) => {
    const result = await execute(process.execPath, ["-e", materialProgram], {
      env: {
        ...baseEnv,
        OCE_PUBLIC_GITHUB_READ_MATERIAL_FILE: materialPath,
        OCE_PUBLIC_GITHUB_READ_CAPABILITY_FILE: capabilityPath,
        ...overrides,
      },
    });
    return { ...baseEnv, ...overrides, ...JSON.parse(result.stdout) };
  };
  const git = (env, ...args) =>
    execute("git", ["-C", directory, ...args], { env, timeout: 30_000 });
  return {
    directory,
    provider,
    serviceTls,
    token,
    reader,
    endpoint,
    requests,
    apiRequests,
    api,
    materialPath,
    capabilityPath,
    baseEnv,
    install,
    git,
  };
}

test("launcher material installs real capabilities, inherited trust, and protected placeholders without materializing credentials", async (t) => {
  const fixture = await materialFixture(t);
  const { directory, provider, token, install, git } = fixture;
  const env = await install({ GIT_SSL_CAINFO: path.join(directory, "github-provider.crt") });
  const clone = path.join(directory, "launcher-clone");
  const url = "https://github.com/Example/Project.git";
  await git(env, "clone", "--depth=1", url, clone);
  assert.equal(await readFile(path.join(clone, "readme.txt"), "utf8"), "first object\n");
  await execute("git", ["-C", clone, "fetch", "origin"], { env, timeout: 30_000 });
  assert.equal(
    (await execute("git", ["-C", clone, "remote", "get-url", "origin"], { env })).stdout.trim(),
    url,
  );
  // The merged trust must also serve callers using the inherited GitHub CA.
  // The limited native filesystem grants only this nonsecret subtree. Every
  // runtime dependency must be inside it, independent of the outer TMPDIR.
  const materialRoot = path.join(directory, ".oce-public-git");
  for (const file of [
    env.OCE_PUBLIC_GITHUB_READ_CA_FILE,
    env.OCE_PUBLIC_GITHUB_READ_CONFIG,
    env.GIT_EXEC_PATH,
  ]) {
    assert.ok(file.startsWith(materialRoot + path.sep), file);
  }
  const wrapper = await readFile(path.join(env.GIT_EXEC_PATH, "git-remote-https"), "utf8");
  assert.ok(
    wrapper.includes(path.join(path.dirname(env.OCE_PUBLIC_GITHUB_READ_CONFIG), "transport.mjs")),
  );
  assert.equal((await lstat(materialRoot)).mode & 0o777, 0o700);
  const combined = await readFile(env.OCE_PUBLIC_GITHUB_READ_CA_FILE, "utf8");
  assert.ok(combined.includes(provider.cert));
  assert.ok(combined.includes(fixture.serviceTls.cert));
  assert.equal(env.OCE_PUBLIC_GITHUB_READ_CAPABILITY, token);
  for (const name of await readdir(path.dirname(env.OCE_PUBLIC_GITHUB_READ_CONFIG))) {
    assert.ok(
      !(
        await readFile(path.join(path.dirname(env.OCE_PUBLIC_GITHUB_READ_CONFIG), name), "utf8")
      ).includes(token),
    );
  }
  const placeholder =
    "openshell:resolve:env:s" + "a".repeat(64) + "_OCE_PUBLIC_GITHUB_READ_CAPABILITY";
  const protectedEnv = await install({
    OCE_PUBLIC_GITHUB_READ_CAPABILITY: placeholder,
    OCE_PUBLIC_GITHUB_READ_CAPABILITY_FILE: "/nonexistent",
  });
  assert.equal(protectedEnv.OCE_PUBLIC_GITHUB_READ_CAPABILITY, placeholder);
  // A stock proxy substitutes this header; here the real reader rejects the unresolved
  // placeholder, proving projection without pretending to run OpenShell.
  const before = fixture.requests.length;
  await assert.rejects(git(protectedEnv, "ls-remote", "https://github.com/example/project.git"), {
    code: 128,
  });
  assert.equal(fixture.requests[before].headers.authorization, `Bearer ${placeholder}`);
  for (const name of await readdir(path.dirname(protectedEnv.OCE_PUBLIC_GITHUB_READ_CONFIG))) {
    assert.ok(
      !(
        await readFile(
          path.join(path.dirname(protectedEnv.OCE_PUBLIC_GITHUB_READ_CONFIG), name),
          "utf8",
        )
      ).includes(placeholder),
    );
  }
});

test("managed Git and API compose current tool trust and retain startup proxy roots", async (t) => {
  const fixture = await materialFixture(t);
  const startup = await selfSigned(fixture.directory, { name: "startup" });
  await writeFile(
    startup.certPath,
    "# Public CA bundle\nStartup root\n============\n" + startup.cert,
  );
  const env = await fixture.install({ CODEX_CA_CERTIFICATE: startup.certPath });
  const startupBundle = await readFile(env.CODEX_CA_CERTIFICATE, "utf8");
  assert.ok(startupBundle.includes(startup.cert));
  assert.ok(startupBundle.includes(fixture.serviceTls.cert));
  const api = (context, route = "/repos/example/project/pulls/27") =>
    execute(process.execPath, [path.join(env.GIT_EXEC_PATH, "transport.mjs"), "--api-get", route], {
      env: context,
      timeout: 30_000,
    });
  // A later tool TLS peer uses a fresh root after installation, as interception
  // does. This is real caller TLS, not proof of Codex's native proxy lifecycle.
  for (const name of ["first-tool", "second-tool"]) {
    const current = await selfSigned(fixture.directory, { name });
    await writeFile(
      current.certPath,
      "## Tool CA bundle\nCurrent peer\n============\n" + current.cert,
    );
    fixture.reader.setSecureContext(current);
    const context = { ...env, GIT_SSL_CAINFO: current.certPath, CURL_CA_BUNDLE: current.certPath };
    await fixture.git(context, "ls-remote", "https://github.com/example/project.git");
    assert.equal(JSON.parse((await api(context)).stdout).title, "provider-only-pull");
    assert.equal(
      (await readdir(fixture.directory)).some((entry) => entry.startsWith("oce-public-trust-")),
      false,
    );
    const before = fixture.apiRequests.length + fixture.provider.requests.length;
    await assert.rejects(fixture.git(env, "ls-remote", "https://github.com/example/project.git"), {
      code: 128,
    });
    await assert.rejects(api(env), { code: 60 });
    assert.equal(fixture.apiRequests.length + fixture.provider.requests.length, before);
    assert.equal(
      (await readdir(fixture.directory)).some((entry) => entry.startsWith("oce-public-trust-")),
      false,
    );
  }
});

test("managed API metadata follows real reader pagination without exposing other headers", async (t) => {
  const fixture = await materialFixture(t);
  const env = await fixture.install();
  const pages = [];
  fixture.api.removeAllListeners("request");
  fixture.api.on("request", (req, res) => {
    if (req.url === "/repos/example/project") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ full_name: "example/project", private: false }));
      return;
    }
    const page = new URL(req.url, "https://api.github.com").searchParams.get("page");
    pages.push(page);
    res.writeHead(200, {
      "content-type": "application/json",
      ...(page === "1"
        ? {
            link: '<https://api.github.com/repos/example/project/pulls?page=2&per_page=1>; rel="next"',
          }
        : {}),
    });
    res.end(JSON.stringify([{ number: Number(page), title: "page-" + page }]));
  });
  const read = async (route) =>
    JSON.parse(
      (
        await execute(
          process.execPath,
          [path.join(env.GIT_EXEC_PATH, "transport.mjs"), "--api-get-metadata", route],
          { env, timeout: 30_000 },
        )
      ).stdout,
    );
  const first = await read("/repos/example/project/pulls?page=1&per_page=1");
  assert.deepEqual(first, {
    status: 200,
    link: '</repos/example/project/pulls?page=2&per_page=1>; rel="next"',
    body: [{ number: 1, title: "page-1" }],
  });
  const second = await read(first.link.match(/^<([^>]+)>; rel="next"$/)[1]);
  assert.deepEqual(second, { status: 200, link: null, body: [{ number: 2, title: "page-2" }] });
  assert.deepEqual(pages, ["1", "2"]);
  // The client metadata boundary also refuses malformed or excessive headers
  // from a trusted TLS peer, without printing its body or unrelated secrets.
  fixture.reader.removeAllListeners("request");
  let headers = { "x-unrelated": fixture.token };
  let status = 200;
  fixture.reader.on("request", (_req, res) => {
    res.writeEarlyHints({ link: '</style.css>; rel="preload"' });
    res.writeHead(status, headers);
    res.end(JSON.stringify({ title: "must-not-escape-on-refusal" }));
  });
  const success = await read("/repos/example/project/pulls");
  assert.deepEqual(success, {
    status: 200,
    link: null,
    body: { title: "must-not-escape-on-refusal" },
  });
  for (const link of [
    '<https://unrelated.invalid/>; rel="next"',
    '</repos/example/other/pulls?page=2>; rel="next"',
    '</repos/example/project/pulls?page=2>; rel="next", </repos/example/project/pulls?page=3>; rel="next"',
    "malformed",
    "x".repeat(8193),
  ]) {
    headers = { link, "x-unrelated": fixture.token };
    await assert.rejects(
      read("/repos/example/project/pulls"),
      (error) => error.code !== 0 && error.stdout === "" && !error.stderr.includes(fixture.token),
    );
  }
  headers = { "x-unrelated": "x".repeat(17 * 1024) };
  await assert.rejects(
    read("/repos/example/project/pulls"),
    (error) => error.code !== 0 && error.stdout === "",
  );
  headers = {
    link: '</repos/example/project/pulls?page=2>; rel="next"',
    "x-unrelated": fixture.token,
  };
  status = 503;
  await assert.rejects(
    read("/repos/example/project/pulls"),
    (error) => error.code === 22 && error.stdout === "" && !error.stderr.includes(fixture.token),
  );
  assert.equal(
    (await readdir(fixture.directory)).some((entry) => entry.startsWith("oce-public-trust-")),
    false,
  );
});

test("managed API refuses unsafe routes, TLS peers, redirects and capabilities without provider contact", async (t) => {
  const fixture = await materialFixture(t);
  const env = await fixture.install();
  const api = (route, overrides = {}) =>
    execute(process.execPath, [path.join(env.GIT_EXEC_PATH, "transport.mjs"), "--api-get", route], {
      env: { ...env, ...overrides },
      timeout: 30_000,
    });
  const route = "/repos/example/project/pulls/27";
  for (const invalid of [
    "https://unrelated.invalid/",
    "//unrelated.invalid/",
    "/repos/example/../project",
    "/repos/example/%2e%2e/project",
    "/git/example/project.git/info/refs",
    route + "#fragment",
    route + "\nHeader: value",
    "--insecure",
  ]) {
    await assert.rejects(api(invalid), { code: 1 });
  }
  assert.equal(fixture.requests.length, 0);
  // Curl's ambient config must not add identities, cookies or weaken verification.
  await writeFile(
    path.join(fixture.directory, ".curlrc"),
    'insecure\nheader = "X-Unrelated: forbidden"\ncookie = "unrelated=forbidden"\n',
  );
  assert.equal(JSON.parse((await api(route)).stdout).title, "provider-only-pull");
  assert.equal(fixture.requests.at(-1).headers["x-unrelated"], undefined);
  assert.equal(fixture.requests.at(-1).headers.cookie, undefined);
  const before = fixture.apiRequests.length;
  await assert.rejects(
    api(route, {
      OCE_PUBLIC_GITHUB_READ_CAPABILITY:
        "revision-material." + Buffer.alloc(32, 7).toString("base64url"),
    }),
    { code: 22 },
  );
  assert.equal(fixture.apiRequests.length, before);
  const wrongHost = await selfSigned(fixture.directory, {
    name: "wrong-host",
    subjectAltName: "DNS:unrelated.invalid",
  });
  fixture.reader.setSecureContext(wrongHost);
  await assert.rejects(api(route, { CURL_CA_BUNDLE: wrongHost.certPath }), { code: 60 });
  await assert.rejects(
    fixture.git(
      { ...env, GIT_SSL_CAINFO: wrongHost.certPath },
      "ls-remote",
      "https://github.com/example/project.git",
    ),
    { code: 128 },
  );
  assert.equal(fixture.apiRequests.length, before);
  fixture.reader.setSecureContext(fixture.serviceTls);
  // Even an otherwise trusted reader cannot redirect the capability elsewhere.
  let redirected = 0;
  const destination = https.createServer(fixture.serviceTls, (_req, res) => {
    redirected++;
    res.end("forbidden");
  });
  const port = await listen(t, destination);
  fixture.reader.removeAllListeners("request");
  fixture.reader.on("request", (_req, res) =>
    res.writeHead(302, { location: `https://127.0.0.1:${port}/destination` }).end(),
  );
  await assert.rejects(api(route), { code: 1 });
  assert.equal(redirected, 0);
  assert.equal(fixture.apiRequests.length, before);
});

test("managed trust fails closed on invalid inputs and removes operation files after failure and cancellation", async (t) => {
  const fixture = await materialFixture(t);
  const env = {
    ...(await fixture.install()),
    OPENCLAW_WORKSPACE_DIR: fixture.directory,
    TMPDIR: path.join(fixture.directory, "unavailable-temporary-root"),
  };
  const script = path.join(env.GIT_EXEC_PATH, "transport.mjs");
  const args = [script, "--api-get", "/repos/example/project/pulls/27"];
  const invalid = path.join(fixture.directory, "invalid-ca.pem");
  const clean = async () =>
    assert.equal(
      (await readdir(fixture.directory)).some((entry) => entry.startsWith("oce-public-trust-")),
      false,
    );
  for (const contents of [
    "not a certificate",
    fixture.serviceTls.cert + fixture.serviceTls.key,
    Buffer.alloc(1024 * 1024 + 1, 32),
  ]) {
    await writeFile(invalid, contents);
    await assert.rejects(
      execute(process.execPath, args, { env: { ...env, CURL_CA_BUNDLE: invalid } }),
      { code: 1 },
    );
    await assert.rejects(
      fixture.git(
        { ...env, CURL_CA_BUNDLE: invalid },
        "ls-remote",
        "https://github.com/example/project.git",
      ),
      { code: 128 },
    );
    await clean();
  }
  for (const file of [path.join(fixture.directory, "absent.pem"), fixture.directory]) {
    await assert.rejects(
      execute(process.execPath, args, { env: { ...env, SSL_CERT_FILE: file } }),
      { code: 1 },
    );
  }
  await writeFile(invalid, fixture.serviceTls.cert);
  await chmod(invalid, 0o000);
  await assert.rejects(
    execute(process.execPath, args, { env: { ...env, CURL_CA_BUNDLE: invalid } }),
    { code: 1 },
  );
  await chmod(invalid, 0o600);
  // Individually bounded inputs must not evade the combined input budget.
  const many = {};
  for (const key of [
    "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
    "PIP_CERT",
    "BUNDLE_SSL_CA_CERT",
    "CARGO_HTTP_CAINFO",
  ]) {
    const file = path.join(fixture.directory, key + ".pem");
    await writeFile(
      file,
      fixture.serviceTls.cert.repeat(
        Math.floor((1024 * 1024) / Buffer.byteLength(fixture.serviceTls.cert)),
      ),
    );
    many[key] = file;
  }
  await assert.rejects(execute(process.execPath, args, { env: { ...env, ...many } }), { code: 1 });
  await clean();
  assert.equal(fixture.requests.length, 0);
  await assert.rejects(
    execute(
      process.execPath,
      [script, "--remote-helper", "origin", "https://github.com/example/project.git"],
      {
        env: {
          ...env,
          OCE_PUBLIC_GITHUB_REAL_HTTP_HELPER: path.join(fixture.directory, "absent-helper"),
        },
      },
    ),
    { code: 1 },
  );
  await clean();
  // Concurrent helpers own different private directories in the admitted
  // workspace. Cancelling one must not remove the other's trust bundle.
  fixture.reader.removeAllListeners("request");
  let arrived;
  let requests = 0;
  const request = new Promise((resolve) => {
    arrived = resolve;
  });
  fixture.reader.on("request", (_req, _res) => {
    if (++requests === 2) {
      arrived();
    }
  });
  const children = Array.from({ length: 2 }, () =>
    spawn(
      process.execPath,
      [script, "--remote-helper", "origin", "https://github.com/example/project.git"],
      { env, stdio: ["pipe", "ignore", "ignore"] },
    ),
  );
  for (const child of children) {
    child.stdin.on("error", () => {});
    child.stdin.end("capabilities\nlist\n");
  }
  const closed = children.map(
    (child) =>
      new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
  );
  t.after(() => children.forEach((child) => child.kill("SIGKILL")));
  await Promise.race([
    request,
    ...closed.map((completion) =>
      completion.then(() => {
        throw new Error("Git child exited before cancellation");
      }),
    ),
  ]);
  const directories = (await readdir(fixture.directory)).filter((entry) =>
    entry.startsWith("oce-public-trust-"),
  );
  assert.equal(directories.length, 2);
  for (const name of directories) {
    const directory = path.join(fixture.directory, name);
    const bundle = path.join(directory, "ca.pem");
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(bundle)).mode & 0o777, 0o400);
    const contents = await readFile(bundle, "utf8");
    assert.ok(!contents.includes(fixture.token));
    assert.doesNotMatch(contents, /PRIVATE KEY/);
  }
  children[0].kill("SIGTERM");
  assert.equal((await closed[0]).signal, "SIGTERM");
  assert.equal(
    (await readdir(fixture.directory)).filter((entry) => entry.startsWith("oce-public-trust-"))
      .length,
    1,
  );
  children[1].kill("SIGTERM");
  assert.equal((await closed[1]).signal, "SIGTERM");
  await clean();
});

test("managed operations use the admitted runtime workspace when ambient temporary roots are unavailable", async (t) => {
  const fixture = await materialFixture(t);
  const workspace = path.join(fixture.directory, "runtime-workspace");
  const unavailable = path.join(fixture.directory, "unavailable-private-sentinel");
  const readonly = path.join(fixture.directory, "readonly-private-sentinel");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(readonly, { mode: 0o500 });
  const env = await fixture.install();
  const script = path.join(env.GIT_EXEC_PATH, "transport.mjs");
  const args = [script, "--api-get", "/repos/example/project/pulls/27"];
  const clean = async () =>
    assert.deepEqual(
      (await readdir(workspace)).filter((entry) => entry.startsWith("oce-public-trust-")),
      [],
    );
  for (const TMPDIR of [unavailable, readonly]) {
    const operationEnv = { ...env, TMPDIR, OPENCLAW_WORKSPACE_DIR: workspace };
    // The API caller need not run in the admitted root. Git can change its
    // helper cwd to repository metadata; neither cwd is operation scratch.
    const response = await execute(process.execPath, args, { env: operationEnv, cwd: readonly });
    assert.equal(JSON.parse(response.stdout).title, "provider-only-pull");
    assert.equal(response.stderr, "");
    const clone = path.join(workspace, TMPDIR === unavailable ? "missing-temp" : "readonly-temp");
    await fixture.git(operationEnv, "clone", "https://github.com/example/project.git", clone);
    await execute("git", ["-C", clone, "fetch", "origin"], { env: operationEnv });
    assert.equal(await readFile(path.join(clone, "readme.txt"), "utf8"), "first object\n");
    assert.equal(
      (
        await execute("git", ["-C", clone, "remote", "get-url", "origin"], { env: operationEnv })
      ).stdout.trim(),
      "https://github.com/example/project.git",
    );
    await clean();
  }
  // A selected runtime root is authoritative: do not retry an invalid or
  // unwritable workspace in the otherwise writable ambient temporary root.
  const before = fixture.requests.length;
  for (const [OPENCLAW_WORKSPACE_DIR, code] of [
    [unavailable, "ENOENT"],
    [readonly, "EACCES"],
    ["relative-private-sentinel", "unknown"],
  ]) {
    const operationEnv = { ...env, OPENCLAW_WORKSPACE_DIR };
    for (const operation of [
      ...(process.platform === "linux"
        ? []
        : [() => execute(process.execPath, args, { env: operationEnv })]),
      () => fixture.git(operationEnv, "ls-remote", "https://github.com/example/project.git"),
    ]) {
      const failure = await operation().then(
        () => assert.fail("unavailable operation storage must refuse"),
        (error) => error,
      );
      assert.match(failure.stderr, new RegExp("public-git-refusal:trust-files:" + code));
      assert.doesNotMatch(failure.stderr, /private-sentinel/);
      assert.ok(!failure.stderr.includes(fixture.token));
      assert.equal(failure.stdout, "");
    }
    await clean();
  }
  assert.equal(fixture.requests.length, before);
  assert.deepEqual(await readdir(readonly), []);
});

test("managed API isolates startup, composes large trust, and needs no Linux scratch", async (t) => {
  const fixture = await materialFixture(t);
  const env = await fixture.install();
  const script = path.join(env.GIT_EXEC_PATH, "transport.mjs");
  const python = path.join(fixture.directory, "python-startup");
  await mkdir(python);
  await writeFile(path.join(python, "sitecustomize.py"), "import os; os._exit(93)\n");
  const roots = [];
  // Distinct valid public roots survive deduplication and cross the carrier's
  // read chunk size. Reusing the fixture key avoids needless key generation.
  for (let batch = 0; batch < 16; batch++) {
    roots.push(
      ...(await Promise.all(
        Array.from({ length: 8 }, (_, offset) =>
          selfSigned(fixture.directory, {
            name: "extra-root-" + (batch * 8 + offset),
            commonName: "root-" + (batch * 8 + offset),
            keyPem: fixture.serviceTls.key,
          }),
        ),
      )),
    );
  }
  const bundle = roots.map(({ cert }) => cert).join("\n");
  assert.ok(Buffer.byteLength(bundle) > 65536);
  assert.ok(Buffer.byteLength(bundle) < 1024 * 1024);
  const bundlePath = path.join(fixture.directory, "large-public-bundle.pem");
  await writeFile(bundlePath, bundle);
  const before = (await readdir(fixture.directory)).sort();
  for (const root of ["/nonexistent-private-sentinel", "/", "relative-private-sentinel"]) {
    const context = {
      ...env,
      CURL_CA_BUNDLE: bundlePath,
      PYTHONPATH: python,
      PYTHONSTARTUP: path.join(python, "sitecustomize.py"),
      PYTHONINSPECT: "1",
      ...(process.platform === "linux"
        ? { OPENCLAW_WORKSPACE_DIR: root, TMPDIR: root, PATH: "/nonexistent" }
        : {}),
    };
    for (const mode of ["--api-get", "--api-get-metadata"]) {
      const result = await execute(
        process.execPath,
        [script, mode, "/repos/example/project/pulls/27"],
        { env: context, timeout: 30000 },
      );
      const response = JSON.parse(result.stdout);
      assert.equal(
        mode === "--api-get" ? response.title : response.body.title,
        "provider-only-pull",
      );
      if (mode === "--api-get-metadata") {
        assert.equal(response.status, 200);
        assert.equal(response.link, null);
      }
      assert.equal(result.stderr, "");
    }
  }
  assert.deepEqual((await readdir(fixture.directory)).sort(), before);
});

test("managed API cancels and bounds a stalled real response without retaining trust", async (t) => {
  const fixture = await materialFixture(t);
  const env = await fixture.install();
  const script = path.join(env.GIT_EXEC_PATH, "transport.mjs");
  const args = [script, "--api-get", "/repos/example/project/pulls/27"];
  const before = (await readdir(fixture.directory)).sort();
  fixture.reader.removeAllListeners("request");
  for (const signal of ["SIGTERM", "SIGINT", undefined]) {
    let arrived;
    const request = new Promise((resolve) => {
      arrived = resolve;
    });
    fixture.reader.once("request", (_req, _res) => arrived());
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => child.kill("SIGKILL"));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const closed = new Promise((resolve) =>
      child.once("close", (code, closedSignal) => resolve({ code, signal: closedSignal })),
    );
    await Promise.race([
      request,
      closed.then(() => {
        throw new Error("API child exited before response hold");
      }),
    ]);
    if (process.platform === "linux") {
      assert.deepEqual((await readdir(fixture.directory)).sort(), before);
    }
    if (signal !== undefined) {
      child.kill(signal);
    }
    const result = await closed;
    assert.equal(stdout, "");
    if (signal !== undefined) {
      assert.equal(result.signal, signal);
    } else {
      assert.equal(result.code, 28);
      assert.match(stderr, /The managed public API read timed out/);
    }
    assert.ok(!stderr.includes(fixture.token));
    assert.deepEqual((await readdir(fixture.directory)).sort(), before);
  }
});

test("material installation refuses redirected or shared private-home parents", async (t) => {
  const fixture = await materialFixture(t);
  const elsewhere = path.join(fixture.directory, "elsewhere");
  await mkdir(elsewhere);
  const linkedHome = path.join(fixture.directory, "linked-home");
  await mkdir(linkedHome);
  await symlink(elsewhere, path.join(linkedHome, ".oce-public-git"));
  await assert.rejects(fixture.install({ HOME: linkedHome }), { code: 1 });
  assert.deepEqual(await readdir(elsewhere), []);
  const sharedHome = path.join(fixture.directory, "shared-home");
  await mkdir(sharedHome);
  const sharedRoot = path.join(sharedHome, ".oce-public-git");
  await mkdir(sharedRoot);
  await chmod(sharedRoot, 0o755);
  await assert.rejects(fixture.install({ HOME: sharedHome }), { code: 1 });
  assert.deepEqual(await readdir(sharedRoot), []);
});

test("public Git ignores credential-bearing inherited Git config regardless of scope or command-line precedence", async (t) => {
  const fixture = await materialFixture(t);
  const env = await fixture.install();
  const target = `${fixture.endpoint}/git/example/project.git`;
  const cookie = path.join(fixture.directory, "cookies");
  const netrc = path.join(fixture.directory, ".netrc");
  await writeFile(netrc, "machine 127.0.0.1 login fixture-user password fixture-password\n", {
    mode: 0o600,
  });
  env.HOME = fixture.directory;
  await writeFile(
    cookie,
    "# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tTRUE\t2147483647\tprivate_session\tfixture-cookie\n",
  );
  const settings = [
    [`http.${target}.extraHeader`, "X-Private-Credential: fixture-header"],
    [`http.${target}.cookieFile`, cookie],
    [`http.${target}.proxy`, "http://127.0.0.1:1"],
    ["remote.origin.proxy", "http://127.0.0.1:1"],
  ];
  for (const [key, value] of settings) {
    await t.test(key, async () => {
      const start = fixture.requests.length;
      if (key === "remote.origin.proxy") {
        await fixture.git(
          env,
          "-c",
          `${key}=${value}`,
          "clone",
          "--depth=1",
          "https://github.com/example/project.git",
          path.join(fixture.directory, "proxy-clone"),
        );
      } else {
        await fixture.git(
          env,
          "-c",
          `${key}=${value}`,
          "ls-remote",
          "https://github.com/example/project.git",
        );
      }
      assert.ok(fixture.requests.length > start);
      for (const { headers } of fixture.requests.slice(start)) {
        assert.equal(headers.authorization, `Bearer ${fixture.token}`);
        assert.equal(headers.cookie, undefined);
        assert.equal(headers["x-private-credential"], undefined);
        assert.equal(headers["proxy-authorization"], undefined);
      }
    });
  }
  await t.test("global repository URL configuration", async () => {
    const global = path.join(fixture.directory, "global.gitconfig");
    await execute(
      "git",
      [
        "config",
        "--file",
        global,
        `http.${target}.extraHeader`,
        "X-Private-Credential: global-header",
      ],
      { env },
    );
    const start = fixture.requests.length;
    await fixture.git(
      { ...env, GIT_CONFIG_GLOBAL: global },
      "ls-remote",
      "https://github.com/example/project.git",
    );
    assert.ok(fixture.requests.length > start);
    for (const { headers } of fixture.requests.slice(start)) {
      assert.equal(headers["x-private-credential"], undefined);
    }
  });
  await t.test("environment config array and local repository config", async () => {
    const local = path.join(fixture.directory, "local");
    await mkdir(local);
    await execute("git", ["-C", local, "init"], { env });
    await execute(
      "git",
      ["-C", local, "config", `http.${target}.extraHeader`, "X-Private-Credential: local-header"],
      { env },
    );
    const start = fixture.requests.length;
    await execute("git", ["-C", local, "ls-remote", "https://github.com/example/project.git"], {
      env: {
        ...env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${target}.extraHeader`,
        GIT_CONFIG_VALUE_0: "X-Private-Credential: environment-header",
      },
      timeout: 30_000,
    });
    assert.ok(fixture.requests.length > start);
    for (const { headers } of fixture.requests.slice(start)) {
      assert.equal(headers["x-private-credential"], undefined);
    }
  });
});

test("public Git enforces TLS and redirect constraints over inherited Git options", async (t) => {
  const fixture = await materialFixture(t);
  const env = await fixture.install();
  await t.test("TLS verification", async () => {
    const untrustedTls = await selfSigned(fixture.directory, { name: "untrusted" });
    const received = [];
    const untrusted = https.createServer(untrustedTls, (req, res) => {
      received.push(req.url);
      res.writeHead(404).end();
    });
    const port = await listen(t, untrusted);
    const config = JSON.parse(await readFile(env.OCE_PUBLIC_GITHUB_READ_CONFIG, "utf8"));
    config.endpoint = `https://127.0.0.1:${port}`;
    const configPath = path.join(fixture.directory, "untrusted-transport.json");
    await writeFile(configPath, JSON.stringify(config));
    await assert.rejects(
      fixture.git(
        { ...env, OCE_PUBLIC_GITHUB_READ_CONFIG: configPath, GIT_SSL_NO_VERIFY: "1" },
        "-c",
        `http.${config.endpoint}/git/example/project.git.sslVerify=false`,
        "ls-remote",
        "https://github.com/example/project.git",
      ),
      { code: 128 },
    );
    assert.deepEqual(received, []);
  });
  await t.test("redirect refusal", async () => {
    const redirected = [];
    const destination = https.createServer(fixture.serviceTls, (req, res) => {
      redirected.push(req.url);
      res.writeHead(404).end();
    });
    const destinationPort = await listen(t, destination);
    fixture.reader.removeAllListeners("request");
    fixture.reader.on("request", (_req, res) =>
      res.writeHead(302, { location: `https://127.0.0.1:${destinationPort}/destination` }).end(),
    );
    await assert.rejects(
      fixture.git(
        env,
        "-c",
        `http.${fixture.endpoint}/git/example/project.git.followRedirects=true`,
        "ls-remote",
        "https://github.com/example/project.git",
      ),
      { code: 128 },
    );
    assert.deepEqual(redirected, []);
  });
});

test("trusted exact authenticated bindings delegate ordinary URLs and credentials to the original Git helper", async (t) => {
  const fixture = await materialFixture(t);
  const directTls = await selfSigned(fixture.directory, {
    name: "authenticated",
    commonName: "github.com",
    subjectAltName: "DNS:github.com",
  });
  const directRequests = [];
  const direct = https.createServer(directTls, (req, res) => {
    directRequests.push({ url: req.url, headers: req.headers });
    if (
      req.url.startsWith("/example/material-bound.git/") &&
      req.headers.authorization !==
        "Basic " + Buffer.from("fixture-delegate:fixture-delegate").toString("base64")
    ) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="authenticated-provider"' }).end();
      return;
    }
    if (req.url.includes("/info/refs")) {
      res
        .writeHead(200, { "content-type": "text/plain" })
        .end("a".repeat(40) + "\trefs/heads/main\n");
    } else {
      res.writeHead(200, { "content-type": "text/plain" }).end("ref: refs/heads/main\n");
    }
  });
  const directPort = await listen(t, direct);
  const tunnels = new Set();
  const destinations = [];
  const proxy = http.createServer();
  proxy.on("connect", (req, socket, head) => {
    const readerDestination = new URL(fixture.endpoint).host;
    assert.ok(req.url === "github.com:443" || req.url === readerDestination);
    destinations.push(req.url);
    const upstream = net.connect(
      req.url === "github.com:443" ? directPort : Number(new URL(fixture.endpoint).port),
      "127.0.0.1",
      () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      },
    );
    tunnels.add(socket);
    tunnels.add(upstream);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => {
      tunnels.delete(socket);
      upstream.destroy();
    });
    upstream.on("close", () => tunnels.delete(upstream));
  });
  const proxyPort = await listen(t, proxy);
  t.after(() => {
    for (const socket of tunnels) {
      socket.destroy();
    }
  });
  const material = JSON.parse(await readFile(fixture.materialPath, "utf8"));
  material.authenticatedRepositories = ["example/material-bound"];
  await writeFile(fixture.materialPath, JSON.stringify(material));
  const env = await fixture.install({
    HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    https_proxy: `http://127.0.0.1:${proxyPort}`,
    NO_PROXY: "",
    no_proxy: "",
    GIT_SSL_CAINFO: directTls.certPath,
    OCE_PUBLIC_GITHUB_AUTHENTICATED_REPOSITORIES: JSON.stringify(["Example/Private"]),
  });
  const url = "https://github.com/example/private.git";
  // Authenticated delegation never needs public-operation scratch.
  const boundEnv = { ...env, OPENCLAW_WORKSPACE_DIR: "invalid-public-scratch" };
  const result = await fixture.git(
    boundEnv,
    "-c",
    "http.https://github.com/.extraHeader=Authorization: Bearer fixture-authenticated",
    "ls-remote",
    url,
  );
  assert.match(result.stdout, /refs\/heads\/main/);
  assert.ok(directRequests.length > 0);
  assert.equal(directRequests[0].url, "/example/private.git/info/refs?service=git-upload-pack");
  assert.equal(directRequests[0].headers.authorization, "Bearer fixture-authenticated");
  const askpass = path.join(fixture.directory, "bound-askpass");
  const marker = path.join(fixture.directory, "bound-askpass-called");
  await writeFile(askpass, `#!/bin/sh\nprintf invoked > '${marker}'\nprintf fixture-delegate\n`, {
    mode: 0o700,
  });
  await fixture.git(
    { ...boundEnv, GIT_ASKPASS: askpass },
    "ls-remote",
    "https://github.com/example/material-bound.git",
  );
  assert.equal(await readFile(marker, "utf8"), "invoked");
  assert.ok(
    directRequests.some((request) => request.url.startsWith("/example/material-bound.git/")),
  );
  assert.equal(fixture.requests.length, 0);
  await fixture.git(env, "ls-remote", "https://github.com/example/project.git");
  const count = directRequests.length;
  await assert.rejects(
    fixture.git(env, "ls-remote", "https://github.com/example/private-other.git"),
    { code: 128 },
  );
  assert.equal(directRequests.length, count, "a name prefix must not grant an authenticated route");
  assert.ok(fixture.requests.length > 0);
  assert.ok(
    destinations.includes(new URL(fixture.endpoint).host),
    "public requests retain the environment proxy route",
  );
});

test("launcher material refuses arbitrary capability environments and credential helpers cannot answer public reader challenges", async (t) => {
  const fixture = await materialFixture(t);
  await t.test("invalid capability environment", async () => {
    await assert.rejects(
      fixture.install({ OCE_PUBLIC_GITHUB_READ_CAPABILITY: "unscoped-placeholder" }),
      { code: 1 },
    );
  });
  await t.test("repository credential helper", async () => {
    const env = await fixture.install();
    const marker = path.join(fixture.directory, "credential-helper-called");
    fixture.reader.removeAllListeners("request");
    fixture.reader.on("request", (_req, res) =>
      res.writeHead(401, { "www-authenticate": 'Basic realm="reader"' }).end(),
    );
    const global = path.join(fixture.directory, "credential-helper.gitconfig");
    await execute(
      "git",
      [
        "config",
        "--file",
        global,
        `credential.${fixture.endpoint}/git/example/project.git.helper`,
        `!printf invoked > '${marker}'`,
      ],
      { env },
    );
    await assert.rejects(
      fixture.git(
        { ...env, GIT_CONFIG_GLOBAL: global },
        "-c",
        `credential.${fixture.endpoint}/git/example/project.git.helper=!printf invoked > '${marker}'`,
        "ls-remote",
        "https://github.com/example/project.git",
      ),
      { code: 128 },
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  });
  await t.test("askpass cannot supply unrelated GitHub credentials", async () => {
    const env = await fixture.install();
    const marker = path.join(fixture.directory, "askpass-called");
    const askpass = path.join(fixture.directory, "askpass");
    await writeFile(askpass, `#!/bin/sh\nprintf invoked > '${marker}'\nprintf fixture-password\n`, {
      mode: 0o700,
    });
    await assert.rejects(
      fixture.git(
        { ...env, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass },
        "-c",
        `core.askPass=${askpass}`,
        "ls-remote",
        "https://github.com/example/project.git",
      ),
      { code: 128 },
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  });
});

test("public Git refuses inherited client TLS identities instead of disclosing them to the reader", async (t) => {
  const fixture = await materialFixture(t);
  const env = await fixture.install();
  const peerIdentities = [];
  const client = await selfSigned(fixture.directory, {
    name: "client",
    commonName: "fixture-client",
  });
  const destination = https.createServer(
    { ...fixture.serviceTls, ca: client.cert, requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      peerIdentities.push(req.socket.getPeerCertificate().subject?.CN);
      res.writeHead(404).end();
    },
  );
  const port = await listen(t, destination);
  const config = JSON.parse(await readFile(env.OCE_PUBLIC_GITHUB_READ_CONFIG, "utf8"));
  config.endpoint = `https://127.0.0.1:${port}`;
  const configPath = path.join(fixture.directory, "client-identity-config.json");
  await writeFile(configPath, JSON.stringify(config));
  const global = path.join(fixture.directory, "client-identity.gitconfig");
  await execute(
    "git",
    [
      "config",
      "--file",
      global,
      `http.${config.endpoint}/git/example/project.git.sslCert`,
      client.certPath,
    ],
    { env },
  );
  await execute(
    "git",
    [
      "config",
      "--file",
      global,
      `http.${config.endpoint}/git/example/project.git.sslKey`,
      client.keyPath,
    ],
    { env },
  );
  await assert.rejects(
    fixture.git(
      {
        ...env,
        GIT_CONFIG: "/dev/null",
        GIT_CONFIG_GLOBAL: global,
        OCE_PUBLIC_GITHUB_READ_CONFIG: configPath,
      },
      "ls-remote",
      "https://github.com/example/project.git",
    ),
    { code: 128 },
  );
  assert.deepEqual(
    peerIdentities,
    [],
    "client identity settings must fail closed before contacting the reader",
  );
});

test("launcher accepts the supported CA bundle and routing-list sizes while bounding material input", async (t) => {
  const fixture = await materialFixture(t);
  const material = JSON.parse(await readFile(fixture.materialPath, "utf8"));
  material.caBundle = fixture.serviceTls.cert.repeat(
    Math.floor((65 * 1024) / Buffer.byteLength(fixture.serviceTls.cert)),
  );
  material.authenticatedRepositories = Array.from(
    { length: 256 },
    (_, index) => `other-owner/repository-${index}`,
  );
  const bytes = JSON.stringify(material);
  assert.ok(Buffer.byteLength(material.caBundle) <= 65 * 1024);
  assert.ok(Buffer.byteLength(bytes) > 64 * 1024);
  await writeFile(fixture.materialPath, bytes);
  const env = await fixture.install();
  await fixture.git(env, "ls-remote", "https://github.com/example/project.git");
  const before = fixture.requests.length;
  await writeFile(fixture.materialPath, Buffer.alloc(1024 * 1024 + 1, 32));
  await assert.rejects(fixture.install(), /refused/);
  assert.equal(fixture.requests.length, before);
});

test("managed refusals report only fixed operation phases and codes before contact", async (t) => {
  const fixture = await materialFixture(t);
  const env = await fixture.install();
  const script = path.join(env.GIT_EXEC_PATH, "transport.mjs");
  const args = [script, "--api-get", "/repos/example/project/pulls/27"];
  const privatePath = path.join(fixture.directory, "private-diagnostic-sentinel");
  await writeFile(privatePath, "private-diagnostic-sentinel");
  const malformed = path.join(fixture.directory, "invalid-config.json");
  await writeFile(malformed, '{"private-diagnostic-sentinel":');
  const cases = [
    [{ OCE_PUBLIC_GITHUB_READ_CONFIG: privatePath + "-absent" }, "configuration", "ENOENT"],
    [{ OCE_PUBLIC_GITHUB_READ_CONFIG: malformed }, "configuration", "SYNTAX_ERROR"],
    [
      { OCE_PUBLIC_GITHUB_READ_CAPABILITY: "private-diagnostic-sentinel" },
      "authorization",
      "unknown",
    ],
    [{ CURL_CA_BUNDLE: privatePath + "-absent" }, "trust-input", "ENOENT"],
    [{ CURL_CA_BUNDLE: privatePath }, "trust-composition", "unknown"],
    ...(process.platform === "linux"
      ? []
      : [[{ TMPDIR: privatePath + "-absent" }, "trust-files", "ENOENT"]]),
  ];
  for (const [overrides, phase, code] of cases) {
    const failure = await execute(process.execPath, args, { env: { ...env, ...overrides } }).then(
      () => assert.fail("invalid operation must refuse"),
      (error) => error,
    );
    assert.equal(failure.code, 1);
    assert.equal(failure.stdout, "");
    assert.equal(
      failure.stderr,
      "The managed public Git transport refused this invocation.\n" +
        `public-git-refusal:${phase}:${code}\n`,
    );
    assert.doesNotMatch(failure.stderr, /private-diagnostic-sentinel/);
    assert.ok(!failure.stderr.includes(fixture.token));
    assert.equal(
      (await readdir(fixture.directory)).some((entry) => entry.startsWith("oce-public-trust-")),
      false,
    );
  }
  assert.equal(fixture.requests.length, 0);
  // A legitimate API call still succeeds and cleans its operation bundle.
  const success = await execute(process.execPath, args, { env });
  assert.equal(JSON.parse(success.stdout).title, "provider-only-pull");
  assert.equal(success.stderr, "");
  assert.equal(
    (await readdir(fixture.directory)).some((entry) => entry.startsWith("oce-public-trust-")),
    false,
  );
});
