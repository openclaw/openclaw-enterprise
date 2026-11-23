// This Storybook-only page simulates a completed callback. It does not exchange an OAuth
// code or handle a real credential. The originating fixture holds the pending consent.
const parameters = new URL(location.href).searchParams;
const namespaceId = parameters.get("namespace");
const sourceId = parameters.get("sourceId");
if (!namespaceId || !sourceId || !/^cs_[0-9a-f-]{36}$/.test(sourceId)) {
  throw new Error("Invalid simulated consent completion.");
}
const channel = new BroadcastChannel(`oce.storybook.connection.${sourceId}`);
channel.onmessage = (event: MessageEvent<unknown>) => {
  if (event.data !== "stored") {
    return;
  }
  channel.close();
  location.replace(
    `/console/?namespace=${encodeURIComponent(namespaceId)}&connection=connected&sourceId=${encodeURIComponent(sourceId)}`,
  );
};
channel.postMessage("complete");
