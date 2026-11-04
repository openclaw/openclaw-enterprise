// Browser storage the console wrote, except the tab-scoped Installation-access probe answer
// (session owner key, admin flag and observability URL) and the tab's signed-in mark, which
// never hold drafts or credentials.
/** @param {import("playwright").Page} page */
export async function consoleStorage(page) {
  return page.evaluate(() => {
    const session = { ...sessionStorage };
    delete session["occ.console.installationAccess"];
    delete session["occ.console.signedIn"];
    return { local: { ...localStorage }, session };
  });
}
