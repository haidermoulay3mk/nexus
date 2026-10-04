/**
 * A tiny in-process mock of the Ollama daemon: OpenAI-compatible streaming
 * chat + native /api/tags and /api/embed. Lets every test run fully
 * offline while exercising the real streaming code path.
 */

export interface MockOllama {
  url: string;
  requests: Array<{ path: string; body: unknown }>;
  stop(): void;
}

function sseChunk(content: string): string {
  return `data: ${JSON.stringify({
    id: "mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

/**
 * Deterministic bag-of-words embedding: each word hashes to a stable
 * dimension, so texts sharing words are cosine-close — good enough to
 * exercise real retrieval ranking offline.
 */
export function fakeEmbedding(text: string): number[] {
  const v = new Array(768).fill(0);
  for (const word of text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    let hash = 5381;
    for (let i = 0; i < word.length; i++) hash = (hash * 33 + word.charCodeAt(i)) >>> 0;
    v[hash % 768] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function startMockOllama(reply = "MOCK REPORT\n\nAll systems nominal."): MockOllama {
  const requests: Array<{ path: string; body: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      requests.push({ path: url.pathname, body });

      if (url.pathname === "/api/tags") {
        return Response.json({
          models: [
            { name: "qwen2.5:7b-instruct-q4_K_M" },
            { name: "llama3.2:3b" },
            { name: "nomic-embed-text:latest" },
          ],
        });
      }
      if (url.pathname === "/api/embed") {
        const input = (body as { input: string[] }).input;
        return Response.json({ embeddings: input.map((t) => fakeEmbedding(t)) });
      }
      if (url.pathname === "/v1/chat/completions") {
        const words = reply.split(" ");
        const stream = new ReadableStream({
          start(controller) {
            for (const w of words) controller.enqueue(sseChunk(`${w} `));
            controller.enqueue(
              `data: ${JSON.stringify({
                id: "mock",
                object: "chat.completion.chunk",
                created: 0,
                model: "mock",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: {
                  prompt_tokens: 20,
                  completion_tokens: words.length,
                  total_tokens: 20 + words.length,
                },
              })}\n\n`,
            );
            controller.enqueue("data: [DONE]\n\n");
            controller.close();
          },
        });
        return new Response(stream.pipeThrough(new TextEncoderStream()), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}
