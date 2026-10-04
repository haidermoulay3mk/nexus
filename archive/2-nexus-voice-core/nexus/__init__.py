"""Nexus — the core of a voice-first AI assistant, built tier by tier.

See AGENT.md for what this is and why. The layers:

    config  -> runtime knobs read from config.toml
    llm     -> the provider seam (the only module that imports the Anthropic SDK)
    prompts -> system-prompt assembly (name, personality, purpose)
    agent   -> the brain: the conversation loop

Voice, memory, the heartbeat, and the safety rails arrive in later tiers and wrap
this same core without forking it.
"""

__version__ = "0.1.0"
