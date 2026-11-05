import { closed, nonempty, object } from "../../../composition/installation-fields.ts";
import type { ConfigurationRecord } from "../../../composition/installation-fields.ts";
import type { PreparedRepositoryGitConfiguration } from "../../../backends/repository-credentials/prepared-git-owner.ts";
import { preparedGitHubConfiguration } from "./credentials/prepared-configuration.ts";

/** Interpret portable repository configuration after integration extracts transport. */
export function githubRepositoryConfiguration(selection: ConfigurationRecord) {
  const native =
    selection.nativeSender === undefined
      ? undefined
      : object(selection.nativeSender, "repository.nativeSender");
  let nativeSender: { controlSocket: string; publicCaPath: string } | undefined;
  if (native) {
    closed(native, ["controlSocket", "publicCaPath"], "repository.nativeSender");
    nativeSender = {
      controlSocket: nonempty(native.controlSocket, "repository.nativeSender.controlSocket"),
      publicCaPath: nonempty(native.publicCaPath, "repository.nativeSender.publicCaPath"),
    };
  }
  return {
    nativeSender,
    prepared:
      selection.preparedGitHub === undefined
        ? undefined
        : (preparedGitHubConfiguration(
            selection.preparedGitHub,
            true,
          ) as PreparedRepositoryGitConfiguration),
  };
}
