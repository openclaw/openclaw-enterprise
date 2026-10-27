---
rfc: ../../rfcs/0024-strands-box-sandbox.md
---

# Review and qualification record

This record preserves the local acceptance results for the earlier image
generations. It does not qualify the replacement OCE code-mode entrypoint.

### Requalify the reviewed mount trim (2026-10-26)

- [x] Apply the approved removal of the generic inherited mount-flags rewrite.
      Align the OCE setup generator with the original exact mount arguments.
- [x] Build the trimmed Box in release mode; record source, binary, image and
      setup-profile hashes. Preserve the previous qualified snapshot separately.
- [x] Run containment refusal controls and the complete native RFC QA on the
      new immutable runtime. Retain failures; do not retry model turns.
- [x] Stop/start the retained VM and prove automatic recovery on that same
      image, including files, skills, keyword/semantic memory and security.
- [x] Withdraw credentials, clean disposable probes and update the acceptance
      report and retained-resource inventory with new evidence only.

A fresh 32/32 native run and actual VM stop/start passed on the same immutable
`32ca8aa6` runtime with the 25-rule setup profile. Two new postboot model tasks
proved files, skills, keyword and local semantic memory without manual repair
or an index rebuild. Security, revision and PVC identity stayed unchanged.
Both Agents are stopped; the original keyword configuration is restored and
38 scoped Secret fields contain zero personal-key matches. Current evidence:
`trimmed-runtime-20261026`, `trimmed-qa-20261026` and
`trimmed-recovery-20261026`. The English Google Doc and resource inventory are
updated. Previous results were not substituted. The Box upstream review patch is `7f76582f27c25d808ccf196332d363d0267ebe7009d63cfdff69e0d68b4e999d`.
No architecture, workload permissions, admission exception or external endpoint
change is authorized by this requalification.

### Complete narrowed-candidate acceptance (2026-10-26)

- [x] Replace the native launcher message transport with a bounded byte pipe,
      preserving bootstrap/restart acknowledgements, readiness and custody.
      Keep version-negotiated compatibility with existing installed runtimes.
- [x] Prove native startup under recvmsg denial and lifecycle/error regressions.
      Fix further necessary IPC consumers at their owner if the real flow reaches them.
- [x] Build one final immutable runtime with the narrowed Box filter and OCE
      setup profile; run the full native RFC QA without retrying model turns.
- [x] Verify real VM recovery, split storage, files, skills and semantic memory
      on that same image; update the English acceptance report and inventory.

All 32 native RFC checks passed on the single final `9f846225` runtime, followed
by real VM stop/start and two successful model tasks proving retained memory,
skills, shell execution and local semantic retrieval. Boot identity changed;
revision, PVCs, file hash, security contexts and narrow profile did not. No
manual pairing/workload repair or postboot index rebuild was used. Configuration
and keyword index are restored, both retained Agents are stopped and the personal
key is absent from the checked tenant/control-plane Secret fields. The safe
image remains installed. Current evidence: `ipc-final-qa-observer-fixed-20261026`
and `ipc-final-recovery-20261026` under the task evidence directory. The English
Google Doc records necessity, ownership, qualification and exclusions. Historical
passes do not substitute for this image's evidence. No publication or merge.

### Necessity review (2026-10-26)

- [x] Stock refusal confirmed under both setup profiles. A credential-free
      private PID-1 probe mounted tmpfs but failed to mount procfs with identical
      allowed flags; default proc masks remained in force.
- [x] Keep the opt-in container PID/proc adoption and generic descriptor/lifetime
      handoff. Pod/PVC/readiness ownership stays in OCE; no alternate VM provider.
- [x] Keep atomic no-replace rename and private-namespace process-group cleanup.
      Removing either breaks its native operation. Fix the demonstrated
      `kill(0)` path to the reaper by rejecting zero as well as 1 and -1.
- [x] Reject and remove the `recvmsg(MSG_CMSG_CLOEXEC)` permit. A reachable,
      test-owned Unix broker transferred a descriptor to a hidden synthetic file;
      CLOEXEC did not stop its read. The narrowed runtime refuses the transfer.
      This is a conditional counterexample, not an actual OCE broker exploit.
