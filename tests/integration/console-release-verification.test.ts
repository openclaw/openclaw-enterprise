import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderConsoleThemeShell } from "../../apps/controller/src/console-theme.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { caAndLeaf } from "../helpers/certificates.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

test("Console release verification checks delivered markup and complete HTTP messages over trusted TLS", async (t) => {
  const directory = await temporaryDirectory(t, "occ-console-release-");
  const revision = (
    await execute("git", ["--no-lazy-fetch", "rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  const source = "apps/controller/src/console/";
  const html = (
    await execute("git", ["--no-lazy-fetch", "show", `${revision}:${source}index.html`], {
      cwd: root,
    })
  ).stdout;
  const css = (
    await execute("git", ["--no-lazy-fetch", "show", `${revision}:${source}console.css`], {
      cwd: root,
    })
  ).stdout;
  await mkdir(join(directory, source), { recursive: true });
  await mkdir(join(directory, "scripts"));
  await writeFile(join(directory, source, "index.html"), html);
  const stamper = join(directory, "scripts/build-console-metadata.mjs");
  await cp(join(root, "scripts/build-console-metadata.mjs"), stamper);
  await execute(process.execPath, [stamper, revision]);
  const stamped = await readFile(join(directory, source, "index.html"), "utf8");
  const themed = renderConsoleThemeShell(stamped, {
    displayName: 'Example <Operations> & "Support"',
    logoUrl: "/console/theme/logo.svg",
    faviconUrl: "/console/theme/favicon.svg",
    appleTouchIconUrl: "/console/theme/apple.png",
    assets: new Map(),
  });
  const tls = await caAndLeaf(directory, {
    caKeyPem: undefined,
    leafKeyPem: undefined,
    caName: "Console fixture CA",
    commonName: "localhost",
    subjectAltName: "IP:127.0.0.1",
  });
  let page = themed;
  let asset = css;
  let status = 200;
  let type = "text/html";
  let incomplete = "";
  let wire: ((body: string, media: string) => string) | undefined;
  let wireAsset = false;
  const requests: string[] = [];
  const server = createServer(
    { key: await readFile(tls.keyPath), cert: await readFile(tls.certPath) },
    (req, res) => {
      assert.equal(req.method, "GET");
      for (const header of ["authorization", "cookie", "proxy-authorization"]) {
        assert.equal(req.headers[header], undefined);
      }
      requests.push(req.url!);
      const isAsset = req.url === "/console/console.css";
      const body = isAsset ? asset : page;
      if (wire && isAsset === wireAsset) {
        res.socket!.end(wire(body, isAsset ? "text/css" : "text/html"));
        return;
      }
      res.writeHead(isAsset ? 200 : status, {
        "Content-Type": isAsset ? "text/css" : type,
        "Content-Length":
          Buffer.byteLength(body) + (incomplete === (isAsset ? "css" : "html") ? 100 : 0),
        Connection: "close",
        Location: syntheticCredentialUrl({
          username: "fixture",
          password: "secret",
          host: "example.invalid",
          port: undefined,
          pathname: "/sign-in",
          search: "?token=secret",
        }),
        "Set-Cookie": "private=secret; Secure",
      });
      res.end(body);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `https://127.0.0.1:${address.port}`;
  async function check(
    expected: string,
    paths: string[],
    url = `${origin}/console/`,
    trust = true,
  ) {
    requests.length = 0;
    const result = await execute(
      "python3",
      [join(root, "scripts/verify-console-release.py"), root, revision, url],
      {
        env: { ...process.env, SSL_CERT_FILE: trust ? tls.caPath : "/dev/null" },
        timeout: 25_000,
        maxBuffer: 4096,
      },
    ).then(
      (value) => ({ ...value, code: 0 }),
      (error) => error,
    );
    assert.equal(result.stderr, "");
    assert.deepEqual([...requests], paths);
    assert.equal(result.code, expected === "verified" ? 0 : 1);
    assert.doesNotMatch(result.stdout, /secret|private|127\.0\.0\.1|https:|<!doctype/i);
    const record = JSON.parse(result.stdout);
    assert.equal(record.result, expected);
    return record;
  }
  const shellOnly = ["/console/"];
  const both = [...shellOnly, "/console/console.css"];
  await t.test(
    "ordinary and real themed shells verify without requesting installation-owned colors",
    async () => {
      for (page of [stamped, themed]) {
        const record = await check("verified", both);
        assert.equal(record.revision, revision);
        assert.equal(record.assetSha256, createHash("sha256").update(css).digest("hex"));
      }
    },
  );
  await t.test(
    "promised source blobs stay absent without fetch attempts or repository mutation",
    async () => {
      // Only the two Console blobs enter this local transport fixture, never the repository tree.
      const originRepo = join(directory, "origin");
      const partial = join(directory, "partial");
      const trace = join(directory, "git-trace.jsonl");
      const git = (cwd: string, args: string[]) =>
        execute("git", ["--no-lazy-fetch", "-C", cwd, ...args], {
          timeout: 5_000,
          maxBuffer: 256 * 1024,
        });
      await mkdir(join(originRepo, source), { recursive: true });
      await git(originRepo, ["init", "--quiet", "--template="]);
      await writeFile(join(originRepo, source, "index.html"), html);
      await writeFile(join(originRepo, source, "console.css"), css);
      await git(originRepo, ["add", "--", source]);
      await git(originRepo, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "-m",
        "Console fixture",
      ]);
      await git(originRepo, ["config", "uploadpack.allowFilter", "true"]);
      const fixtureRevision = (await git(originRepo, ["rev-parse", "HEAD"])).stdout.trim();
      const blobs = await Promise.all(
        ["index.html", "console.css"].map(async (name) =>
          (
            await git(originRepo, ["rev-parse", `${fixtureRevision}:${source}${name}`])
          ).stdout.trim(),
        ),
      );
      await git(directory, [
        "-c",
        "protocol.file.allow=always",
        "clone",
        "--quiet",
        "--no-checkout",
        "--template=",
        "--filter=blob:none",
        `file://${originRepo}`,
        partial,
      ]);
      assert.equal(
        (await git(partial, ["config", "--get", "remote.origin.promisor"])).stdout.trim(),
        "true",
      );
      assert.equal(
        (await git(partial, ["config", "--get", "remote.origin.partialclonefilter"])).stdout.trim(),
        "blob:none",
      );
      // A nonexistent local file remote cannot reach a network or supply credentials.
      await git(partial, ["remote", "set-url", "origin", `file://${join(directory, "offline")}`]);
      const missing = async () =>
        (await git(partial, ["rev-list", "--objects", "--all", "--missing=print"])).stdout
          .split("\n")
          .filter((line) => line.startsWith("?"))
          .map((line) => line.slice(1))
          .sort();
      assert.deepEqual(await missing(), [...blobs].sort());
      const snapshot = async () => {
        const files: Record<string, string> = {};
        async function visit(path: string) {
          const entries = await readdir(join(partial, path), { withFileTypes: true });
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const name = join(path, entry.name);
            const info = await stat(join(partial, name));
            files[name] =
              `${info.mode}:${info.mtimeMs}:` +
              (entry.isDirectory()
                ? ""
                : createHash("sha256")
                    .update(await readFile(join(partial, name)))
                    .digest("hex"));
            if (entry.isDirectory()) {
              await visit(name);
            }
          }
        }
        await visit("");
        return files;
      };
      const before = await snapshot();
      const probe = (repository: string) =>
        execute(
          "python3",
          [
            join(root, "scripts/verify-console-release.py"),
            repository,
            fixtureRevision,
            `${origin}/console/`,
          ],
          {
            env: { ...process.env, SSL_CERT_FILE: tls.caPath, GIT_TRACE2_EVENT: trace },
            timeout: 25_000,
            maxBuffer: 4096,
          },
        ).then(
          (value) => ({ ...value, code: 0 }),
          (error) => error,
        );
      page = themed.replace(revision, fixtureRevision);
      requests.length = 0;
      const full = await probe(originRepo);
      assert.equal(full.code, 0);
      assert.equal(full.stderr, "");
      assert.equal(JSON.parse(full.stdout).result, "verified");
      assert.deepEqual([...requests], both);
      await writeFile(trace, "");
      requests.length = 0;
      const offline = await probe(partial);
      const events = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.event === "start"));
      const fetches = events.filter(
        (event) => event.event === "child_start" && event.argv.includes("fetch"),
      ).length;
      const unchanged = JSON.stringify(await snapshot()) === JSON.stringify(before);
      assert.deepEqual(
        {
          code: offline.code,
          stderr: offline.stderr,
          result: JSON.parse(offline.stdout).result,
          requests: [...requests],
          fetches,
          unchanged,
          missing: await missing(),
        },
        {
          code: 1,
          stderr: "",
          result: "invalid-source",
          requests: [],
          fetches: 0,
          unchanged: true,
          missing: [...blobs].sort(),
        },
      );
      page = themed;
    },
  );
  const marker = `<meta name="occ-build-revision" content="${revision}" />`;
  const link = '<link rel="stylesheet" href="/console/console.css" />';
  for (const [name, broken, expected] of [
    ["body starts inside head", themed.replace("<head>", "<head><body>"), "invalid-html"],
    ["head never closes", themed.replace("</head>", ""), "invalid-html"],
    [
      "marker in template",
      themed.replace(marker, `<template>${marker}</template>`),
      "invalid-html",
    ],
    [
      "disabled stylesheet",
      themed.replace(link, link.replace("<link", "<link disabled")),
      "missing-stylesheet",
    ],
    [
      "print-only stylesheet",
      themed.replace(link, link.replace("<link", '<link media="print"')),
      "missing-stylesheet",
    ],
    [
      "alternate stylesheet",
      themed.replace(link, link.replace('rel="stylesheet"', 'rel="alternate stylesheet"')),
      "missing-stylesheet",
    ],
    ["inert stylesheet", themed.replace(link, `<template>${link}</template>`), "invalid-html"],
    [
      "foreign stylesheet",
      themed.replace(
        link,
        link.replace("/console/console.css", "https://private.invalid/style.css"),
      ),
      "missing-stylesheet",
    ],
    ["marked declaration", themed.replace(marker, "<![private secret]>"), "invalid-html"],
    ["stale revision", themed.replace(revision, "a".repeat(40)), "wrong-revision"],
    ["missing marker", themed.replace(marker, ""), "missing-marker"],
    ["placeholder", themed.replace(revision, "development"), "invalid-marker"],
    ["duplicate marker", themed.replace(marker, marker + marker), "duplicate-marker"],
    [
      "duplicate attribute",
      themed.replace(marker, marker.replace(" />", ' content="bad" />')),
      "invalid-marker",
    ],
    ["commented marker", themed.replace(marker, `<!-- ${marker} -->`), "missing-marker"],
  ] as const) {
    await t.test(name, async () => {
      page = broken;
      await check(expected, shellOnly);
    });
  }
  await t.test("incomplete HTML fails the HTTP gate even with a complete valid head", async () => {
    page = themed.slice(0, themed.indexOf("</head>") + "</head>".length);
    incomplete = "html";
    await check("incomplete-response", shellOnly);
  });
  await t.test(
    "incomplete CSS fails HTTP framing despite all expected CSS bytes arriving",
    async () => {
      page = themed;
      incomplete = "css";
      await check("incomplete-response", both);
      incomplete = "";
      asset = "/* stale */";
      await check("wrong-asset", both);
      asset = css;
    },
  );
  // Exercise raw HTTP over the same trusted TLS connection. HTML refusals must
  // happen before the stylesheet request; CSS refusals must not become verified.
  const headerCases: [string, (media: string, length: number) => string, string?][] = [
    [
      "complete chunked",
      (media) => `Content-Type: ${media}\r\nTransfer-Encoding: chunked`,
      "0\r\n\r\n",
    ],
    [
      "zero chunk missing final CRLF",
      (media) => `Content-Type: ${media}\r\nTransfer-Encoding: chunked`,
      "0\r\n",
    ],
    [
      "truncated trailer",
      (media) => `Content-Type: ${media}\r\nTransfer-Encoding: chunked`,
      "0\r\nX-Final: part",
    ],
    ["close-delimited", (media) => `Content-Type: ${media}`],
    [
      "duplicate length",
      (media, length) =>
        `Content-Type: ${media}\r\nContent-Length: ${length}\r\nContent-Length: ${length}`,
    ],
    [
      "header defect hiding conflicting length",
      (media, length) =>
        `Content-Type: ${media}\r\nContent-Length: ${length}\r\nBroken\r\nContent-Length: 0`,
    ],
    ["malformed length", (media, length) => `Content-Type: ${media}\r\nContent-Length: +${length}`],
    [
      "UTF-16LE charset",
      (media, length) => `Content-Type: ${media}; charset=UTF-16LE\r\nContent-Length: ${length}`,
    ],
    [
      "contradictory charset",
      (media, length) =>
        `Content-Type: ${media}; charset=utf-8; charset=utf-16le\r\nContent-Length: ${length}`,
    ],
    [
      "duplicate content type",
      (media, length) =>
        `Content-Type: ${media}\r\nContent-Type: ${media}\r\nContent-Length: ${length}`,
    ],
    [
      "malformed content type",
      (media, length) => `Content-Type: ${media}; charset="utf-8\r\nContent-Length: ${length}`,
    ],
  ];
  for (const [name, headers, terminalChunk] of headerCases) {
    await t.test(`unsupported ${name}`, async () => {
      for (wireAsset of [false, true]) {
        wire = (body, media) =>
          `HTTP/1.1 200 OK\r\n${headers(media, Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n` +
          (terminalChunk === undefined
            ? body
            : `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n${terminalChunk}`);
        await check("unexpected-content", wireAsset ? both : shellOnly);
      }
      wire = undefined;
    });
  }
  await t.test("explicit UTF-8 content types verify", async () => {
    for (wireAsset of [false, true]) {
      wire = (body, media) =>
        `HTTP/1.1 200 OK\r\nContent-Type: ${media}; charset="UTF-8"\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
      await check("verified", both);
    }
    wire = undefined;
  });
  await t.test("auth, size, content and trust refusals stay private", async () => {
    page = "private error secret";
    for (const [code, expected] of [
      [302, "redirect-refused"],
      [401, "authentication-required"],
      [503, "unavailable"],
    ] as const) {
      status = code;
      await check(expected, shellOnly);
    }
    status = 200;
    type = "application/json";
    await check("unexpected-content", shellOnly);
    type = "text/html";
    page = " ".repeat(256 * 1024 + 1);
    await check("response-too-large", shellOnly);
    page = themed;
    asset = " ".repeat(2 * 1024 * 1024 + 1);
    await check("response-too-large", both);
    asset = css;
    await check("unavailable", [], `${origin}/console/`, false);
  });
  for (const path of [
    "//console/",
    "/other/../console/",
    "/%2e/console/",
    "/a/.%2E/console/",
    "/?token=secret",
  ]) {
    await t.test(`noncanonical URL ${path.split("?")[0]}`, async () => {
      await check("invalid-input", [], origin + path);
    });
  }
});
