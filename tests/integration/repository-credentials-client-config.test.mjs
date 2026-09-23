import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { connect } from "node:net";
import {
  writeClientConfiguration,
  encodeRepositoryCredentialSessionFiles,
} from "../../apps/controller/src/drivers/repo/github/credentials/client/config.ts";
import {
  prepareNativeGitConfiguration,
  renderNativeGitConfiguration,
} from "../../apps/controller/src/drivers/repo/github/credentials/client/native-git.ts";
import { readRuntimeRepositoryManifest } from "../../apps/controller/src/drivers/repo/github/credentials/client/manifest.ts";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.mjs";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";
import {
  cleanEnvironment,
  listen,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";

const launcher = resolve("apps/controller/src/drivers/repo/github/credentials/client/launch.ts");
const helper = resolve("apps/controller/src/drivers/repo/github/credentials/client/git-helper.ts");
const opened = {
  session: { sessionId: "session-test", deadlineWallMs: Date.now() + 86400000 },
  bearer: "controlled_gateway_bearer_0000000000000000000000",
  client: {
    gatewayOrigin: "https://credentials.example.test",
    gitRemote: "https://credentials.example.test/example/project.git",
    gitUsername: "gateway-session",
    canonicalApiHost: "github.com",
    apiHost: "credentials.example.test",
    repository: "example/project",
  },
};
const protocol = (path = "example/project.git", extra = "") =>
  `protocol=https\nhost=credentials.example.test\npath=${path}\n${extra}\n`;
const gitEnvironment = (root, extra = {}) => {
  const env = cleanEnvironment({
    HOME: root,
    GIT_CONFIG_SYSTEM: join(root, "gitconfig"),
    ...extra,
  });
  delete env.GIT_CONFIG_NOSYSTEM;
  return env;
};
const git = (root, args, input, extra) =>
  run("/usr/bin/git", args, { env: gitEnvironment(root, extra), input, allowFailure: true });

test("push-ref policies use the existing complete client metadata size limit", () => {
  const encode = (rules) =>
    encodeRepositoryCredentialSessionFiles({
      ...opened,
      client: { ...opened.client, pushRefAllowlist: rules },
    });
  const rules = Array.from(
    { length: 40 },
    (_, index) => `refs/heads/${"topic/".repeat(45)}${index}`,
  );
  assert.equal(JSON.parse(encode(rules)["client.json"]).client.pushRefAllowlist.length, 40);
  assert.throws(() => encode([...rules, ...rules]), /client-configuration-too-large/);
});

// The actual credential protocol protects endpoint authority, independent of Git command spelling.
test("generated native configuration selects exact endpoint authority through stock Git", async (t) => {
  const material = await createNativeClientMaterial(t, [{ opened, repositoryRef: "project" }]);
  assert.equal(material.config.includes(opened.bearer), false);
  for (const file of ["bearer", "client.json", "gitconfig", "gh/hosts.yml", "gh/config.yml"]) {
    assert.equal(
      (await lstat(join(material.manifest.bindings[0].directory, file))).mode & 0o777,
      0o600,
    );
  }
  for (const path of [
    "example/project",
    "EXAMPLE/PrOjEcT.git",
    "example/project.git",
    "example/project.git/",
  ]) {
    const result = await git(material.root, ["credential", "fill"], protocol(path));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.includes(`password=${opened.bearer}\n`), true);
    assert.equal(result.stderr.includes(opened.bearer), false);
    const url = await git(material.root, ["ls-remote", "--get-url", `https://github.com/${path}`]);
    assert.equal(url.stdout.trim(), `https://credentials.example.test/${path}`);
  }
  // The host rewrite routes unknown names too, but the helper grants no authority to them.
  for (const input of [
    protocol("example/other.git"),
    protocol("example/project.git/extra"),
    protocol("example/project.git.git"),
    protocol("example/%70roject.git"),
    protocol("example/../project.git"),
    protocol("example/project.git-extra"),
    protocol("example/project.git", "username=other\n"),
    protocol().replace("protocol=https", "protocol=http"),
    protocol().replace("host=credentials.example.test", "host=credentials.example.test:443"),
    protocol().replace("host=credentials.example.test", "host=elsewhere.example.test"),
  ]) {
    const result = await git(material.root, ["credential", "fill"], input);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.includes(opened.bearer), false);
    assert.equal(result.stderr.includes(opened.bearer), false);
  }
  for (const input of [
    protocol() + "path=example/project.git\n",
    protocol().replace("\n\n", "\npath=example/project.git\n\n"),
    "x=" + "a".repeat(17000) + "\n\n",
    protocol().replace("example/project.git", "example/project.git\r"),
  ]) {
    const result = await run(
      process.execPath,
      [helper, "manifest", material.root, material.manifest.generation, "get"],
      { env: cleanEnvironment(), input, allowFailure: true },
    );
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "credential-helper-failed\n");
  }
  for (const operation of ["store", "erase"]) {
    const result = await run(
      process.execPath,
      [helper, "manifest", "/absent", "invalid", operation],
      { env: cleanEnvironment(), input: "ignored\n", allowFailure: true },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  }
});

