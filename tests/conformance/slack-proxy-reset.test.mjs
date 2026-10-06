import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { connectThroughProxy, startSlackProxy } from "../helpers/slack-proxy.mjs";

test("a refused CONNECT reset leaves the Slack proxy running", async (t) => {
  const { child, port: proxyPort, stderr } = await startSlackProxy(t, { fixedPort: true });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write("CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n");
    socket.resetAndDestroy();
  }

  let response;
  try {
    response = await connectThroughProxy(proxyPort, "example.com:443");
  } catch (error) {
    assert.fail(`proxy exited ${child.exitCode}: ${stderr()}\n${error}`);
  }
  assert.match(response, /^HTTP\/1\.1 403 Forbidden/);
  assert.equal(child.exitCode, null);
  assert.doesNotMatch(stderr(), /unhandled/i);
});
