import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { promisify } from "node:util";
import { selfSigned } from "./certificates.mjs";
import { listen } from "./listen.mjs";

const execute = promisify(execFile);

export const publicProviderGit = (cwd, ...args) =>
  execute("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });

// A disposable real Git repository origin over certificate-verified HTTPS.
// Callers route provider DNS/port to it at the TLS connection boundary; product
// code retains its fixed GitHub origin and ordinary certificate verification.
export async function startPublicGithubProvider(
  t,
  { directory, root = path.join(directory, "repositories") },
) {
  await mkdir(root, { recursive: true });
  const { key, cert } = await selfSigned(directory, {
    name: "github-provider",
    commonName: "github.com",
    subjectAltName: "DNS:github.com",
  });
  const fixture = { root, key, cert, requests: [], behavior: "git" };
  const children = new Set();
  const provider = https.createServer({ key, cert }, (req, res) => {
    assert.equal(req.socket.servername, "github.com");
    assert.equal(req.headers.host, "github.com");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers["proxy-authorization"], undefined);
    fixture.requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (fixture.behavior === "private") {
      res.writeHead(404).end("private");
      return;
    }
    if (fixture.behavior === "redirect") {
      res.writeHead(302, { location: "https://unrelated.invalid/repository.git" }).end();
      return;
    }
    if (fixture.behavior === "incomplete") {
      res
        .writeHead(200, {
          "content-type": "application/x-git-upload-pack-advertisement",
          "content-length": "10000",
        })
        .end("0008NAK\n");
      return;
    }
    if (typeof fixture.behavior === "function") {
      fixture.behavior(req, res);
      return;
    }
    const url = new URL(req.url, "https://github.com");
    const backend = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: req.headers["content-length"] ?? "",
        HTTP_GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
        REMOTE_ADDR: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    children.add(backend);
    backend.once("exit", () => children.delete(backend));
    let header = Buffer.alloc(0);
    let sent = false;
    backend.stdout.on("data", (chunk) => {
      if (!sent) {
        header = Buffer.concat([header, chunk]);
        const end = header.indexOf("\r\n\r\n");
        if (end < 0) {
          return;
        }
        const headers = {};
        let status = 200;
        for (const line of header.subarray(0, end).toString().split("\r\n")) {
          const separator = line.indexOf(":");
          const name = line.slice(0, separator).toLowerCase();
          const value = line.slice(separator + 1).trim();
          if (name === "status") {
            status = Number(value.slice(0, 3));
          } else {
            headers[name] = value;
          }
        }
        res.writeHead(status, headers);
        sent = true;
        chunk = header.subarray(end + 4);
      }
      if (!res.write(chunk)) {
        backend.stdout.pause();
      }
    });
    res.on("drain", () => backend.stdout.resume());
    backend.stdout.once("end", () => res.end());
    backend.on("error", () => res.destroy());
    backend.stdin.on("error", () => {});
    req.pipe(backend.stdin);
    res.once("close", () => backend.kill());
  });
  fixture.provider = provider;
  fixture.port = await listen(t, provider);
  t.after(() => {
    for (const child of children) {
      child.kill();
    }
  });
  fixture.createRepository = async (repository, files = { "readme.txt": "first object\n" }) => {
    assert.match(repository, /^[\w-]+\/[\w.-]+$/);
    const source = path.join(directory, "sources", repository);
    await mkdir(source, { recursive: true });
    await mkdir(path.dirname(path.join(root, repository)), { recursive: true });
    await publicProviderGit(source, "init", "--initial-branch=main");
    await publicProviderGit(source, "config", "user.name", "Public Reader Test");
    await publicProviderGit(source, "config", "user.email", "public-reader@example.test");
    for (const [name, content] of Object.entries(files)) {
      assert.ok(!path.isAbsolute(name) && !name.split("/").includes(".."));
      await mkdir(path.dirname(path.join(source, name)), { recursive: true });
      await writeFile(path.join(source, name), content);
    }
    await publicProviderGit(source, "add", ".");
    await publicProviderGit(source, "commit", "-m", "First object");
    await publicProviderGit(
      source,
      "clone",
      "--bare",
      source,
      path.join(root, repository + ".git"),
    );
    return source;
  };
  return fixture;
}
