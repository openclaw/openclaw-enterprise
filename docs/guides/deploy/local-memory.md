# Run semantic memory without Gateway internet access

OpenClaw's native `local` embedding provider can generate memory vectors inside
the Gateway Pod. Memory files remain on the remote Harness workspace PVC; the
Gateway retains the derived index on its private state PVC. This preserves the
[remote Harness topology](../topics/remote-harness.md) and the dedicated
Gateway's existing NetworkPolicies.

This optional image recipe is under local qualification. It does not change the
default published OCE image. It adds the unmodified native llama.cpp provider,
a CPU llama-server built for the runtime's Debian base, and the embedding model
pinned by the selected OpenClaw source. Runtime inference needs no embedding
credential, model download or external endpoint. Chat inference still uses the
Agent's separately configured Harness and model credential.

## Build the optional image

Build the `openclaw-build` and `runtime` targets in `deploy/runtime/Dockerfile`
from the same checkout and source pin. Retain their immutable image IDs for the
two build arguments below. Use the existing protected dependency registry setup.

Prepare an artifact directory with these files:

| Filename                            | Source                                                                                                                                                                              | SHA-256                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `llama.cpp-5266f24.tar.gz`          | [llama.cpp 5266f24](https://codeload.github.com/ggml-org/llama.cpp/tar.gz/5266f24da75dc449bd56cbed7addb9c8e4a6a73e)                                                                 | `2de0d87eda4696e9f6bbd771d4c623267f4e95856cce6f99793f91522f993e43` |
| `embeddinggemma-300m-qat-Q8_0.gguf` | [Pinned EmbeddingGemma model](https://huggingface.co/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/66f974f8cd48cc3b9c41c516b95508e75b4bee64/embeddinggemma-300m-qat-Q8_0.gguf) | `6fa0c02a9c302be6f977521d399b4de3a46310a4f2621ee0063747881b673f67` |

The model is approximately 314 MiB and uses the upstream Gemma license. Preserve
its [model card and licensing information](https://huggingface.co/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/blob/66f974f8cd48cc3b9c41c516b95508e75b4bee64/README.md)
when preparing a distribution.

From the repository root, build with the artifact directory as context:

```sh
docker buildx build --load \
  -f deploy/runtime/local-memory/Dockerfile \
  --build-arg OPENCLAW_BUILD_IMAGE="$OPENCLAW_BUILD_IMAGE" \
  --build-arg OCE_RUNTIME_IMAGE="$OCE_RUNTIME_IMAGE" \
  -t oce-runtime:local-memory "$LOCAL_MEMORY_ARTIFACTS"
```

The build verifies both artifact hashes. It uses upstream's standalone plugin
packager offline and validates the installed provider import. Select the image
through the Installation's ordinary runtime-image configuration before deploying
Agents that use it. The image retains the base runtime's source and patch
provenance. See [local image upgrades](local-k3d-image-upgrade.md).

## Configure the native provider

Merge these fields into the Agent's native Configuration, preserving its chat
models, enabled plugins and existing load paths:

```json
{
  "plugins": {
    "allow": ["llama-cpp"],
    "entries": { "llama-cpp": { "enabled": true } },
    "load": { "paths": ["/app/node_modules/openclaw/local-plugins/llama-cpp"] }
  },
  "models": {
    "providers": {
      "llama-cpp": {
        "baseUrl": "http://127.0.0.1:19432/v1",
        "api": "openai-completions",
        "models": [],
        "localService": {
          "command": "/opt/oce/local-memory/bin/llama-server",
          "args": [
            "--model",
            "/opt/oce/local-memory/models/embeddinggemma-300m-qat-Q8_0.gguf",
            "--alias",
            "embeddinggemma-300m-qat-q8_0",
            "--host",
            "127.0.0.1",
            "--port",
            "19432",
            "--embedding",
            "--ctx-size",
            "2048",
            "--batch-size",
            "2048",
            "--ubatch-size",
            "2048",
            "--parallel",
            "1",
            "--threads",
            "2",
            "--no-ui",
            "--metrics"
          ],
          "healthUrl": "http://127.0.0.1:19432/health",
          "readyTimeoutMs": 60000,
          "idleStopMs": 600000
        }
      }
    }
  },
  "memory": {
    "search": {
      "provider": "local",
      "fallback": "none",
      "local": {
        "modelPath": "/opt/oce/local-memory/models/embeddinggemma-300m-qat-Q8_0.gguf"
      },
      "store": { "vector": { "enabled": true } }
    }
  }
}
```

`openai-completions` names the server's local protocol; it does not route to
OpenAI. The empty model catalog avoids changing the Agent's chat model. Do not
add an API key for this local service. OpenClaw starts it on loopback, checks its
health and owns its idle shutdown. The server shares the Gateway's existing CPU
and memory limits; size those limits against measured indexing workloads.

Deploy through the normal Agent API. When switching an existing index from
keyword-only to vectors, use the candidate runtime's admin maintenance operation:

```sh
openclaw gateway call memory.index --params '{"agentId":"main"}' --timeout 180000
```

This operation requires `operator.admin` and indexes through the live Gateway's
remote workspace binding. The runtime rechecks the caller before provider requests,
retries and index publication; disconnect cancels inline provider calls. A batch
already submitted to an external provider cannot be recalled. Status reads run
in the database worker, not on the Gateway event loop.

The standalone local-filesystem memory CLI cannot
rebuild an index whose source files live on the Harness. Check vector availability
and actual `memory_search` results before considering the provider qualified.
The [native QA scenario](../../testing/ci.md#qa-matrix) also checks a keyword
negative control, synonym retrieval, authority refusal and storage lifecycle.
