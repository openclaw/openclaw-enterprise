import { createOpenShellOnlineGitAuthority } from "../../apps/controller/src/drivers/egress-proxy/openshell-online-git-authority.ts";
import { openShellOnlineWire } from "./openshell-online-wire.mjs";

// TLS and a fixture-signed identity, not an installed OpenShell sender.
export function openShellOnlineGitWire(t, options) {
  return openShellOnlineWire(
    t,
    options.registrationName ?? "online-git",
    options,
    createOpenShellOnlineGitAuthority,
  );
}

// Model the trusted owner's recorded allow for this inspected request and installed material.
export function onlineGitAllow(request, installed) {
  return {
    kind: "allow",
    exchangeId: request.exchangeId,
    requestDigestSha256: request.requestDigestSha256,
    preparationAttemptId: installed.preparationAttemptId,
    materialVersion: installed.materialVersion,
    replyBy: request.deadlineAt,
  };
}
