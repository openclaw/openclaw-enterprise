# Optional provider layer on a matching OCE runtime. The artifact context has
# three reviewed Box binaries and bridge/*.mjs from this checkout.
ARG OCE_RUNTIME_IMAGE
FROM ${OCE_RUNTIME_IMAGE}
ARG STRANDS_BOX_SOURCE_REVISION
USER root
# Compute's projected identity is opened at /var/run. Box requires grants to
# name the kernel path and constructs its own filesystem view from those grants.
# Make that exact path representable in this provider-specific image.
RUN test -n "$STRANDS_BOX_SOURCE_REVISION" \
    && if test -L /var/run; then test "$(readlink -f /var/run)" = /run && rm /var/run && mkdir /var/run; else test -d /var/run; fi
COPY --chmod=0555 strands-box strands-box-sock-alias strands-box-contain-trampoline /opt/strands-box/
COPY --chmod=0444 bridge/*.mjs /opt/oce/strands-box/
RUN chmod 0555 /opt/oce/strands-box
LABEL org.strands-box.source-revision=$STRANDS_BOX_SOURCE_REVISION
USER node
