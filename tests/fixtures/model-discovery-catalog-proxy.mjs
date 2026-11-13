import http from "node:http";
import tls from "node:tls";
import fs from "node:fs";

// A separate process. It answers the two public catalog URLs locally and never
// opens an upstream socket, so the controller's own fetch is the client.
const key = fs.readFileSync(process.argv[2]);
const cert = fs.readFileSync(process.argv[3]);
const whoami = JSON.stringify({
  chatgpt_account_id: "verified-account",
  chatgpt_account_is_fedramp: false,
});
const models = JSON.stringify({
  models: [
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
    { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list" },
  ],
});

function answer(secure, path) {
  const pathname = path.split("?")[0];
  const known =
    pathname === "/api/accounts/v1/user-auth-credential/whoami" ||
    pathname === "/backend-api/codex/models";
  const body = pathname.endsWith("/whoami") ? whoami : models;
  const status = known ? 200 : 404;
  const payload = known ? body : JSON.stringify({ error: "not_found" });
  secure.end(
    `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Not Found"}\r\n` +
      "content-type: application/json\r\n" +
      `content-length: ${Buffer.byteLength(payload)}\r\n` +
      "connection: close\r\n\r\n" +
      payload,
  );
}

const proxy = http.createServer();
proxy.on("connect", (request, socket, head) => {
  const host = String(request.url).split(":")[0];
  if (host !== "auth.openai.com" && host !== "chatgpt.com") {
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
    return;
  }
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head?.length) {
    socket.unshift(head);
  }
  const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
  secure.on("error", () => socket.destroy());
  let buffer = Buffer.alloc(0);
  secure.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) {
      return;
    }
    const header = buffer.subarray(0, end).toString("utf8");
    const path = header.split("\r\n")[0]?.split(" ")[1] ?? "";
    // Method and path only. Authorization and any token stay off this log.
    console.error(JSON.stringify({ event: "catalog.request", host, path: path.split("?")[0] }));
    answer(secure, path);
  });
});
proxy.listen(0, "127.0.0.1", () => {
  const address = proxy.address();
  if (address === null || typeof address === "string") {
    throw new Error("Catalog proxy did not bind.");
  }
  console.log(JSON.stringify({ event: "catalog.ready", port: address.port }));
});
