"""Embedding helper used by the memory layer.

Embeddings come from Ollama (default: ``nomic-embed-text``), which is what lets
Nexus avoid PyTorch/sentence-transformers entirely and stay 3.12–3.14 friendly.
"""

from __future__ import annotations

from nexus.kernel.config import NexusConfig, get_config
from nexus.models.ollama_client import OllamaClient


class Embedder:
    def __init__(self, config: NexusConfig | None = None, client: OllamaClient | None = None) -> None:
        self.config = config or get_config()
        self.client = client or OllamaClient(
            host=self.config.models.ollama_host,
            timeout_s=self.config.models.request_timeout_s,
        )
        self.model = self.config.models.embed_model

    def embed(self, text: str) -> list[float]:
        return self.client.embed(self.model, text)

    def __call__(self, text: str) -> list[float]:
        return self.embed(text)
