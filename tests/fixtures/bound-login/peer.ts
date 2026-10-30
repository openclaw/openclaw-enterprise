/** Synthetic GitHub authority for the isolated installed-login fixture; no external forwarding. */
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";

const fixtureDirectory = process.env.BOUND_LOGIN_FIXTURE_DIRECTORY ?? "/bound-login-private";
const config = JSON.parse(fs.readFileSync(`${fixtureDirectory}/config.json`, "utf8"));
const origin = new URL(config.origin);
if (origin.protocol !== "https:" || !config.clientId || !config.clientSecret) {
  throw Error("Invalid fixture config");
}
const codes = new Map<string, { login: string; subject: number }>();
const tokens = new Map<string, { login: string; subject: number }>();
const states = new Set<string>();
const reply = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
async function body(req: http.IncomingMessage) {
  let text = "";
  for await (const b of req) {
    text += b;
    if (text.length > 8192) {
      throw Error("Size");
    }
  }
  return text;
}
const peer = https.createServer(
  {
    key: fs.readFileSync(`${fixtureDirectory}/tls.key`),
    cert: fs.readFileSync(`${fixtureDirectory}/tls.crt`),
  },
  async (req, res) => {
    try {
      if (
        req.headers.host === "github.com" &&
        req.method === "POST" &&
        req.url === "/login/oauth/access_token"
      ) {
        const form = new URLSearchParams(await body(req));
        const code = form.get("code") ?? "";
        const grant = codes.get(code);
        codes.delete(code);
        if (
          !grant ||
          form.get("client_id") !== config.clientId ||
          form.get("client_secret") !== config.clientSecret ||
          (form.has("redirect_uri") &&
            form.get("redirect_uri") !== origin.origin + "/api/auth/providers/github/callback")
        ) {
          throw Error("Denied");
        }
        const token = randomBytes(32).toString("base64url");
        tokens.set(token, grant);
        reply(res, 200, {
          access_token: token,
          token_type: "bearer",
          scope: "read:user user:email read:org",
        });
        return;
      }
      if (req.headers.host !== "api.github.com" || req.method !== "GET") {
        throw Error("Denied");
      }
      const grant = tokens.get((req.headers.authorization ?? "").replace(/^(Bearer|token) /i, ""));
      if (!grant) {
        throw Error("Denied");
      }
      if (req.url === "/user") {
        reply(res, 200, {
          id: grant.subject,
          login: grant.login,
          name: "Private fixture",
          email: null,
          avatar_url: null,
        });
        return;
      }
      if (req.url === "/user/emails") {
        reply(res, 200, []);
        return;
      }
      if (req.url === "/user/memberships/orgs/bound-login-fixture") {
        reply(res, 200, { state: "active" });
        return;
      }
      if (req.url === `/orgs/bound-login-fixture/teams/members/memberships/${grant.login}`) {
        reply(
          res,
          grant.login === "member" ? 200 : 404,
          grant.login === "member" ? { state: "active" } : {},
        );
        return;
      }
      throw Error("Denied");
    } catch {
      reply(res, 403, { error: "fixture denied" });
    }
  },
);
peer.listen(39081, "127.0.0.1");
const proxy = http.createServer((_req, res) => reply(res, 403, {}));
proxy.on("connect", (req, down, head) => {
  if (!["github.com:443", "api.github.com:443"].includes(req.url ?? "")) {
    down.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const up = net.connect({ host: "127.0.0.1", port: 39081 }, () => {
    down.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) {
      up.write(head);
    }
    up.pipe(down);
    down.pipe(up);
  });
  up.on("error", () => down.destroy());
  down.on("error", () => up.destroy());
  up.on("close", () => down.destroy());
  down.on("close", () => up.destroy());
});
proxy.listen(39082, "127.0.0.1");
// Same-Pod loopback only. Caller must retain code/state privately, never in receipts.
http
  .createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/authorize") {
        throw Error("Denied");
      }
      const input = JSON.parse(await body(req));
      const url = new URL(input.url);
      const state = url.searchParams.get("state");
      if (
        url.origin !== "https://github.com" ||
        url.pathname !== "/login/oauth/authorize" ||
        url.searchParams.get("client_id") !== config.clientId ||
        url.searchParams.get("redirect_uri") !==
          origin.origin + "/api/auth/providers/github/callback" ||
        !state ||
        states.has(state) ||
        !["member", "outsider"].includes(input.login)
      ) {
        throw Error("Denied");
      }
      const subject = config.subjects[input.login];
      if (!Number.isSafeInteger(subject) || subject <= 0) {
        throw Error("Denied");
      }
      states.add(state);
      const code = randomBytes(32).toString("base64url");
      codes.set(code, { login: input.login, subject });
      reply(res, 200, {
        callback:
          origin.origin +
          "/api/auth/providers/github/callback?" +
          new URLSearchParams({ state, code }),
      });
    } catch {
      reply(res, 403, { error: "fixture denied" });
    }
  })
  .listen(39083, "127.0.0.1");
