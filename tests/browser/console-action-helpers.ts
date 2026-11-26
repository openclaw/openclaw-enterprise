import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";

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

// A focused control or status can be inside the viewport but clipped by a scrolling panel.
export const fullyInView = (target: Locator) =>
  target.evaluate(
    (node) =>
      new Promise<boolean>((resolve) => {
        const observer = new IntersectionObserver(([entry]) => {
          observer.disconnect();
          resolve(entry?.isIntersecting === true && entry.intersectionRatio === 1);
        });
        observer.observe(node);
      }),
  );

// Capture the touch point after the dialog opens, while its read is still held.
export async function prepareDismissTap(
  dialog: Locator,
  button: Locator,
  name: "Cancel" | "Close",
) {
  await dialog.evaluate(async (node) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished));
  });
  const box = await button.boundingBox();
  assert.ok(box, `the loading ${name} must have a bounding box`);
  const point = {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
  const hitsButton = () =>
    button.evaluate(
      (element, { x, y }) => element.contains(globalThis.document.elementFromPoint(x, y)),
      point,
    );
  assert.ok(await hitsButton(), `the loading ${name} touch point must hit ${name}`);

  return async () => {
    assert.ok(await hitsButton(), `${name} must still receive the touch at its loading position`);
    await button.page().touchscreen.tap(point.x, point.y);
  };
}
