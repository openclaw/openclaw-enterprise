import assert from "node:assert/strict";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";

// Fake external commands for tests whose code under test starts real processes. Each
// fake on the fixture's PATH is a small bash script (see commandShim) that connects to
// the test's command server, sends its argv, working directory and the forwarded
// environment variables, and then runs the server's replies: output, exit, reading its
// stdin, holding its pipes, a final bash line, or hanging until killed. The code under
// test still starts every command as a real process and owns its timeouts, signals and
// pipes; only the fake's logic runs in the test process, so a command costs a bash
// start instead of a node start. Used by ci-prepare-fixture-command.mjs and dev-up.mjs.
//
// Any local user can connect to a loopback port, so the two sides authenticate each
// other with per-server random tokens that only the fixture's private (0700) shims hold:
// the server runs nothing for a client that does not open with its client token, and a
// shim evaluates nothing from a listener that does not answer with the server token.
// Whatever a handler writes is the server's doing, never the client's.

// An ANSI-C quoted bash word holding exactly these bytes, always on one line. Bash
// strings end at a NUL, so the text may not contain one (no fake's output or argument
// does).
export function bashString(text) {
  assert.ok(!text.includes("\0"), "a fake command's bash text must not contain NUL");
  let word = "$'";
  for (const byte of Buffer.from(text)) {
    const plain = byte >= 0x20 && byte < 0x7f && byte !== 0x27 && byte !== 0x5c;
    word += plain ? String.fromCharCode(byte) : "\\x" + byte.toString(16).padStart(2, "0");
  }
  return word + "'";
}

// The fake command: bash builtins only, so it is a single process that prepare.mjs's
// signals reach directly, and its output pipes close when it exits (except where a
// reply makes it start a descendant on purpose). It sends its client token and then
// NUL-terminated fields, and evaluates the reply lines that follow the server token.
// A command whose server is gone, or does not authenticate, fails. It holds both
// tokens: write it with mode 0700 in a private directory.
export function commandShim({
  bash,
  sleep,
  setsid,
  port,
  clientToken,
  serverToken,
  command,
  forwardedEnv,
}) {
  for (const token of [clientToken, serverToken]) {
    assert.match(token, /^[0-9a-f]{64}$/);
  }
  assert.match(command, /^[a-z0-9]+$/);
  for (const name of forwardedEnv) {
    assert.match(name, /^[A-Z_][A-Z0-9_]*$/);
  }
  const env = forwardedEnv.map((name) => `"\${${name}+=}\${${name}-}"`).join(" ");
  return `#!${bash}
__lc_all_set=\${LC_ALL+1}
__lc_all=\${LC_ALL-}
LC_ALL=C
trap '' PIPE
__sleep=${bashString(sleep)}
__setsid=${bashString(setsid)}
exec 3<>/dev/tcp/127.0.0.1/${port} || exit 125
__stdin() { local data; IFS= read -r -d '' data; printf '%s\\0' "$data" >&3; }
printf '%s\\0' ${clientToken} ${command} "$PWD" "$#" "$@" ${env} >&3
if ! IFS= read -r -u 3 __line || [[ "$__line" != ${serverToken} ]]; then
  echo "fixture command server did not authenticate" >&2
  exit 125
fi
while IFS= read -r -u 3 __line; do eval "$__line"; done
echo "fixture command server closed the connection" >&2
exit 125
`;
}

