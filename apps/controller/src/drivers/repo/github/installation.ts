import { closed, nonempty, object } from "../../../composition/installation-fields.ts";
import type { PreparedRepositoryGitConfiguration } from "../../../backends/repository-credentials/prepared-git-owner.ts";
import { preparedGitHubConfiguration } from "./credentials/prepared-configuration.ts";

/** Interpret portable repository configuration after integration extracts transport. */
export function githubRepositoryConfiguration(input: unknown) {
  if (input === undefined) {
    return undefined;
  }
  const selection = object(input, "repository");
  closed(selection, ["id", "configuration", "preparedGitHub", "nativeSender"], "repository");
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
    selection,
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
