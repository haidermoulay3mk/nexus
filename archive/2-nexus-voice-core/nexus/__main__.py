"""Entry point. `python -m nexus` (or the `nexus` console script).

The default is the unified interface: one window where you type a line OR hold the talk key
to speak, with replies printed and spoken. It degrades to plain text automatically if the
voice libraries or a microphone aren't available. `--text` forces the simple typed-only loop
(handy for debugging); `--heartbeat` runs only the proactive loop (for an always-on host).
"""

from __future__ import annotations

import argparse
import sys

from .config import load_config


def main() -> int:
    parser = argparse.ArgumentParser(prog="nexus", description="Nexus - voice-first AI assistant.")
    parser.add_argument(
        "--text",
        action="store_true",
        help="Typed-only interface (no voice). Useful for debugging.",
    )
    parser.add_argument(
        "--voice",
        action="store_true",
        help="Alias for the default unified interface (type or hold the talk key to speak).",
    )
    parser.add_argument(
        "--heartbeat",
        action="store_true",
        help="Run only the proactive heartbeat loop (no chat); e.g. on an always-on host.",
    )
    parser.add_argument(
        "--mic-test",
        action="store_true",
        help="Hands-free hearing check: calibrate, then print what the mic hears. No brain, no voice.",
    )
    args = parser.parse_args()

    config = load_config()

    if args.heartbeat:
        from .heartbeat import main as heartbeat_main
        return heartbeat_main()

    if args.mic_test:
        from .shell import run_mic_test
        run_mic_test(config)
        return 0

    if args.text:
        from .agent import run_text_repl
        run_text_repl(config)
        return 0

    # Default (and --voice): the unified type-or-talk interface.
    from .shell import run
    run(config)
    return 0


if __name__ == "__main__":
    sys.exit(main())