function serveCommand(socket, { tokens, forwardedEnv, handle }) {
  const timers = new Set();
  const fields = [];
  let buffered = Buffer.alloc(0);
  let waiter;
  let closed = false;
  let ended = false;
  let tokenReceived = false;
  const nextField = () => {
    if (fields.length > 0) {
      return Promise.resolve(fields.shift());
    }
    if (closed) {
      return Promise.reject(new Error("the fake command closed its connection"));
    }
    return new Promise((resolve, reject) => (waiter = { resolve, reject }));
  };
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (let end = buffered.indexOf(0); end !== -1; end = buffered.indexOf(0)) {
      fields.push(buffered.subarray(0, end).toString());
      buffered = buffered.subarray(end + 1);
      tokenReceived = true;
    }
    // A client gets no more buffer before its token than the token needs (64 bytes).
    // The token is checked before the next read.
    if (!tokenReceived && buffered.length > 64) {
      socket.destroy();
      return;
    }
    if (waiter && fields.length > 0) {
      const { resolve } = waiter;
      waiter = undefined;
      resolve(fields.shift());
    }
  });
  // A killed command resets its connection; its pending replies are dropped.
  socket.on("error", () => {});
  socket.on("close", () => {
    closed = true;
    for (const timer of timers) {
      clearTimeout(timer);
    }
    waiter?.reject(new Error("the fake command closed its connection"));
  });
  const send = (line) => {
    if (!closed && !ended) {
      socket.write(line + "\n");
    }
  };
  const io = {
    // Like a node process, an output write to a closed pipe neither kills nor fails it.
    stdout: (text) => text && send(`printf %s ${bashString(text)} 2>/dev/null`),
    stderr: (text) => text && send(`printf %s ${bashString(text)} >&2`),
    exit: (code) => {
      send(`exit ${code}`);
      ended = true;
      socket.end();
    },
    exitAfter: (code, ms) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        io.exit(code);
      }, ms);
      timers.add(timer);
    },
    // The command closes its connection and runs this bash line (one line, no newline)
    // in place of the rest of the protocol. The line must end in exit or exec. It runs
    // with the caller's LC_ALL and default SIGPIPE handling, as the command started.
    script: (line) => {
      assert.ok(!line.includes("\n"), "a fake command's script is one line");
      send(
        `exec 3>&-; trap - PIPE; if [[ -n $__lc_all_set ]]; then LC_ALL=$__lc_all; else unset LC_ALL; fi; ${line}`,
      );
      ended = true;
      socket.end();
    },
    closeStdout: () => send("exec 1>&-"),
    // A descendant writes to the command's stderr after the command has exited.
    lateStderr: (text, ms) =>
      send(
        `{ "$__sleep" ${ms / 1000}; printf %s ${bashString(text)} >&2; } </dev/null >/dev/null 3>&- &`,
      ),
    readInput: () => {
      send("__stdin");
      return nextField();
    },
    holdPipes: ({ ms, escaped, pidFile, escapedPidFile }) =>
      send(
        escaped
          ? // The command ignores SIGTERM only after starting the descendant, which would
            // otherwise inherit the ignored signal (node's handler was not inherited).
            `"$__setsid" "$__sleep" ${ms / 1000} </dev/null 3>&- & ` +
              `printf '%s\\n' "$$" >> ${bashString(pidFile)}; ` +
              `printf '%s\\n' "$!" >> ${bashString(escapedPidFile)}; trap '' TERM`
          : `"$__sleep" ${ms / 1000} </dev/null 3>&- & ` +
              `printf '%s\\n' "$$" "$!" >> ${bashString(pidFile)}`,
      ),
  };
  (async () => {
    // Nothing a client sends is used before its first field matches the client token.
    const token = Buffer.from(await nextField());
    if (token.length !== tokens.client.length || !timingSafeEqual(token, tokens.client)) {
      socket.destroy();
      return;
    }
    send(tokens.server.toString());
    const command = await nextField();
    const cwd = await nextField();
    const argc = Number(await nextField());
    const args = [];
    for (let index = 0; index < argc; index += 1) {
      args.push(await nextField());
    }
    const env = {};
    for (const name of forwardedEnv) {
      const value = await nextField();
      if (value.startsWith("=")) {
        env[name] = value.slice(1);
      }
    }
    try {
      await handle({ command, args, env, cwd, io });
    } catch (error) {
      // As an uncaught error in a command process: its stack on stderr, status 1.
      io.stderr(`${error?.stack ?? error}\n`);
      io.exit(1);
    }
  })().catch(() => socket.destroy());
  return {
    close() {
      socket.destroy();
    },
  };
}

// One server per fixture, on loopback. handle({ command, args, env, cwd, io }) answers
// each command: env holds the forwardedEnv names the command had set, and io (above)
// writes its output and ends it. Closing the server ends every command still
// connected: a command that was hanging exits at once instead of at its own bound. Its
// clientToken and serverToken go to commandShim, with the same forwardedEnv.
export async function startCommandServer({ forwardedEnv, handle }) {
  assert.ok(Array.isArray(forwardedEnv));
  assert.equal(typeof handle, "function");
  const tokens = {
    client: Buffer.from(randomBytes(32).toString("hex")),
    server: Buffer.from(randomBytes(32).toString("hex")),
  };
  const connections = new Set();
  const server = createServer((socket) => {
    const connection = serveCommand(socket, { tokens, forwardedEnv, handle });
    connections.add(connection);
    socket.once("close", () => connections.delete(connection));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    clientToken: tokens.client.toString(),
    serverToken: tokens.server.toString(),
    close: () => {
      for (const connection of connections) {
        connection.close();
      }
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
