FROM docker.io/library/node:24-bookworm

COPY --chown=node:node server.mjs probe.mjs /fixture/

USER 1000:1000
EXPOSE 8080

CMD ["node", "/fixture/server.mjs"]
