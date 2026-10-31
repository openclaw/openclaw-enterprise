// Helpers for an action a console test takes and the API answer it waits for.

/**
 * Waits for the answer to the page's next `method` request to exactly `url`; with `status`, only
 * an answer with that status. Start it before the action that sends the request.
 *
 * @param {import("playwright").Page} page
 * @param {string} method
 * @param {string} url
 * @param {{ status?: number }} [options]
 * @returns {Promise<import("playwright").Response>}
 */
export const responseTo = (page, method, url, { status } = {}) =>
  page.waitForResponse(
    (response) =>
      response.url() === url &&
      response.request().method() === method &&
      (status === undefined || response.status() === status),
  );

/**
 * Confirms an Agent's Stop or Delete in the open confirmation dialog named `title`.
 *
 * @param {import("playwright").Page} page
 * @param {string} title
 * @param {"Stop" | "Delete"} action
 */
export const confirmAgentAction = (page, title, action) =>
  page
    .getByRole("dialog", { name: title })
    .getByRole("button", {
      name: action === "Stop" ? "Stop Agent" : "Permanently delete Agent",
      exact: true,
    })
    .click();
