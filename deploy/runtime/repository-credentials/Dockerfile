FROM docker.io/library/node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./package.json
COPY dist ./dist
# Runtime code must stay readable when the build host uses a restrictive umask.
RUN chmod -R a=rX /app
USER node
ENTRYPOINT ["node", "/app/dist/repository-credentials.js"]
