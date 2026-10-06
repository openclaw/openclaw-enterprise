// Usage: node with-pinned-matrix-sdk-crypto.mjs <directory> <command> [arguments...]
//
// @matrix-org/matrix-sdk-crypto-nodejs downloads its native library from GitHub in
// postinstall, with no retry and no checksum. The Dockerfile fetches the pinned library
// with scripts/ci/download-pinned.sh instead, and this wrapper serves that directory on
// loopback while the command (pnpm install) runs, through the package's
// MATRIX_SDK_CRYPTO_DOWNLOADS_BASE_URL setting. Any other request fails, so a package
// version change fails the build until the pin is updated.
import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, normalize } from "node:path";

const [directory, command, ...commandArguments] = process.argv.slice(2);
if (!directory || !command) {
  console.error("Usage: with-pinned-matrix-sdk-crypto.mjs <directory> <command> [arguments...]");
  process.exit(64);
}

const server = createServer((request, response) => {
  try {
    const file = join(directory, normalize(new URL(request.url, "http://localhost").pathname));
    const stats = statSync(file);
    if (request.method === "GET" && stats.isFile()) {
      response.writeHead(200, {
        "content-length": stats.size,
        "content-type": "application/octet-stream",
      });
      createReadStream(file).pipe(response);
      return;
    }
  } catch {}
  const requested = `${request.method} ${request.url}`.replace(/[\r\n]/g, "");
  console.error(
    `with-pinned-matrix-sdk-crypto: no pinned file for ${requested}; update the matrix-sdk-crypto pin in deploy/runtime/Dockerfile`,
  );
  response.writeHead(404).end();
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const child = spawn(command, commandArguments, {
    stdio: "inherit",
    env: {
      ...process.env,
      MATRIX_SDK_CRYPTO_DOWNLOADS_BASE_URL: `http://127.0.0.1:${port}`,
      // Keep the loopback request off any configured proxy.
      NO_PROXY: [process.env.NO_PROXY, "127.0.0.1"].filter(Boolean).join(","),
      no_proxy: [process.env.no_proxy, "127.0.0.1"].filter(Boolean).join(","),
    },
  });
  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
  child.on("exit", (code) => {
    server.close();
    process.exit(code ?? 1);
  });
});
