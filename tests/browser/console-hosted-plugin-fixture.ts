import type { TestContext } from "node:test";

// Substitute only the outside catalog service; Console, OCC routes, Secret access, and the
// selected Codex Plugin Driver still execute normally.
export function mockHostedLinearCatalog(t: TestContext) {
  const originalFetch = globalThis.fetch;
  const linear = {
    id: "remote-linear",
    name: "linear",
    scope: "GLOBAL",
    status: "ENABLED",
    installation_policy: "AVAILABLE",
    release: {
      display_name: "Linear",
      description: "Hosted Linear plugin",
      interface: { short_description: "Linear tools" },
      requires_local_executor: false,
      app_ids: ["app_linear"],
      skills: [],
      mcp_servers: [],
    },
  };
  t.mock.method(globalThis, "fetch", async (...[input, options]: Parameters<typeof fetch>) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "auth.openai.com") {
      return Response.json({
        chatgpt_account_id: "account-console-plugin",
        chatgpt_account_is_fedramp: false,
      });
    }
    if (url.hostname !== "chatgpt.com") {
      return originalFetch(input, options);
    }
    if (url.pathname.endsWith("/plugins/list") || url.pathname.endsWith("/plugins/search")) {
      return Response.json({ plugins: [linear], pagination: { next_page_token: null } });
    }
    if (url.pathname.endsWith("/plugins/remote-linear")) {
      return Response.json(linear);
    }
    if (url.pathname.endsWith("/apps/batch")) {
      return Response.json({
        apps: [
          {
            id: "app_linear",
            status: "ENABLED",
            tools: [
              { name: "search", title: "Search issues", is_enabled: true, is_read_only: true },
            ],
          },
        ],
      });
    }
    throw new Error(`Unexpected hosted catalog request: ${url.pathname}`);
  });
}