test("single-session operator helper remains usable and rejects unsafe material", async (t) => {
  const parent = await temporaryDirectory(t);
  const session = join(parent, "session");
  await writeClientConfiguration(opened, session, undefined);
  const invoke = (command, args = [], input) =>
    run(process.execPath, [launcher, session, command, ...args], {
      env: cleanEnvironment({ HOME: parent }),
      input,
      allowFailure: true,
    });
  const filled = await invoke("git", ["credential", "fill"], protocol());
  assert.equal(filled.code, 0, filled.stderr);
  assert.equal(filled.stdout.includes(opened.bearer), true);
  const denied = await invoke("gh", ["api", "https://api.github.com/repos/example/project"]);
  assert.notEqual(denied.code, 0);
  assert.equal(denied.stdout, "");
  await assert.rejects(
    writeClientConfiguration(opened, session, undefined),
    /client-directory-exists/,
  );
  const unsafe = join(parent, "unsafe");
  await mkdir(unsafe);
  await chmod(unsafe, 0o755);
  await assert.rejects(
    writeClientConfiguration(opened, join(unsafe, "session"), undefined),
    /unsafe-client-directory/,
  );
  const alias = join(parent, "alias");
  await symlink(parent, alias);
  await assert.rejects(
    writeClientConfiguration(opened, join(alias, "session"), undefined),
    /unsafe-client-directory/,
  );
  const bearer = join(session, "bearer");
  await rename(bearer, `${bearer}.saved`);
  for (const makeUnsafe of [
    () => symlink(`${bearer}.saved`, bearer),
    () => link(`${bearer}.saved`, bearer),
    async () => {
      await writeFile(bearer, opened.bearer);
      await chmod(bearer, 0o644);
    },
  ]) {
    await makeUnsafe();
    const result = await invoke("git", ["credential", "fill"], protocol());
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.includes(opened.bearer), false);
    await rm(bearer);
  }
});

test("native preparer validates staged identity and writes exclusive final-path configuration", async (t) => {
  const material = await createNativeClientMaterial(t, [{ opened, repositoryRef: "project" }]);
  await rm(join(material.root, "gitconfig"));
  const finalRoot = join(material.root, "final destination 'quoted'");
  const staged = JSON.parse(await readFile(join(material.root, "manifest.json"), "utf8"));
  staged.bindings[0].directory = staged.bindings[0].directory.replace(material.root, finalRoot);
  await writeFile(join(material.root, "manifest.json"), JSON.stringify(staged), { mode: 0o600 });
  await prepareNativeGitConfiguration(material.root, finalRoot);
  const emitted = await readFile(join(material.root, "gitconfig"), "utf8");
  assert.equal((await lstat(join(material.root, "gitconfig"))).mode & 0o777, 0o600);
  assert.equal(emitted.includes(opened.bearer), false);
  const parsed = await git(material.root, [
    "config",
    "--get-all",
    "credential.https://credentials.example.test.helper",
  ]);
  assert.equal(parsed.code, 0, parsed.stderr);
  assert.match(parsed.stdout, /git-helper\.js.*manifest/);
  await assert.rejects(prepareNativeGitConfiguration(material.root, finalRoot), /EEXIST/);
  await rm(join(material.root, "gitconfig"));
  await symlink(join(material.root, "manifest.json"), join(material.root, "gitconfig"));
  await assert.rejects(prepareNativeGitConfiguration(material.root, finalRoot), /EEXIST/);
  await rm(join(material.root, "gitconfig"));
  staged.bindings[0].client.repository = "example/other";
  await writeFile(join(material.root, "manifest.json"), JSON.stringify(staged), { mode: 0o600 });
  await assert.rejects(
    prepareNativeGitConfiguration(material.root, finalRoot),
    /invalid-repository-material/,
  );
  await assert.rejects(lstat(join(material.root, "gitconfig")), /ENOENT/);
});

