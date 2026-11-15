const [command, target, program, entry] = process.argv.slice(2);
const mode = process.env.FAKE_DOCKER_MODE ?? "exited";
// Long multi-line output whose first and last lines name where it came from.
const long = (label: string) => {
  let text = `${label} first line\n`;
  for (let index = 0; index < 100; index += 1) {
    text += `${label} line ${index}: ${"y".repeat(40)}\n`;
  }
  return `${text}${label} final line\n`;
};
if (mode === "exit-silent") {
  process.exit(3);
} else if (mode === "leak-long") {
  // One long line, so the stderr tail starts inside the planted value.
  process.stderr.write(`${"z".repeat(9000)}${process.env.FAKE_DOCKER_PLAIN}${"w".repeat(8180)}\n`);
  process.exit(1);
} else if (mode === "cat") {
  process.stdin.pipe(process.stdout);
} else if (mode === "hang") {
  setInterval(() => {}, 1_000);
} else if (mode === "leak-key") {
  process.stdout.write(`stdout key ${process.env.FAKE_DOCKER_KEY}\n`);
  process.stderr.write(
    `stderr key ${process.env.FAKE_DOCKER_KEY}\nplanted ${process.env.FAKE_DOCKER_PLAIN}\n`,
  );
  process.exit(1);
} else if (command === "inspect" && mode === "inspect-fails") {
  process.stderr.write(long("inspect stderr"));
  process.exit(1);
} else if (command === "inspect" && mode === "malformed-inspect-status") {
  process.stdout.write("daemon message without state\n");
} else if (mode === "readiness-report" && command === "inspect") {
  process.stdout.write(process.env.FAKE_DOCKER_INSPECT_OUTPUT ?? "");
} else if (mode === "readiness-report" && command === "exec") {
  process.stdout.write(
    "starting status probe\n" + (process.env.FAKE_DOCKER_PROBE_OUTPUT ?? "") + "\n",
  );
} else if (mode === "readiness-report" && command === "logs" && target === "--since") {
  process.stderr.write(
    'null\n{"event":"runtime.startup_phase","phase":"model-probe","outcome":"failed","code":"AUTHENTICATION_FAILED","ms":5,"sinceStartMs":12}\n',
  );
} else if (mode === "mixed-line-endings" && command === "logs" && target === "--timestamps") {
  process.stdout.write("2026-10-21T08:52:18.75Z newer wrapper failure\r\n");
  process.stderr.write("2026-10-21T08:52:18Z older wrapper warning\n");
} else if (command === "inspect" && mode.startsWith("wait-")) {
  // Running, exit code, StartedAt and FinishedAt, as the follower's --format asks.
  const finishedAt: Record<string, string | undefined> = {
    "wait-hangs": "2026-10-21T08:52:18.75Z",
    "wait-hangs-no-finish": "0001-01-01T00:00:00Z",
    // A restarted container's last exit is older than its current start.
    "wait-fails-restarted": "2026-10-21T08:51:40Z",
  };
  process.stdout.write(`false|0|2026-10-21T08:51:50.1Z|${finishedAt[mode]}\n`);
} else if (command === "wait" && mode === "wait-fails-restarted") {
  process.stderr.write("Error response from daemon: context deadline exceeded\n");
  process.exit(1);
} else if (command === "inspect") {
  process.stdout.write(mode === "exited" ? "false 1\n" : "true 0\n");
} else if (command === "wait" && mode.startsWith("wait-hangs")) {
  setInterval(() => {}, 1_000);
} else if (command === "exec" && entry === "/app/openclaw.mjs") {
  process.stdout.write(long("plugin list"));
} else if (command === "exec" && program === "node") {
  process.stderr.write(long("readiness stderr"));
  process.exit(1);
} else if (command === "logs") {
  process.stdout.write("first doctor line\n");
  for (let index = 0; index < 400; index += 1) {
    process.stdout.write(`doctor check ${index}: ${"x".repeat(60)}\n`);
  }
  process.stderr.write("Migrating agent databases\nwrapper failed: final stderr line\n");
} else if (command === "run") {
  process.stdout.write("fake-container-id\n");
}
