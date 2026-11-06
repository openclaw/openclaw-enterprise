# Pass an approved Node 24.22.1-or-newer image by digest.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /opt/box-ingress
COPY network.ts relay.ts ./
USER 1000:1000
ENTRYPOINT ["node", "/opt/box-ingress/relay.ts"]
CMD ["serve"]