test("same-origin trust and canonical host conflicts prevent native configuration publication", async (t) => {
  const second = { ...opened, session: { ...opened.session, sessionId: "second" } };
  await assert.rejects(
    createNativeClientMaterial(t, [
      { opened, repositoryRef: "first", publicCa: Buffer.from("public-ca-one") },
      { opened: second, repositoryRef: "second", publicCa: Buffer.from("public-ca-two") },
    ]),
    /conflicting-gateway-trust/,
  );
  await assert.rejects(
    createNativeClientMaterial(t, [
      { opened, repositoryRef: "first" },
      {
        opened: {
          ...second,
          client: {
            ...second.client,
            gatewayOrigin: "https://other.example.test",
            gitRemote: "https://other.example.test/example/project.git",
            apiHost: "other.example.test",
          },
        },
        repositoryRef: "second",
      },
    ]),
    /multiple-gateway-origins-for-host/,
  );
  const material = await createNativeClientMaterial(t, [{ opened, repositoryRef: "project" }]);
  // Shell quoting and Git config quoting are independent; run the emitted helper from a quoted path.
  const quotedRoot = join(material.root, "client 'quoted'");
  const quotedDirectory = join(quotedRoot, "github/credentials/client");
  await mkdir(join(quotedRoot, "credentials"), { recursive: true });
  await cp(
    resolve("apps/controller/src/drivers/repo/credentials/client-contracts.ts"),
    join(quotedRoot, "credentials/client-contracts.ts"),
  );
  await cp(resolve("apps/controller/src/drivers/repo/github/credentials/client"), quotedDirectory, {
    recursive: true,
  });
  const quoted = join(quotedDirectory, "git-helper.ts");
  const config = await renderNativeGitConfiguration(
    await readRuntimeRepositoryManifest(material.root),
    material.root,
    { node: process.execPath, helper: quoted },
  );
  await writeFile(join(material.root, "gitconfig"), config, { mode: 0o600 });
  const result = await git(material.root, ["credential", "fill"], protocol());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.includes(opened.bearer), true);
});

