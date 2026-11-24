import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// OpenClaw intentionally gives its workspace node a reduced environment. Carry
// only provider routing into that child; model credentials stay excluded.
const routing = Object.fromEntries(
  [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
  ].map((key) => [key, process.env[key]]),
);
for (const module of [http, https]) {
  const Agent = module.Agent;
  module.Agent = class extends Agent {
    constructor(options = {}) {
      super({ ...options, proxyEnv: routing });
    }
  };
  module.globalAgent = new module.Agent();
  const request = module.request;
  module.request = function (...args) {
    const index = typeof args[0] === "string" || args[0] instanceof URL ? 1 : 0;
    const options = args[index];
    // ws supplies createConnection, which makes Node skip its global Agent.
    // Keep the explicit caller Agent when present; otherwise use the same
    // provider proxy for this request, including its WebSocket upgrade.
    if (options?.createConnection && options.agent === undefined) {
      args[index] = { ...options, agent: module.globalAgent };
    }
    return request.apply(this, args);
  };
}
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = childProcess[name];
  childProcess[name] = function (file, args, options, ...rest) {
    // Native Codex probes also receive a reduced environment. Keep provider
    // routing there; NODE_OPTIONS covers Node shebang launchers such as codex
    // and is ignored by native binaries. Never copy model credentials.
    if (Array.isArray(args) && options && typeof options === "object") {
      const env = { ...(options.env ?? process.env), ...routing };
      const preload = "--jitless --import=/opt/oce/strands-box/proxy-preload.mjs";
      if (!(env.NODE_OPTIONS ?? "").includes(preload)) {
        env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} ${preload}`.trim();
      }
      options = { ...options, env };
    }
    return original.call(this, file, args, options, ...rest);
  };
}
syncBuiltinESMExports();
