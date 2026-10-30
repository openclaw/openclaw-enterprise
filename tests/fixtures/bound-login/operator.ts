/** A real TLS ingress and host-only browser, retained across API Pod rollouts. */
import { QualificationFailure } from "./failure.ts";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createBrowser, type Browser } from "./browser.ts";

const fixtureDirectory = process.env.BOUND_LOGIN_FIXTURE_DIRECTORY ?? "/bound-login-private";
const { origin } = JSON.parse(fs.readFileSync(`${fixtureDirectory}/config.json`, "utf8"));
if (!/^https:\/\/bound-console\.[a-z0-9-]+\.svc:38443$/.test(origin)) {
  throw Error("Canonical private Console Service origin required");
}
const browsers = new Map<string, Browser>();
let stopped = false;
const upstream = process.env.BOUND_LOGIN_API_SERVICE!;
if (!/^[a-z0-9.-]+\.svc$/.test(upstream)) {
  throw Error("Private API Service required");
}
https
  .createServer(
    {
      key: fs.readFileSync(`${fixtureDirectory}/tls.key`),
      cert: fs.readFileSync(`${fixtureDirectory}/tls.crt`),
    },
    (req, res) => {
      if (stopped) {
        res.destroy();
        return;
      }
      const headers = { ...req.headers };
      delete headers["x-forwarded-for"];
      delete headers["x-forwarded-host"];
      delete headers["x-forwarded-proto"];
      const out = http.request(
        {
          host: upstream,
          port: 8080,
          path: req.url,
          method: req.method,
          headers,
        },
        (r) => {
          const lostResponse = () => {
            stopped = true;
            res.destroy();
          };
          r.on("aborted", lostResponse);
          r.on("error", lostResponse);
          res.writeHead(r.statusCode!, r.headers);
          r.pipe(res);
        },
      );
      out.on("error", () => {
        stopped = true;
        res.destroy();
      });
      req.pipe(out);
    },
  )
  .listen(38443, "0.0.0.0");
http
  .createServer(async (req, res) => {
    const reply = (x: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(x));
    };
    try {
      if (stopped) {
        throw Error("Stopped");
      }
      if (req.method !== "POST" || req.url !== "/command") {
        throw Error("Denied");
      }
      let raw = "";
      for await (const b of req) {
        raw += b;
        if (raw.length > 65536) {
          throw Error("Size");
        }
      }
      const x = JSON.parse(raw);
      if (x.action === "new") {
        browsers.set(x.browser, createBrowser(origin));
        reply({ ok: true });
        return;
      }
      const b = browsers.get(x.browser);
      if (!b) {
        throw Error("Browser missing");
      }
      if (x.action === "freeze") {
        browsers.set(x.target, b.freeze());
        reply({ ok: true });
        return;
      }
      if (x.action === "pin") {
        b.pinSession(x.key);
        reply({ ok: true });
        return;
      }
      if (x.action === "bootstrap") {
        const password = fs.readFileSync("/bootstrap/initial-admin-password", "utf8").trim();
        reply(
          await b.request("POST", "/api/auth/sign-in/email", {
            email: x.email,
            password,
          }),
        );
        return;
      }
      if (x.action === "request") {
        reply(await b.request(x.method, x.path, x.body));
        return;
      }
      throw Error("Unknown action");
    } catch (error) {
      stopped = true;
      reply({
        error: true,
        failureClass: error instanceof QualificationFailure ? error.failureClass : "unknown-reply",
        ...(error instanceof QualificationFailure && error.httpStatus !== undefined
          ? { httpStatus: error.httpStatus }
          : {}),
      });
    }
  })
  .listen(39084, "127.0.0.1");
