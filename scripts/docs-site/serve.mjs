import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1]))) {
  throw new Error("Usage: node scripts/docs-site/serve.mjs [--port <0..65535>]");
}
const port = args.length ? Number(args[1]) : 4173;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("Invalid preview port");
}
const root = await realpath(resolve("dist/docs")).catch(() => {
  throw new Error("Missing dist/docs; run npm run docs:build first.");
});
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
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
    const details = await stat(file);
    if (!details.isFile()) {
      throw new Error("Not a file");
    }
    response.writeHead(200, {
      "Content-Type": mime[extname(file)] ?? "application/octet-stream",
      "Content-Length": details.size,
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
    }
  } catch {
    response.writeHead(404).end("Page not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Docs preview: http://127.0.0.1:${server.address().port}/\n`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
