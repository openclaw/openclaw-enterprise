FROM docker.io/library/node:24-bookworm-slim

COPY --chown=node:node server.mjs probe.mjs /fixture/
COPY --chown=node:node openclaw.mjs /app/openclaw.mjs

USER 1000:1000
EXPOSE 8080

CMD ["node", "/fixture/server.mjs"]