test(
  "actual native Git uses generated TLS and redirect defaults",
  { timeout: 30000 },
  async (t) => {
    const parent = await temporaryDirectory(t);
    const key = join(parent, "key.pem");
    const cert = join(parent, "cert.pem");
    const generated = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const requests = [];
    let redirect = false;
    const server = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (request, response) => {
        requests.push({ url: request.url, authorization: request.headers.authorization });
        response.writeHead(
          redirect ? 302 : request.headers.authorization ? 403 : 401,
          redirect ? { location: "/redirected" } : { "www-authenticate": 'Basic realm="fixture"' },
        );
        response.end();
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
    );
    const origin = `https://127.0.0.1:${server.address().port}`;
    const input = {
      ...opened,
      client: {
        ...opened.client,
        gatewayOrigin: origin,
        gitRemote: `${origin}/example/project.git`,
        apiHost: "127.0.0.1",
      },
    };
    const untrusted = await createNativeClientMaterial(t, [
      { opened: input, repositoryRef: "project" },
    ]);
    const trusted = await createNativeClientMaterial(
      t,
      [{ opened: input, repositoryRef: "project" }],
      { ca: await readFile(cert) },
    );
    const refused = await git(untrusted.root, ["ls-remote", "https://github.com/example/project"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /certificate|SSL/i);
    assert.equal(requests.length, 0);
    for (const path of ["example/project", "ExAmPlE/PrOjEcT.git"]) {
      requests.length = 0;
      const authenticated = await git(trusted.root, ["ls-remote", `https://github.com/${path}`]);
      assert.notEqual(authenticated.code, 0); // The controlled HTTPS peer deliberately returns 403 after authentication.
      assert.equal(requests.length, 2, authenticated.stderr);
      assert.equal(requests[0].authorization, undefined);
      assert.equal(
        requests[1].authorization,
        `Basic ${Buffer.from(`${opened.client.gitUsername}:${opened.bearer}`).toString("base64")}`,
      );
      assert.ok(requests.every(({ url }) => url.startsWith(`/${path}/info/refs?`)));
      assert.equal(authenticated.stderr.includes(opened.bearer), false);
    }
    requests.length = 0;
    redirect = true;
    const redirected = await git(trusted.root, ["ls-remote", input.client.gitRemote]);
    assert.notEqual(redirected.code, 0);
    assert.equal(requests.length, 1, redirected.stderr);
    assert.equal(requests[0].authorization, undefined);
  },
);

test("encoded session files support the actual client without the operator writer", async (t) => {
  const parent = await temporaryDirectory(t);
  await mkdir(join(parent, "gh"), { mode: 0o700 });
  const files = encodeRepositoryCredentialSessionFiles(opened);
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(parent, name), value, { mode: 0o600 });
  }
  const result = await run(process.execPath, [launcher, parent, "git", "credential", "fill"], {
    env: cleanEnvironment({ HOME: parent }),
    input: protocol(),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`password=${opened.bearer}\n`));
  assert.equal(result.stderr.includes(opened.bearer), false);
  assert.equal(JSON.parse(files["client.json"]).hasPublicCa, false);
});

