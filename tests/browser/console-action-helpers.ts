import type { Page } from "playwright";

// Start waiting before the action that sends the request. Check the response status separately.
export const responseTo = (page: Page, method: string, url: string) =>
  page.waitForResponse(
    (response) => response.url() === url && response.request().method() === method,
  );

// Confirms an Agent's Stop or Delete in the open confirmation dialog named title.
export const confirmAgentAction = (page: Page, title: string, action: "Stop" | "Delete") =>
  page
    .getByRole("dialog", { name: title })
    .getByRole("button", {
      name: action === "Stop" ? "Stop Agent" : "Permanently delete Agent",
      exact: true,
    })
    .click();
