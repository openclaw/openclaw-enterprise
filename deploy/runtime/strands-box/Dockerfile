# Optional provider layer on a matching OCE runtime. The artifact context has
# three reviewed Box binaries and bridge/*.mjs from this checkout.
ARG OCE_RUNTIME_IMAGE
FROM ${OCE_RUNTIME_IMAGE}
USER root
# The prepared mount view preserves the canonical projected identity path.
RUN test -L /var/run && rm /var/run && mkdir /var/run
COPY --chmod=0555 strands-box strands-box-sock-alias strands-box-contain-trampoline /opt/strands-box/
COPY --chmod=0444 bridge/*.mjs /opt/oce/strands-box/
LABEL org.strands-box.source-revision="c4a2443791d5656c87025d861d733648416649ab"
LABEL org.strands-box.local-patch="container-pid-boundary"
USER node
