"""Domain logic: structured, testable repositories for each life area.

Domain modules own their own SQLite tables (created idempotently) so the core
schema stays small and new domains can be added without touching the kernel.
"""
