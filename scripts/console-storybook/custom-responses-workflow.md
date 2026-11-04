# Review custom Responses creation

Open **Pages / Create Agent / Custom Responses endpoint and manual model**.
These stories use the production Console with simulated API state. Use dummy keys.

1. Enter a dummy Provider API key. Change the endpoint and verify the key and model clear.
2. Enter a manual model ID. Select OpenClaw and inspect Configuration JSON for the custom provider, Responses API, and environment reference without OpenAI metadata.
3. Open **Custom native OpenClaw source-owned endpoint**. Select its existing source. Verify its endpoint is read-only and model limits and costs are required.
4. Inspect **Custom Responses required inputs**, **Custom Responses invalid endpoint**, **No existing custom model sources**, and **Custom model source read refused**.

These stories do not verify provider compatibility, persistence, credential delivery,
or real runtime execution. Real custom-endpoint qualification is explicitly deferred.
