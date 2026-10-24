import assert from "node:assert/strict";
import type { BrowserContext, Response } from "playwright";
import type { AgentDeletionStatusResponse } from "../../packages/contracts/src/index.ts";

// Used by the shipped Console journey (real worker) and the browser suite (memory finalizer).
export async function verifyConsoleAgentDeletion(
  browser: BrowserContext,
  origin: string,
  agent: { namespaceId: string; id: string },
  complete?: () => Promise<void>,
) {
  // Shipped QA runs this beside model-ui in the same signed-in context. Own a page for the
  // entire deletion; it obtains its own Console session binding from the authenticated cookie.
  const page = await browser.newPage();
  const agentPath = `/namespaces/${agent.namespaceId}/agents/${agent.id}`;
  const statusPath = agentPath + "/deletion-status";
  const statusResponse = (response: Response) => new URL(response.url()).pathname === statusPath;
  const reads: string[] = [];
  let writes = 0;
  const observe = (request: import("playwright").Request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === "DELETE" && pathname === agentPath) {
      writes++;
    } else if (writes > 0 && pathname.startsWith(agentPath)) {
      reads.push(pathname);
    }
  };
  page.on("request", observe);
  try {
    const target = `/console/agents/${agent.id}?namespace=${agent.namespaceId}`;
    await page.goto(new URL(target, origin).href);
    await page.getByRole("button", { name: "Delete Agent", exact: true }).click();
    const first = page.waitForResponse(statusResponse);
    await page.getByRole("button", { name: "Permanently delete Agent" }).click();
    const response = await first;
    assert.equal(response.status(), 200);
    assert.equal(response.headers()["cache-control"], "no-store");
    const data: AgentDeletionStatusResponse["data"] = (await response.json()).data;
    const receipt = new URL(response.url()).searchParams.get("receiptId");
    assert.ok(receipt);
    assert.equal(data.receiptId, receipt);
    assert.equal(data.namespaceId, agent.namespaceId);
    assert.equal(data.agentId, agent.id);

    if (complete) {
      assert.equal(data.status, "queued");
      await page.getByRole("heading", { name: "Deletion queued" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Retry cleanup" }).isVisible(), false);
      await complete();
    }
    const deleted = page.getByRole("heading", { name: "Agent deleted", exact: true });
    await deleted.waitFor({ timeout: complete ? 12_000 : 180_000 });
    const reloaded = page.waitForResponse(statusResponse);
    await page.reload();
    const result = await reloaded;
    assert.equal(result.status(), 200);
    assert.deepEqual((await result.json()).data, {
      agentId: agent.id,
      namespaceId: agent.namespaceId,
      receiptId: receipt,
      status: "deleted",
    });
    await deleted.waitFor();
    assert.equal(writes, 1, "polling, completion and reload never repeat deletion");
    assert.deepEqual(
      [...new Set(reads)],
      [statusPath],
      "following a receipt must not read the Agent or its settings",
    );
    const receiptUrl = page.url();
    await page.getByRole("link", { name: "Back to Agents", exact: true }).click();
    await page.waitForURL(
      (url) =>
        url.pathname === "/console/agents" &&
        url.searchParams.get("namespace") === agent.namespaceId,
    );
    return receiptUrl;
  } finally {
    await page.close();
  }
}
