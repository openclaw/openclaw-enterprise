// The model stand-in logs only fixed diagnostics from the actual managed tool.
// Neither a failed child nor an unrecognized tool result may echo private text.
export function publicReadFailure(stderr, code) {
  const text = typeof stderr === "string" ? stderr.slice(0, 128 * 1024) : "";
  const curl = /curl: \(([1-9][0-9]?)\)/u.exec(text)?.[1];
  if (curl) {
    return "curl-" + Number(curl);
  }
  for (const value of [
    "MODULE_NOT_FOUND",
    "ERR_MODULE_NOT_FOUND",
    "EACCES",
    "ENOENT",
    "ERR_ACCESS_DENIED",
  ]) {
    if (code === value || new RegExp("\\b" + value + "\\b", "u").test(text)) {
      return "node-" + value;
    }
  }
  for (const [message, value] of [
    ["The managed public Git transport refused this invocation.", "managed-refusal"],
    ["The managed public reader child could not start.", "child-start-failure"],
    ["The managed public API read refused the response.", "api-response-refusal"],
  ]) {
    if (text.includes(message)) {
      return value;
    }
  }
  return "unknown";
}

const stages = [
  "proxy-active",
  "local-binding",
  "helper-present",
  "config-present",
  "ca-present",
  "capability-present",
  "helper-readable",
  "config-readable",
  "ca-readable",
  "managed-skill",
  "api-read",
];
const errors = [
  "none",
  "no-title",
  "unknown",
  "managed-refusal",
  "child-start-failure",
  "api-response-refusal",
  "node-MODULE_NOT_FOUND",
  "node-ERR_MODULE_NOT_FOUND",
  "node-EACCES",
  "node-ENOENT",
  "node-ERR_ACCESS_DENIED",
];

export function publicReadToolResult(output) {
  const result = {
    result: "no-title",
    receipt: "missing",
    checks: [],
    stage: "unknown",
    exit: null,
    error: "unknown",
  };
  if (typeof output !== "string" || output.length > 256 * 1024) {
    return result;
  }
  const title = /public-pull-[0-9a-f-]{36}/u.exec(output)?.[0];
  if (title) {
    result.result = "title-returned";
  }
  for (const line of output.split("\n")) {
    if (line.startsWith("public-read-check:")) {
      const stage = line.slice("public-read-check:".length);
      if (stages.includes(stage) && !result.checks.includes(stage)) {
        result.checks.push(stage);
      } else {
        result.receipt = "malformed";
      }
    } else if (line.startsWith("public-read-exit:")) {
      const match = /^public-read-exit:([a-z-]+):([0-9]{1,3}):([A-Za-z0-9_-]+)$/u.exec(line);
      if (
        result.exit !== null ||
        !match ||
        !stages.includes(match[1]) ||
        Number(match[2]) > 255 ||
        !(errors.includes(match[3]) || /^curl-[1-9][0-9]?$/u.test(match[3]))
      ) {
        result.receipt = "malformed";
        continue;
      }
      result.stage = match[1];
      result.exit = Number(match[2]);
      result.error = match[3];
      if (result.receipt !== "malformed") {
        result.receipt = "collected";
      }
    }
  }
  // Only the bounded provider marker returns to the model; diagnostics omit it.
  return { ...result, ...(title ? { title } : {}) };
}

export function publicReadCommand() {
  const helper = `
const { spawnSync } = require("node:child_process");
const classify = ${publicReadFailure.toString()};
const child = spawnSync(process.execPath, [process.env.GIT_EXEC_PATH + "/transport.mjs", "--api-get", "/repos/example/public-project/pulls/27"], { encoding: "utf8", timeout: 30000, maxBuffer: 128 * 1024 });
const status = Number.isInteger(child.status) && child.status >= 0 && child.status <= 255 ? child.status : 1;
let title;
if (status === 0) {
  try { const data = JSON.parse(child.stdout); if (typeof data.title === "string" && /^public-pull-[0-9a-f-]{36}$/.test(data.title)) title = data.title; } catch {}
}
const error = status === 0 ? (title ? "none" : "no-title") : classify(child.stderr, child.error?.code);
if (title) process.stdout.write(JSON.stringify({ title }) + "\\n");
process.stdout.write("public-read-exit:api-read:" + status + ":" + error + "\\n");
process.exitCode = status;
`;
  const checks = [
    ["proxy-active", 'test "${CODEX_NETWORK_PROXY_ACTIVE:-}" = 1'],
    ["local-binding", 'test "${CODEX_NETWORK_ALLOW_LOCAL_BINDING:-}" = 0'],
    ["helper-present", 'test -n "${GIT_EXEC_PATH:-}"'],
    ["config-present", 'test -n "${OCE_PUBLIC_GITHUB_READ_CONFIG:-}"'],
    ["ca-present", 'test -n "${OCE_PUBLIC_GITHUB_READ_CA_FILE:-}"'],
    ["capability-present", 'test -n "${OCE_PUBLIC_GITHUB_READ_CAPABILITY:-}"'],
    ["helper-readable", 'test -r "$GIT_EXEC_PATH/transport.mjs"'],
    ["config-readable", 'test -r "$OCE_PUBLIC_GITHUB_READ_CONFIG"'],
    ["ca-readable", 'test -r "$OCE_PUBLIC_GITHUB_READ_CA_FILE"'],
    [
      "managed-skill",
      'grep -q -- "--api-get" /home/node/.openclaw/skills/public-github-read/SKILL.md 2>/dev/null',
    ],
  ];
  return [
    "set -eu",
    "stage=proxy-active",
    `trap 'status=$?; if [ "$status" -eq 0 ]; then status=1; fi; printf "public-read-exit:%s:%s:unknown\\n" "$stage" "$status"; exit "$status"' EXIT`,
    ...checks.flatMap(([stage, command]) => [
      `stage=${stage}`,
      command,
      `printf 'public-read-check:${stage}\\n'`,
    ]),
    "stage=api-read",
    // The Node wrapper captures child stderr before emitting its allowlisted
    // class. Its exit receipt owns this final stage, including nonzero exits.
    "trap - EXIT",
    "node -e '" + helper.replaceAll("'", "'\\''") + "'",
  ].join("\n");
}
