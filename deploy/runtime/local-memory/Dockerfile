# Optional offline memory image. Build both input images from the same canonical
# runtime Dockerfile/source pin. The context contains the two verified artifacts
# documented in the runtime guide, not a checkout or any credentials.
ARG OPENCLAW_BUILD_IMAGE
ARG OCE_RUNTIME_IMAGE
ARG NODE_BASE_IMAGE=docker.io/library/node:24-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0

FROM ${OPENCLAW_BUILD_IMAGE} AS plugin
WORKDIR /source
# Use upstream's package builder and publication manifest overlay. npm pack is
# offline and does not publish or run package lifecycle scripts.
RUN --network=none node --import ./scripts/tsx.mjs scripts/lib/plugin-npm-runtime-build.mts extensions/llama-cpp \
    && mkdir -p /out/plugin \
    && node --import ./scripts/tsx.mjs scripts/lib/plugin-npm-package-manifest.mts \
      --run extensions/llama-cpp -- npm pack --offline --ignore-scripts --pack-destination /out \
    && tar -xzf /out/openclaw-llama-cpp-provider-*.tgz -C /out/plugin --strip-components=1 \
    && cp LICENSE /out/plugin/LICENSE \
    && node -e 'if (!/^[a-f0-9]{40}$/.test(process.env.GIT_COMMIT ?? "")) throw new Error("Missing source identity"); require("node:fs").writeFileSync("/out/plugin/.source-commit", process.env.GIT_COMMIT);'

FROM ${NODE_BASE_IMAGE} AS llama-build
RUN apt-get update && apt-get install -y --no-install-recommends cmake g++ make \
    && rm -rf /var/lib/apt/lists/*
COPY llama.cpp-5266f24.tar.gz /tmp/llama.cpp.tar.gz
RUN echo '2de0d87eda4696e9f6bbd771d4c623267f4e95856cce6f99793f91522f993e43  /tmp/llama.cpp.tar.gz' | sha256sum --check --strict \
    && mkdir /source \
    && tar -xzf /tmp/llama.cpp.tar.gz -C /source --strip-components=1 \
    && cmake -S /source -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON \
      -DLLAMA_BUILD_APP=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF \
      -DLLAMA_OPENSSL=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
      -DLLAMA_BUILD_NUMBER=10809 -DLLAMA_BUILD_COMMIT=5266f24da75dc449bd56cbed7addb9c8e4a6a73e \
    && cmake --build /build --target llama-server --parallel 4 \
    && strip /build/bin/llama-server

FROM ${OCE_RUNTIME_IMAGE} AS runtime
USER root
COPY --from=plugin /out/plugin/ /app/node_modules/openclaw/local-plugins/llama-cpp/
COPY --from=llama-build /build/bin/llama-server /opt/oce/local-memory/bin/llama-server
COPY --from=llama-build /source/LICENSE /opt/oce/local-memory/licenses/llama.cpp.txt
COPY embeddinggemma-300m-qat-Q8_0.gguf /opt/oce/local-memory/models/embeddinggemma-300m-qat-Q8_0.gguf
RUN echo '6fa0c02a9c302be6f977521d399b4de3a46310a4f2621ee0063747881b673f67  /opt/oce/local-memory/models/embeddinggemma-300m-qat-Q8_0.gguf' | sha256sum --check --strict \
    && chmod -R a+rX /opt/oce/local-memory /app/node_modules/openclaw/local-plugins \
    && /opt/oce/local-memory/bin/llama-server --version \
    && node --input-type=module -e 'import {createRequire} from "node:module"; const require=createRequire("/app/node_modules/openclaw/local-plugins/llama-cpp/package.json"); if(require("@openclaw/fs-safe/package.json").version!=="0.24.2") throw new Error("Unexpected llama.cpp plugin dependency"); await import("/app/node_modules/openclaw/local-plugins/llama-cpp/dist/index.js");'
RUN --network=none node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const source = readFileSync("/app/node_modules/openclaw/local-plugins/llama-cpp/.source-commit", "utf8");
const runtime = JSON.parse(readFileSync("/opt/oce/runtime/provenance.json", "utf8"));
if (source !== runtime.commit) throw new Error("Plugin and runtime source pins differ");
writeFileSync("/opt/oce/local-memory/provenance.json", JSON.stringify({
  openclawCommit: source,
  plugin: "@openclaw/llama-cpp-provider",
  llamaCppCommit: "5266f24da75dc449bd56cbed7addb9c8e4a6a73e",
  llamaServerSha256: createHash("sha256").update(readFileSync("/opt/oce/local-memory/bin/llama-server")).digest("hex"),
  modelRevision: "66f974f8cd48cc3b9c41c516b95508e75b4bee64",
  modelSha256: "6fa0c02a9c302be6f977521d399b4de3a46310a4f2621ee0063747881b673f67"
}, null, 2) + "\n");
NODE
USER node