test("operator rejects unsafe or conflicting bound request files before admission", async (t) => {
  const parent = await temporaryDirectory(t);
  const requestPath = join(parent, "request.json");
  const socket = join(parent, "control.sock");
  const requests = [];
  // Observe the actual operator's HTTP boundary; this does not emulate admission.
  const server = createHttpServer(async (incoming, response) => {
    let body = "";
    for await (const chunk of incoming) {
      body += chunk;
    }
    requests.push({ method: incoming.method, path: incoming.url, body: JSON.parse(body) });
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not-found" }));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(socket);
  await once(server, "listening");
  const request = {
    namespaceId: "namespace-test",
    repositoryRef: "project",
    durationSeconds: 60,
    profile: "git-read",
    deadlineWallMs: Date.now() + 60_000,
    expectedBinding: {
      providerInstanceId: "provider-test",
      repositoryId: "repository-test",
      grantId: "grant-test",
    },
  };
  const invoke = (path, extra = []) =>
    run(
      process.execPath,
      [
        resolve("apps/controller/src/drivers/repo/github/credentials/client/operator.ts"),
        "open",
        "--socket",
        socket,
        "--output",
        join(parent, "session"),
        "--request-json",
        path,
        ...extra,
      ],
      { allowFailure: true },
    );
  const failed = (result) => {
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "credential-operator-failed\n");
  };
  // A valid request must reach the peer, so a dead socket cannot satisfy the
  // subsequent assertions that invalid files are rejected before admission.
  await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
  const admitted = await invoke(requestPath);
  assert.equal(admitted.code, 1);
  assert.equal(admitted.stdout, "");
  assert.match(
    admitted.stderr,
    /^credential-admission [0-9]{13}-[0-9a-f-]{36}; recover with open --admission-id and the same inputs\ncredential-operator-not-found\n$/,
  );
  assert.deepEqual(requests, [{ method: "POST", path: "/v1/sessions", body: request }]);
  requests.length = 0;
  const refused = (result) => {
    failed(result);
    assert.equal(requests.length, 0, "invalid request reached admission");
  };
  for (const value of [
    { ...request, bearer: "unexpected-secret-field" },
    { ...request, recoverOnly: false },
    { ...request, expectedBinding: { ...request.expectedBinding, token: "unexpected" } },
    { ...request, deadlineWallMs: "60000" },
  ]) {
    await writeFile(requestPath, JSON.stringify(value), { mode: 0o600 });
    refused(await invoke(requestPath));
  }
  await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
  for (const extra of [
    ["--duration-seconds", "60"],
    ["--profile", "git-read"],
  ]) {
    refused(await invoke(requestPath, extra));
  }
  await chmod(requestPath, 0o644);
  refused(await invoke(requestPath));
  await chmod(requestPath, 0o600);
  const alias = join(parent, "alias.json");
  await symlink(requestPath, alias);
  refused(await invoke(alias));
});

test(
  "native push policy protects every destination and preserves common-directory hooks",
  { timeout: 60000 },
  async (t) => {
    const reservation = createHttpServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    const origin = "https://localhost";
    const fixture = await startRegistryCredentialServiceFixture(t, {
      gateway: { listen: "127.0.0.1:" + port, publicOrigin: origin },
      repositories: [
        {
          repositoryRef: "guarded",
          repositoryId: "73",
          repository: "fixture/repository",
          pushRefAllowlist: ["refs/heads/exact", "refs/heads/agent/*"],
        },
        {
          repositoryRef: "denied",
          repositoryId: "74",
          repository: "fixture/other",
          pushRefAllowlist: [],
        },
        { repositoryRef: "ordinary", repositoryId: "75", repository: "fixture/ordinary" },
      ],
    });
    const material = await createNativeClientMaterial(
      t,
      fixture.repositories.map((entry) => ({
        opened: entry.opened,
        repositoryRef: entry.repositoryRef,
        publicCa: fixture.tls.ca,
      })),
    );
    const work = await temporaryDirectory(t);
    // Preserve the service's canonical HTTPS origin while tunneling stock Git to
    // its ephemeral loopback listener. TLS, authentication and Git RPC remain real.
    const proxy = createHttpServer();
    proxy.on("connect", (request, socket, head) => {
      if (request.url !== "localhost:443") {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = connect(port, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    });
    const proxyOrigin = (await listen(t, proxy)).replace("https:", "http:");
    const env = gitEnvironment(material.root, { https_proxy: proxyOrigin });
    const invoke = (args, options = {}) =>
      run("/usr/bin/git", args, { env, cwd: work, ...options });
    const guarded = fixture.byRef.get("guarded");
    const snapshot = async () =>
      (
        await run("/usr/bin/git", ["for-each-ref", "--format=%(refname) %(objectname)"], {
          cwd: guarded.git.bare,
        })
      ).stdout;
    await invoke(["clone", "https://github.com/fixture/repository.git", "checkout"]);
    const checkout = join(work, "checkout");
    await invoke(["-C", checkout, "config", "user.name", "Native fixture"]);
    await invoke(["-C", checkout, "config", "user.email", "fixture@example.test"]);
    const marker = join(work, "pre-commit");
    const pushedInput = join(work, "pre-push");
    const pushedArguments = join(work, "pre-push-arguments");
    await writeFile(
      join(checkout, ".git/hooks/pre-commit"),
      "#!/bin/sh\nprintf 'called\\n' >> '" + marker + "'\n",
      { mode: 0o755 },
    );
    await writeFile(
      join(checkout, ".git/hooks/pre-push"),
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > '" + pushedArguments + "'\ncat > '" + pushedInput + "'\n",
      { mode: 0o755 },
    );
    await invoke(["-C", checkout, "commit", "--allow-empty", "-m", "Ordinary checkout commit"]);
    assert.equal(await readFile(marker, "utf8"), "called\n");
    const linked = join(work, "linked");
    await invoke(["-C", checkout, "worktree", "add", "--detach", linked]);
    await invoke(["-C", linked, "commit", "--allow-empty", "-m", "Linked worktree commit"]);
    assert.equal(await readFile(marker, "utf8"), "called\ncalled\n");
    const head = (await invoke(["-C", linked, "rev-parse", "HEAD"])).stdout.trim();
    await invoke(["-C", linked, "push", "origin", "HEAD:refs/heads/exact"]);
    assert.equal(await guarded.git.ref("refs/heads/exact"), head);
    assert.equal(
      await readFile(pushedArguments, "utf8"),
      "origin\nhttps://localhost/fixture/repository.git\n",
    );
    assert.equal(
      await readFile(pushedInput, "utf8"),
      "HEAD " + head + " refs/heads/exact " + "0".repeat(40) + "\n",
    );
    await invoke(["-C", linked, "push", "origin", "+HEAD:refs/heads/agent/one"]);
    assert.equal(await guarded.git.ref("refs/heads/agent/one"), head);
    // Equivalent native HTTPS spellings retain the same allowlist decision.
    for (const [index, destination] of [
      "https://github.com/fixture/repository.git/",
      "https://github.com/fixture/repository/",
      "https://gateway-session@localhost/fixture/repository.git",
      "https://gateway-session@localhost/fixture/repository.git/",
    ].entries()) {
      const ref = `refs/heads/agent/spelling-${index}`;
      await invoke(["-C", linked, "push", destination, "HEAD:" + ref]);
      assert.equal(await guarded.git.ref(ref), head);
      const before = await snapshot();
      const trace = guarded.git.trace.length;
      const denied = await invoke(["-C", linked, "push", destination, "HEAD:refs/heads/main"], {
        allowFailure: true,
      });
      assert.notEqual(denied.code, 0);
      assert.match(denied.stderr, /repository-push-ref-not-allowed/);
      assert.equal(await snapshot(), before);
      assert.equal(
        guarded.git.trace.slice(trace).some(({ path }) => path.endsWith("/git-receive-pack")),
        false,
      );
    }
    for (const refs of [
      ["HEAD:refs/heads/agent/mixed", "HEAD:refs/heads/main"],
      ["HEAD:refs/tags/v1"],
      [":refs/heads/main"],
      ["HEAD:refs/heads/agents/outside"],
    ]) {
      const before = await snapshot();
      const trace = guarded.git.trace.length;
      const result = await invoke(["-C", linked, "push", "origin", ...refs], {
        allowFailure: true,
      });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /repository-push-ref-not-allowed/);
      assert.equal(await snapshot(), before);
      assert.equal(
        guarded.git.trace.slice(trace).some(({ path }) => path.endsWith("/git-receive-pack")),
        false,
      );
    }
    await invoke(["-C", linked, "push", "origin", ":refs/heads/agent/one"]);
    assert.equal(
      (await invoke(["-C", linked, "ls-remote", "origin", "refs/heads/agent/one"])).stdout,
      "",
    );
    const denied = await invoke(
      ["-C", linked, "push", "https://github.com/fixture/other.git", "HEAD:refs/heads/agent/one"],
      { allowFailure: true },
    );
    assert.notEqual(denied.code, 0);
    assert.match(denied.stderr, /repository-push-ref-not-allowed/);
    await invoke([
      "-C",
      linked,
      "push",
      "https://github.com/fixture/ordinary.git",
      "HEAD:refs/heads/ordinary",
    ]);
    assert.equal(await fixture.byRef.get("ordinary").git.ref("refs/heads/ordinary"), head);
    await writeFile(join(checkout, ".git/hooks/pre-push"), "#!/bin/sh\nexit 7\n", {
      mode: 0o755,
    });
    const beforeVeto = await snapshot();
    const vetoTrace = guarded.git.trace.length;
    const vetoed = await invoke(["-C", linked, "push", "origin", "HEAD:refs/heads/agent/vetoed"], {
      allowFailure: true,
    });
    assert.notEqual(vetoed.code, 0);
    assert.equal(await snapshot(), beforeVeto);
    assert.equal(
      guarded.git.trace.slice(vetoTrace).some(({ path }) => path.endsWith("/git-receive-pack")),
      false,
    );
  },
);
