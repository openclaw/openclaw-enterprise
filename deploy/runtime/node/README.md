# Node worker-termination repair

The runtime builds Node 24.22.1 from the checksum-pinned source in
[`source.json`](source.json) with [`worker-esm-termination.patch`](worker-esm-termination.patch).
The patch prevents a process abort when worker termination interrupts the
CommonJS loader's synchronous ESM facade creation. It clears the temporary
module reference and accepts an empty instantiation result only while V8 is
terminating execution; unexpected failures still abort.

Build through the [runtime recipe](../README.md#build-a-local-runtime-image).
`NODE_BASE_IMAGE` and `NODE_RUNTIME_BASE_IMAGE` must both provide Node 24.22.1
on Bookworm. A newer override fails instead of silently receiving an older
binary. The separate repository-credential service keeps its original base.

[`build.sh`](build.sh) retains full ICU and default features, defaults to four
compiler jobs, and runs the real worker regression plus six adjacent loader cases. The
same cases run against the copied binary in slim Bookworm, with linkage, locale
and crypto checks. Compiler objects are removed before the build layer commits.
The source-only stage remains available for the slim test harness.

For a builder with verified spare CPU and memory, pass
`--build-arg NODE_BUILD_JOBS=8` to select more compiler jobs. The build-only
argument accepts a positive decimal integer without leading zeros; an empty
value fails. It changes only Make parallelism in the Node compile stage, not
runtime settings or compiler options. Size it for the builder's effective CPU
and memory limits, including concurrent builds and linking. Changing this
argument invalidates the compile layer; record it with build timing evidence.

A clean source build adds substantial compilation time. Builds that reuse
compiler objects do not establish clean-build cost. Before release, require
successful native AMD64 and ARM64 image verification, including packaged
Gateway shutdown and restart. Standalone Node checks do not prove that workflow.

Final `/opt/oce/runtime/provenance.json` records the Node source, patch, ABI and
actual executable digest under `node`. The build also retains
`/usr/local/share/oce-node/provenance.json`; final inventory checks its digest
against the running executable before copying it into runtime provenance.

Remove this temporary bridge only after selecting an upstream release containing
the termination fix and passing both native image lanes. Update both base pins,
the source manifest, owning checks and documentation together.
