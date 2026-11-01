// Run in the existing API container. The operator supplies one JSON request on stdin.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { method, path, ip, key, body } = JSON.parse(input);
if (!/^\/namespaces(?:\/|$)/.test(path) || !/^[0-9.]+$/.test(ip)) {
  throw new Error("Invalid scoped REST target");
}
try {
  const response = await fetch(`http://${ip}:8080${path}`, {
    method,
    headers: {
      "x-api-key": key,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) {
    console.error(`OCE REST request failed with HTTP ${response.status}`);
    process.exitCode = 1;
  } else if (response.status !== 204) {
    console.log(JSON.stringify(await response.json()));
  }
} catch {
  console.error("OCE REST transport failed. Read back state before repeating a mutation.");
  process.exitCode = 1;
}
