import assert from "node:assert/strict";
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { selfSigned } from "../helpers/certificates.mjs";
import { gitHttp403Command } from "../helpers/openshell-git-denial.mjs";

function serverPort(server: Server): number {
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string", "Expected a bound TCP server");
  return address.port;
}

export function registerGitDenialCommandCases(): void {
  test(
    "Git denial command retains non-403 failure categories without output",
    { timeout: 20_000 },
    async (t) => {
      // Exercise the denial classifier with real Git against loopback HTTP and TLS.
      const directory = await mkdtemp(join(tmpdir(), "git-denial-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const env = {
        PATH: process.env.PATH,
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      };
      const run = promisify(execFile);
      const options: ExecFileOptionsWithStringEncoding = {
        encoding: "utf8",
        env,
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      };
      const repository = join(directory, "repository.git");
      await run("git", ["init", "--bare", repository], options);
      await run("git", ["--git-dir", repository, "update-server-info"], options);
      let status = 403;
      let stall = false;
      let valid = true;
      const server = createServer(async (request, response) => {
        if (stall) {
          return;
        }
        if (status !== 200) {
          response.writeHead(status);
          response.end("private server response must never escape");
          return;
        }
        assert.ok(request.url !== undefined, "Expected a request URL");
        const path = new URL(request.url, "http://127.0.0.1").pathname;
        if (path !== "/info/refs" && path !== "/HEAD") {
          response.writeHead(404).end();
          return;
        }
        if (!valid) {
          response.setHeader("Content-Type", "application/x-git-upload-pack-advertisement");
          response.end("private invalid Git response");
          return;
        }
        response.end(await readFile(join(repository, path.slice(1))));
      });
      t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const url = `http://127.0.0.1:${serverPort(server)}`;
      const verify = async (expected: number, target = url) => {
        const [command, ...args] = gitHttp403Command(
          `git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=1 ls-remote '${target}'`,
        );
        assert.ok(command, "Expected a command to execute");
        const result = await run(command, args, options).then(
          (value) => ({ ...value, code: 0 }),
          (error: unknown) => {
            assert.ok(
              error instanceof Error && "code" in error && typeof error.code === "number",
              "Expected a numeric command exit code",
            );
            assert.ok("stdout" in error && typeof error.stdout === "string");
            assert.ok("stderr" in error && typeof error.stderr === "string");
            return { code: error.code, stdout: error.stdout, stderr: error.stderr };
          },
        );
        assert.equal(result.code, expected);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
      };
      await t.test("HTTP 403 is the only accepted denial", async () => verify(0));
      status = 503;
      await t.test("other HTTP errors remain distinct failures", async () => verify(13));
      stall = true;
      await t.test("a timed out request remains a failure", async () => verify(14));
      stall = false;
      status = 200;
      valid = false;
      await t.test("unclassified errors stay private and fail closed", async () => verify(2));
      valid = true;
      await t.test("successful Git access remains a failure", async () => verify(1));
      const tls = createHttpsServer(await selfSigned(directory), (_, response) => response.end());
      t.after(() => new Promise<void>((resolve) => tls.close(() => resolve())));
      tls.listen(0, "127.0.0.1");
      await once(tls, "listening");
      await t.test("TLS verification failures remain failures", async () =>
        verify(12, `https://127.0.0.1:${serverPort(tls)}`),
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await t.test("connection failure cannot qualify as authorization denial", async () =>
        verify(11),
      );
    },
  );
}
