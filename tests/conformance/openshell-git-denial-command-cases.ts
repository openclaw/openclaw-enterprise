import assert from "node:assert/strict";
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { selfSigned } from "../helpers/certificates.mjs";
import {
  gitRemovalDenialCategory,
  gitRemovalDenialCommand,
} from "../helpers/openshell-git-denial.ts";

function serverPort(server: Server): number {
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string", "Expected a bound TCP server");
  return address.port;
}

export function registerGitDenialCommandCases(): void {
  test(
    "Git removal denial command reports only signed or transport failures",
    { timeout: 20_000 },
    async (t) => {
      // Run the installed command against real Git and isolate it from local Git settings.
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
      const repository = join(directory, "repository");
      await run("git", ["init", "--initial-branch=main", repository], options);
      await run(
        "git",
        [
          "-C",
          repository,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "Fixture commit",
        ],
        options,
      );
      await run("git", ["-C", repository, "update-server-info"], options);
      const { stdout: ref } = await run("git", ["-C", repository, "rev-parse", "HEAD"], options);
      // Read the fixture before listening so a file error cannot look like a Git failure.
      const files = new Map([
        ["/info/refs", await readFile(join(repository, ".git/info/refs"))],
        ["/HEAD", await readFile(join(repository, ".git/HEAD"))],
      ]);
      let status = 403;
      let stall = false;
      let valid = true;
      const requests: (string | undefined)[] = [];
      const server = createServer((request, response) => {
        requests.push(request.url);
        if (stall) {
          return;
        }
        if (status !== 200) {
          response.writeHead(status).end("private server response must never escape");
          return;
        }
        const path = request.url?.split("?")[0];
        const content = path === undefined ? undefined : files.get(path);
        if (content === undefined) {
          response.writeHead(404).end();
          return;
        }
        if (!valid) {
          response.setHeader("Content-Type", "application/x-git-upload-pack-advertisement");
          response.end("private invalid Git response");
          return;
        }
        response.end(content);
      });
      const closeServer = () =>
        new Promise<void>((resolve, reject: (reason: unknown) => void) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      t.after(closeServer);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const url = `http://127.0.0.1:${serverPort(server)}`;
      const gitArgs = ["-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=1", "ls-remote"];
      const gitCommand = (target: string) => `LC_ALL=C git ${gitArgs.join(" ")} '${target}'`;
      type Expected = { code: 0; stdout: "signed" | "transport" } | { code: 1; stdout: "" };
      const verify = async (git: string, expected: Expected) => {
        const [command, ...args] = gitRemovalDenialCommand(git);
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
        assert.deepEqual(result, { ...expected, stderr: "" });
        if (expected.code === 0) {
          assert.equal(
            gitRemovalDenialCategory({ stdout: Buffer.from(result.stdout) }),
            expected.stdout,
          );
        }
      };
      const transport = { code: 0, stdout: "transport" } satisfies Expected;
      const refused = { code: 1, stdout: "" } satisfies Expected;
      const verifyHttp = async (expected: Expected) => {
        const before = requests.length;
        await verify(gitCommand(url), expected);
        assert.equal(requests[before], "/info/refs?service=git-upload-pack");
      };
      await t.test("HTTP 403 reports signed", async () =>
        verifyHttp({ code: 0, stdout: "signed" }),
      );
      status = 503;
      await t.test("other HTTP errors report transport", async () => verifyHttp(transport));
      stall = true;
      await t.test("a timed out request reports transport", async () => verifyHttp(transport));
      stall = false;
      status = 200;
      valid = false;
      await t.test("malformed Git data reports transport", async () => verifyHttp(transport));
      valid = true;
      await t.test("successful Git access fails without output", async () => {
        const result = await run("git", [...gitArgs, url], options);
        assert.equal(result.stderr, "");
        assert.ok(result.stdout.includes(`${ref.trim()}\trefs/heads/main\n`));
        await verifyHttp(refused);
      });
      let tlsConnections = 0;
      const tls = createHttpsServer(await selfSigned(directory), (_, response) => response.end());
      tls.on("connection", () => {
        tlsConnections += 1;
      });
      t.after(
        () =>
          new Promise<void>((resolve, reject: (reason: unknown) => void) => {
            tls.close((error) => (error ? reject(error) : resolve()));
            tls.closeAllConnections();
          }),
      );
      tls.listen(0, "127.0.0.1");
      await once(tls, "listening");
      await t.test("TLS verification failures report transport", async () => {
        await verify(gitCommand(`https://127.0.0.1:${serverPort(tls)}`), transport);
        assert.ok(tlsConnections > 0, "Expected Git to reach the TLS listener");
      });
      await closeServer();
      await t.test("a refused connection reports transport", async () =>
        verify(gitCommand(url), transport),
      );
      await t.test("a missing Git binary fails without output", async () =>
        verify(`'${join(directory, "missing-git")}' ls-remote '${url}'`, refused),
      );
      await t.test("an unexecutable Git binary fails without output", async () => {
        const executable = join(directory, "unexecutable-git");
        await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
        await verify(`'${executable}' ls-remote '${url}'`, refused);
      });
    },
  );
}
