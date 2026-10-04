"""External service connectors (Gmail, Google Calendar).

These are the deliberate "cloud when necessary" exception to Nexus's local-first
design: reasoning and storage stay on-device, but reading email and editing your
calendar necessarily talk to Google over the network, with your OAuth consent.

Google client libraries are an optional dependency (``pip install -e .[google]``)
and are imported lazily so the rest of Nexus runs without them.
"""
