# PR readiness checklist

Complete the applicable items before requesting review. Record pending merge
requirements in the PR and recheck them against the final head before merging.
Mark an item not applicable with a short reason; do not mark missing evidence
as passed. The [contribution policy](../../../../CONTRIBUTING.md#prepare-a-pull-request)
owns author, review, and merge permissions.

- [ ] **Scope:** The diff implements the requested outcome through its owning
      primitive, stays within approved milestones, and preserves unrelated work.
- [ ] **Documentation:** Affected current references, guides, cheat sheets, and
      navigation agree with the change. Non-trivial runtime changes update their
      source-backed flow; trivial maintenance records why no flow update is needed.
- [ ] **Verification:** Proportional checks cover the changed behavior, including
      required real integration proof for new platform functionality. Record
      commands, tested revision, failures, skips, and limitations. For prose-only
      changes, check formatting, links, and documentation; do not run runtime tests.
- [ ] **Image versions:** If a default image version, digest, source pin, bundled
      runtime version, image recipe, or version gate changes, complete
      [image version verification](./image-version-verification.md) before merge.
      Link passing native checks for both images on both architectures at the
      final PR head, and identify the authorized post-merge publication owner or
      pending handoff. Ordinary PR CI and stale `latest` images are insufficient.
- [ ] **Console evidence:** For UI changes, update stories and inspect rebuilt
      previews. Include final screenshots, a short interaction video, story names,
      tested revision, and proof limits; upload the required PR attachments before
      merge under the [Console rules](../../../../AGENTS.md#console-storybook).
- [ ] **Publication safety:** Inspect the full diff and attachments for secrets,
      private data, internal names, and personal paths. Verify the contributor,
      destination repository, ref, and remote head.
- [ ] **Review and CI:** Describe the problem, resulting behavior, and evidence.
      Before merge, satisfy applicable review, resolve substantive findings and
      holds, and verify required CI at the final head. Do not claim an independent
      review or a manual lane ran without its evidence.
- [ ] **Handoff:** Report the PR, tested revision, remaining limitations, and any
      pending release work. Distinguish source merged, images published, chart
      published, and deployment verified; evidence for one does not prove another.
