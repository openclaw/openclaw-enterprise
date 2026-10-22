import { story } from "./story.mjs";

export default { title: "Components/Connections" };

export const ConnectionsEmpty = { ...story("connectionsEmpty"), name: "Empty" };
export const ConnectionsConsent = {
  ...story("connectionsConsent"),
  name: "Consent warning and popup",
};
export const ConnectionsStarting = { ...story("connectionsStarting"), name: "Starting" };
export const ConnectionsConnected = { ...story("connectionsConnected"), name: "Connected" };
export const ConnectionsNotDeployed = {
  ...story("connectionsNotDeployed"),
  name: "Connected, not deployed",
};
export const ConnectionsReconnectToApply = {
  ...story("connectionsReconnectToApply"),
  name: "Reconnect to apply changes",
};
export const ConnectionsReauthorize = {
  ...story("connectionsReauthorize"),
  name: "Reconnect required",
};
export const ConnectionsDisconnect = { ...story("connectionsDisconnect"), name: "Disconnect" };
export const ConnectionsWithdrawalPending = {
  ...story("connectionsWithdrawalPending"),
  name: "Withdrawal pending",
};
export const ConnectionsFailedLanding = {
  ...story("connectionsFailedLanding"),
  name: "Failed after redirect",
};
export const ConnectionsRefused = { ...story("connectionsRefused"), name: "Start refused" };
export const ConnectionsTemplateUseDenied = {
  ...story("connectionsTemplateUseDenied"),
  name: "Template use denied",
};
