import assert from "node:assert/strict";
import { test } from "node:test";
import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";
import { baseInput, codexInput, repositoryConfiguration } from "./profile-renderer-inputs.ts";
import { repository, helmSkip, helmTemplate, renderCli } from "./profile-renderer-fixture.ts";

export function registerDnsCases(): void {
  test(
    "profiles preserve repository provider ranges without resolving API discovery hosts",
    { skip: helmSkip },
    async (t) => {
      for (const profile of ["openclaw", "codex"]) {
        const input = profile === "codex" ? codexInput() : baseInput();
        input.repository = repositoryConfiguration(["140.82.112.0/20", "192.30.252.0/22"]);
        const directory = temporaryDirectorySync(t, `oce-profile-egress-${profile}-`);
        const output = renderCli(profile, input, directory, repository);
        const manifests = helmTemplate(output);
        assert.match(manifests, /cidr: "140\.82\.112\.0\/20"/);
        assert.match(manifests, /cidr: "192\.30\.252\.0\/22"/);
        assert.doesNotMatch(manifests, /name: openclaw-enterprise-api-model-discovery-egress/);
      }
    },
  );
}
