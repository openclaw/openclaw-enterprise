import { managedCliInstalls } from "../managed-catalog.ts";

const install = managedCliInstalls.find(
  ({ packageName }) => packageName === "oce-google-workspace",
);
if (!install) {
  throw new Error("The reviewed Google Workspace CLI package is unavailable.");
}
export const managedGoogleInstall = install;
