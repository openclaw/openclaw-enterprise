import { constants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { createPreviewBuild } from "./preview-build.mjs";

const { values } = parseArgs({
  options: { watch: { type: "boolean" }, port: { type: "string", default: "4173" } },
});
const port = Number(values.port);
if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("Invalid preview port");
}
const clients = new Set();
const preview = values.watch
  ? await createPreviewBuild((state) => {
      for (const client of clients) {
        client.write(`data: ${JSON.stringify(state)}\n\n`);
      }
    })
  : undefined;
const staticRoot = preview ? undefined : await realpath(resolve("dist/docs"));
const refreshScript = (revision) =>
  `<script type="module" src="/__docs_preview/client.mjs" data-docs-preview="${revision}"></script>`;
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let url;
  let pathname;
  try {
    url = new URL(request.url, `http://${request.headers.host}`);
    pathname = decodeURIComponent(url.pathname);
    if (pathname.includes("\0")) {
      throw new Error("Invalid path");
    }
  } catch {
    response.writeHead(400).end("Invalid request");
    return;
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    response.writeHead(403).end("Loopback preview only");
    return;
  }
  if (preview && pathname === "/__docs_preview/events") {
    response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    clients.add(response);
    response.write(`data: ${JSON.stringify(preview.state())}\n\n`);
    response.on("close", () => clients.delete(response));
    return;
  }
  if (preview && pathname === "/__docs_preview/client.mjs") {
    try {
      const client = await readFile(new URL("./preview-client.mjs", import.meta.url));
      response.writeHead(200, { "Content-Type": mime[".mjs"] });
      response.end(request.method === "HEAD" ? undefined : client);
    } catch {
      response.writeHead(500).end("Cannot read preview client; check the preview terminal.");
    }
    return;
  }
  const generation = preview?.acquire();
  if (preview && !generation) {
    response.writeHead(503, { "Content-Type": mime[".html"], "Retry-After": "1" });
    response.end(
      request.method === "HEAD"
        ? undefined
        : `<!doctype html><html lang="en"><title>Docs preview</title><body><h1>Preparing documentation preview</h1><p>Check the preview terminal for build progress. This page updates automatically.</p>${refreshScript("")}</body></html>`,
    );
    return;
  }
  if (generation) {
    response.once("close", () => generation.release());
  }
  const root = generation?.directory ?? staticRoot;
  let handle;
  try {
    let file = resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${sep}`) && file !== root) {
      throw new Error("Outside site");
    }
    const info = await stat(file);
    if (info.isDirectory()) {
      if (!url.pathname.endsWith("/")) {
        response.writeHead(308, { Location: `${url.pathname}/${url.search}` }).end();
        return;
      }
      file = resolve(file, "index.html");
    }
    file = await realpath(file);
    if (!file.startsWith(`${root}${sep}`)) {
      throw new Error("Outside site");
    }
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const details = await handle.stat();
    if (!details.isFile()) {
      throw new Error("Not a file");
    }
    if (generation && extname(file) === ".html") {
      const html = (await handle.readFile("utf8")).replace(
        "</body>",
        `${refreshScript(generation.revision)}</body>`,
      );
      response.writeHead(200, {
        "Content-Type": mime[".html"],
        "Content-Length": Buffer.byteLength(html),
      });
      response.end(request.method === "HEAD" ? undefined : html);
      return;
    }
    response.writeHead(200, {
      "Content-Type": mime[extname(file)] ?? "application/octet-stream",
      "Content-Length": details.size,
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      const stream = handle.createReadStream();
      handle = undefined;
      response.once("close", () => stream.destroy());
      stream.on("error", () => response.destroy()).pipe(response);
    }
  } catch {
    if (!generation) {
      response.writeHead(404).end("Page not found");
      return;
    }
    response.writeHead(404, { "Content-Type": mime[".html"] });
    response.end(
      request.method === "HEAD"
        ? undefined
        : `<!doctype html><html lang="en"><title>Page not found</title><body><h1>Page not found</h1><p>If you renamed this page, open its new URL. This tab updates after the next successful build.</p>${refreshScript(generation.revision)}</body></html>`,
    );
  } finally {
    await handle?.close();
  }
});

server.on("error", async (error) => {
  console.error(`Docs preview: ${error.message}`);
  await preview?.close();
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Docs preview: http://127.0.0.1:${server.address().port}/\n`);
});
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (closing) {
      return;
    }
    closing = true;
    for (const client of clients) {
      client.end();
    }
    server.close();
    server.closeAllConnections();
    await preview?.close();
  });
}
