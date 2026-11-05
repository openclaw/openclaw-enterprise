import type { Page } from "playwright";

// Browser storage the console wrote, except the tab-scoped Installation-access probe answer
// (session owner key, admin flag and observability URL) and the tab's signed-in mark, which
// never hold drafts or credentials.
export async function consoleStorage(page: Page) {
  const { local, session } = await page.evaluate(() => {
    const entries = (storage: Storage, excluded: string[] = []): [string, string][] => {
      const result: [string, string][] = [];
      for (let index = 0; index < storage.length; index++) {
        const key = Storage.prototype.key.call(storage, index);
        if (key === null || excluded.includes(key)) {
          continue;
        }
        const value = Storage.prototype.getItem.call(storage, key);
        if (value !== null) {
          result.push([key, value]);
        }
      }
      return result;
    };
    return {
      local: entries(localStorage),
      session: entries(sessionStorage, ["occ.console.installationAccess", "occ.console.signedIn"]),
    };
  });
  return { local: Object.fromEntries(local), session: Object.fromEntries(session) };
}
