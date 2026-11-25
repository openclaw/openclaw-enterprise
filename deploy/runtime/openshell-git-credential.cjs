#!/usr/local/bin/node
const { readFileSync } = require("node:fs");

// The node passes only the Sandbox placeholder. OpenShell authenticates the request.
if (process.argv[2] === "get" && process.env.OPENCLAW_WORKER_TOOL_DATA) {
  const data = JSON.parse(process.env.OPENCLAW_WORKER_TOOL_DATA);
  const request = new Map();
  for (const line of readFileSync(0, "utf8").split("\n")) {
    if (!line) {
      break;
    }
    const split = line.indexOf("=");
    request.set(line.slice(0, split), line.slice(split + 1));
  }
  if (
    request.get("protocol") === "https" &&
    request.get("host") === "github.com" &&
    typeof data.gitRepositories === "string" &&
    data.gitRepositories.split(" ").some((repo) => request.get("path") === repo + ".git") &&
    typeof data.gitPlaceholder === "string" &&
    /^openshell:resolve:env:s[0-9a-f]{64}_OCE_SOURCE_[0-9A-F]{24}$/.test(data.gitPlaceholder)
  ) {
    process.stdout.write("username=x-access-token\npassword=" + data.gitPlaceholder + "\n");
  }
}
