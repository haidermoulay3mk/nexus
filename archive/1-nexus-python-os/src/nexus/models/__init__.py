"""Model layer: everything that talks to Ollama.

All generation and embedding flows through here so models can be swapped via
config (or a future GPU/cloud tier) without touching agents or memory.
"""
