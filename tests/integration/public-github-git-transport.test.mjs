import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  key.startsWith("OCE_PUBLIC_GITHUB_") || key === "GIT_EXEC_PATH" || key === "PATH"))));`;

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
  const connect = https.Agent.prototype.createConnection;
  t.mock.method(https.Agent.prototype, "createConnection", function (options, callback) {
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
  const result = await fixture.git(
    env,
    "-c",
    "http.https://github.com/.extraHeader=Authorization: Bearer fixture-authenticated",
    "ls-remote",
    url,
  );
  assert.match(result.stdout, /refs\/heads\/main/);
  assert.ok(directRequests.length > 0);
  assert.equal(directRequests[0].url, "/example/private.git/info/refs?service=git-upload-pack");
  assert.equal(directRequests[0].headers.authorization, "Bearer fixture-authenticated");
  await fixture.git(env, "ls-remote", "https://github.com/example/material-bound.git");
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
