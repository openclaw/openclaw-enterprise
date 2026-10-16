# The build context contains the Linux sender binary and its accompanying notices.
FROM gcr.io/distroless/cc-debian13@sha256:54df941ed0d06a1bd95ef5e0ce391fd8d9f94b64782dc9a60062727849ee3f97
COPY --chown=65532:65532 --chmod=0555 strands-credential-proxy /usr/local/bin/strands-credential-proxy
COPY --chown=0:0 licenses /usr/share/doc/strands-credential-proxy/licenses
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/strands-credential-proxy"]
