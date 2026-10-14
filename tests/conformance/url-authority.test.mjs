import assert from "node:assert/strict";
import test from "node:test";
import { validateModelCredentialReferences } from "../../apps/controller/src/drivers/configuration/model-auth.ts";

const message = (field) =>
  `Configuration field ${field} has an empty authority or a missing //, which parses as a different host. Write an absolute http:// or https:// URL with the host you mean, and save again.`;

test("proxy, channel, MCP and plugin URLs refuse an empty authority or a missing scheme slash pair", () => {
  const refused = [
    [{ proxy: { proxyUrl: "https:///v1" } }, "/proxy/proxyUrl"],
    [{ proxy: { proxyUrl: "https:/v1" } }, "/proxy/proxyUrl"],
    [{ channels: { slack: { proxy: "http:///slack" } } }, "/channels/slack/proxy"],
    [
      { channels: { telegram: { accounts: { ops: { proxy: "https:proxy" } } } } },
      "/channels/telegram/accounts/ops/proxy",
    ],
    [{ mcp: { servers: { demo: { url: "https:/mcp" } } } }, "/mcp/servers/demo/url"],
    [
      { nodeHost: { mcp: { servers: { docs: { url: "https:///docs" } } } } },
      "/nodeHost/mcp/servers/docs/url",
    ],
    [
      {
        plugins: {
          entries: {
            codex: { config: { appServer: { networkProxy: { proxyUrl: "http:\\proxy" } } } },
          },
        },
      },
      "/plugins/entries/codex/config/appServer/networkProxy/proxyUrl",
    ],
    [
      {
        models: {
          providers: { gateway: { request: { proxy: { url: "https:///v1" } } } },
        },
      },
      "/models/providers/gateway/request/proxy/url",
    ],
    [{ env: { vars: { HTTPS_PROXY: "https:/v1" } } }, "/env/vars/HTTPS_PROXY"],
    // The URL parser reads backslashes as slashes, any scheme case, and drops leading spaces and
    // controls and every tab or newline, so each spelling still parses as another host.
    [{ proxy: { proxyUrl: "https:\\\\\\proxy" } }, "/proxy/proxyUrl"],
    [{ proxy: { proxyUrl: " https:///proxy" } }, "/proxy/proxyUrl"],
    [{ proxy: { proxyUrl: "\u0001https:/proxy" } }, "/proxy/proxyUrl"],
    [{ proxy: { proxyUrl: "HTTPS:///proxy" } }, "/proxy/proxyUrl"],
    [{ proxy: { proxyUrl: "HTTP:proxy" } }, "/proxy/proxyUrl"],
    [{ proxy: { proxyUrl: "ht\ttps:/proxy" } }, "/proxy/proxyUrl"],
    // A scheme alone, with no variable to finish it.
    [{ proxy: { proxyUrl: "https:/" } }, "/proxy/proxyUrl"],
  ];
  for (const [values, field] of refused) {
    assert.throws(
      () => validateModelCredentialReferences(values),
      (error) => {
        assert.equal(error.message, message(field));
        return true;
      },
      field,
    );
  }

  // A host stays. Model baseUrl keeps its own refusal, so this check does not claim it.
  validateModelCredentialReferences({
    proxy: { proxyUrl: "http://proxy.example:3128" },
    channels: { slack: { proxy: "https://proxy.example:3128" } },
    mcp: { servers: { demo: { url: "https://mcp.example.test/mcp" } } },
    models: { providers: { gateway: { baseUrl: "https:///v1" } } },
    // Two backslashes read as the two slashes.
    plugins: {
      entries: {
        codex: { config: { appServer: { networkProxy: { proxyUrl: "http:\\\\proxy:3128" } } } },
      },
    },
  });

  // The variable can supply `//host` or the second slash plus the host.
  // The filled Configuration is checked later.
  validateModelCredentialReferences(
    { proxy: { proxyUrl: "https:{{ vars.endpoint }}" } },
    {
      unresolved: (path) => (path.at(-1) === "proxyUrl" ? ["https:", ""] : undefined),
    },
  );
  validateModelCredentialReferences(
    { proxy: { proxyUrl: "https:/{{ vars.rest }}" } },
    {
      unresolved: (path) => (path.at(-1) === "proxyUrl" ? ["https:/", ""] : undefined),
    },
  );
  validateModelCredentialReferences(
    { proxy: { proxyUrl: "https:\\{{ vars.rest }}" } },
    {
      unresolved: (path) => (path.at(-1) === "proxyUrl" ? ["https:\\", ""] : undefined),
    },
  );
  // An empty authority is already in the literal, so a later variable cannot repair it.
  assert.throws(
    () =>
      validateModelCredentialReferences(
        { proxy: { proxyUrl: "https:///{{ vars.path }}" } },
        {
          unresolved: (path) => (path.at(-1) === "proxyUrl" ? ["https:///", ""] : undefined),
        },
      ),
    (error) => {
      assert.equal(error.message, message("/proxy/proxyUrl"));
      return true;
    },
  );
});
