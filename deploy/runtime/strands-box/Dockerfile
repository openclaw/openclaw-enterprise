# Package only artifacts emitted by build.ts from a verified source tree.
ARG OCE_RUNTIME_IMAGE
FROM ${OCE_RUNTIME_IMAGE}
ARG OCE_RUNTIME_IMAGE
ARG BUILD_RECORD_SHA256
USER root
RUN if test -L /var/run; then rm /var/run && mkdir /var/run; else test -d /var/run; fi
COPY --chmod=0555 strands-box strands-box-sock-alias strands-box-contain-trampoline /opt/strands-box/
COPY --chmod=0444 bridge/*.mjs /opt/oce/strands-box/
COPY --chmod=0444 build-record.json build.ts /opt/strands-box/
USER node
# Check the bytes and modes the normal runtime user actually sees.
RUN node /opt/strands-box/build.ts verify-installed --record-sha256 "$BUILD_RECORD_SHA256" --runtime-image "$OCE_RUNTIME_IMAGE"
LABEL org.strands-box.build-record-sha256=$BUILD_RECORD_SHA256