- [x] Move provider setup generation into OCE. RuntimeDefault plus 13 exact setup
      rules yields 26 total, a strict subset of the original 163. Remove-one
      probes attribute all 13 operations; the positive profile passes native
      setup, Codex initialization and containment boundaries. Qualification is
      ARM64/relatime; unsupported mount variants fail closed.
- [x] Verify the tightened diagnostic image, source snapshots, focused kernel
      regressions, ordinary child-group termination and supervisor-loss cleanup.
      Update the existing English review Doc and retain both image generations.

The tighter diagnostic image is
`sha256:8d86d0d7dfd27c50d4c447b3aaae7dd7ac729701bfdf604631ec88d433368e4a`.
It replaces only the containment trampoline on the earlier accepted runtime.
The native OCE deployment attempt failed at `WORKSPACE_NODE_PENDING`: both Pods
were Ready and the model-auth probe returned READY, but the workspace node never
connected. No QA model conversation ran. Cleanup stopped the Agent and withdrew
its key; the installation was then restored to the retained baseline.

A credential-free native CLI comparison isolates `recvmsg`: same historical
image, same new 26-rule profile, same `openclaw node run` invocation and fresh
state. The control reaches the intentionally closed loopback Gateway endpoint;
adding only a recvmsg denial exits before connecting. Native setup succeeds in
both cases. The packaged node launcher uses Node IPC and terminates its child on
disconnect (`node-host-launcher.mjs`, fixed OpenClaw baseline). The already-used
`OPENCLAW_NO_AUTO_UPDATE=1` does not remove that connection. `--ephemeral` changes
worker-hosting/lifecycle semantics and is not a transparent adapter fix.
Evidence: `necessity-20261026/native-node/` and `native-oce/`.
The earlier isolated quiescence fixture failed on a missing scratch grant;
it is not an IPC pass or a newly attributed production OCE defect.

Follow-up implemented locally: the native OpenClaw launcher uses a bounded
JSON byte stream on POSIX when the selected package advertises support. Existing
installed packages and Windows retain their IPC protocol. No global process API
is monkey-patched, and no Box recvmsg grant is needed. All 32 launcher lifecycle
regressions pass, including fragmented bootstrap, bounded invalid frames and
legacy compatibility. Actual native startup succeeds with recvmsg denied.
The immutable follow-up runtime is
`sha256:9f846225b98f3822b737bdd5a4918c1f9dd9622590ddbce36ed2584c5854988d`.
Complete native RFC QA passed all 32 checks; subsequent actual VM recovery and
semantic recall passed on this same image with recvmsg still denied.

Two harness defects were corrected without changing the runtime image: the
outer local wrapper's 15-minute deadline could interrupt native 330-second
drains; it now permits the complete sequence and recorded cleanup. The local
observer incorrectly forwarded the API server's 72-second Keep-Alive header on
its own 5-second HTTP hop. An independent idle-boundary probe reproduced
`UND_ERR_SOCKET`; stripping hop-by-hop headers gives nine successful boundary
requests without retries. This is local test access, not Box or OCE runtime code.
IAM cleanup assertions now stay inside their recorded check, and aggregate
failures persist redacted reasons. An independent native IAM create/delete
control removed its exact grant without any Box deployment or model call.
Earlier incomplete/failed QA evidence is preserved. The latest full run is
`ipc-final-qa-observer-fixed-20261026`; only a complete pass qualifies this image.
An adapter monkey patch, disabled custody/watchdog or blanket recvmsg grant is
not acceptable. The earlier diagnostic attempt used one model-auth probe and no
QA model turns. The final safe image now has its own full model-tool QA and
reboot evidence; older results remain evidence for their original digests only.
Four release/all-features kernel tests passed without skips. Rustfmt and focused
OCE format/lint passed. Clippy completed with two pre-existing warnings found
in pristine Box `view.rs` and `args.rs`; `-D warnings` remains blocked by those.
No push, PR publication, merge, runtime pin rollout or security relaxation.
