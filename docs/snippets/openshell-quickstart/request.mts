// Run in the existing API container. The operator supplies one JSON request on stdin.
import assert from "node:assert/strict";

let input = "";
const chunks: AsyncIterable<unknown, undefined, unknown> = process.stdin;
for await (const chunk of chunks) {
  input += String(chunk);
}
const request: unknown = JSON.parse(input);
assert.ok(typeof request === "object" && request !== null && !Array.isArray(request));
const { method, path, ip, key, body, responseMode } = request as Record<string, unknown>;
if (typeof ip !== "string" || !/^[0-9.]+$/.test(ip)) {
  throw new Error("Invalid API Pod IP");
}
if (typeof path !== "string") {
  throw new Error("Invalid scoped REST target");
}
const target = new URL(`http://${ip}:8080${path}`);
const namespacePath = /^\/namespaces(?:\/|$)/;
const scopedNamespace = namespacePath.test(path) && namespacePath.test(target.pathname);
const installationRead = method === "GET" && path === "/installation" && body === undefined;
if (!scopedNamespace && !installationRead) {
  throw new Error("Invalid scoped REST target");
}
if (typeof method !== "string" || typeof key !== "string") {
  throw new Error("Invalid REST method or service key");
}
try {
  const response = await fetch(target, {
    method,
    headers: {
      "x-api-key": key,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(90000),
  });
  if (responseMode === "status") {
    console.log(response.status);
  } else if (!response.ok) {
    console.error(`OCE REST request failed with HTTP ${response.status}`);
    process.exitCode = 1;
  } else if (response.status !== 204) {
    const result: unknown = await response.json();
    console.log(JSON.stringify(result));
  }
} catch {
  console.error("OCE REST transport failed. Read back state before repeating a mutation.");
  process.exitCode = 1;
}
