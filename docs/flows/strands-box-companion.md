# Run the Strands Box companion

Build the provider layer from [its Dockerfile](../../deploy/runtime/strands-box/Dockerfile) against the OCE runtime for the target architecture. In the build context, supply the reviewed `strands-box`, `strands-box-sock-alias` and `strands-box-contain-trampoline` binaries. Put the matching bridge modules in `bridge/`. Set the build arguments `OCE_RUNTIME_IMAGE` and `STRANDS_BOX_SOURCE_REVISION`. The image runs as `node`. The Sandbox Driver owns Pod creation and admission.

## Startup and transport

1. The supervisor reads the mounted manifest and runs Box with `/etc/strands-box/box.toml`. [outer.mjs](../../deploy/runtime/strands-box/outer.mjs) owns the child lifetime. Box supplies the private PID namespace. Its standard input and output carry framed channel messages. Child logs go to standard error.
2. The contained [bootstrap](../../deploy/runtime/strands-box/inner.mjs) opens the projected files named by `secretEnvironment` and starts the admitted `command` in `workspace`. Model credentials belong to that process. Keep their values out of the manifest and Box configuration.
3. The [listener initializer](../../deploy/runtime/strands-box/initialize-listener.mjs) creates a certificate for the Pod. The Gateway and worker verify the admitted certificate before sending credentials. The [supervisor](../../deploy/runtime/strands-box/supervisor.mjs) validates the revision bearer before passing native traffic to the contained process. The diagnostic listener accepts the revision readiness request and cannot upgrade to a native session. The [handshake](../../deploy/runtime/strands-box/handshake.mjs) checks native initialization. Readiness retains capacity when session channels are full.
4. The contained proxy forwards the configured Gateway address over the private stream. Other destinations use Box's policy proxy. A failed connection closes the channel. A normal EOF lets the destination finish its queued writes.

Run `node --test tests/conformance/strands-box-transport.test.ts` for channel limits, proxy handling and shutdown. When startup stalls, check for a refused native handshake, a failed child, or missing projected files. An HTTP 401 on the native listener indicates missing or invalid transport credentials. Inspect revision and Pod status without logging bearer headers or Secret values.
