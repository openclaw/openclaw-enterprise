---
rfc: ../rfcs/0020-anonymous-public-github-reads.md
---

# Qualify anonymous public GitHub reads for a dedicated Agent revision

**Delivery status: In progress.** The proposal and implementation are reviewed
together. Completion requires the security owner's review of the reader listener
and provider I/O, and passing the Agent journey on the reviewed source with no skips.

1. Pair the opt-in Helm Service and Compute peer in the Installation profile.
   Render the real chart and verify the ordinary profile still omits the reader.
2. Use the revision's plugin-runtime snapshot for both the discoverable skill and
   its own exact egress policy. Exercise selection and deselection while a
   predecessor is serving, activation, and retirement of each revision. A
   native-equivalent deny or a deny Compute cannot rule out must withhold both.
3. Exercise the reader over HTTP against a controlled TLS provider, including
   a public-to-private change, bounded pagination and shared quota denial.
   Protect its separation from credential custody with the existing source guard.
4. Require the named stock Codex read in ordinary PR Image Runtime Startup, with
   the reviewed seccomp profile on a supported runner. The command must use its
   projected skill, limited proxy and no local binding to recover a pull title
   present only at the private TLS provider. No model or repository credentials are needed.
5. Run the existing [Gateway Routing journey](../../docs/testing/gateway-routing.md)
   in an authorized isolated environment on the proposed source. Require managed
   skill discovery and a model answer containing the random pull title absent
   from the prompt. The provider in this journey is controlled; record live
   anonymous GitHub contract evidence separately. Ordinary PR CI does not run the journey.

The [operator reference](../../docs/reference/public-github-reads.md) owns
selection and retirement instructions. Record the implementation revision and
qualification results before marking delivery complete.
