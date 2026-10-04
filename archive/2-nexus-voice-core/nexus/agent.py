"""The brain: the conversation loop.

`Conversation.respond()` is the single entry point every kind of turn flows through — a
typed turn now, a spoken turn in Tier 3, a heartbeat-initiated turn in Tier 5. Build the
core once here; voice and proactivity are adapters on its edges, never a second copy of
this logic.
"""

from __future__ import annotations

import sys
import unicodedata
from dataclasses import dataclass, field

from . import audit
from . import heartbeat
from . import inbox
from . import killswitch
from . import llm
from . import memory
from . import safety
from . import tools as toolkit
from .config import Config, load_config
from .prompts import build_system_prompt

# Safety valve so a confused model can't loop on tools forever.
MAX_TOOL_ITERATIONS = 6


@dataclass
class Conversation:
    """In-session memory (short-term) plus the system prompt. One per running session.

    The running list of turns is the short-term memory; it lives only as long as the
    process. Durable, cross-restart memory arrives in Tier 4.
    """

    config: Config
    system: str
    history: list[dict] = field(default_factory=list)
    # How the safety gate asks before a consequential tool runs. Defaults to the safe
    # deny-all; the text REPL swaps in an interactive y/N prompt.
    confirmer: safety.Confirmer = safety.deny_all

    @classmethod
    def start(cls, config: Config) -> "Conversation":
        # Load durable memory fresh each session, so a fact saved (or hand-edited) last
        # time is known this time.
        facts = memory.load_facts()
        return cls(config=config, system=build_system_prompt(config, facts))

    def respond(self, user_text: str, on_text=None) -> llm.LLMResult:
        """Take one turn of input, think, run any tools the model calls, and return the reply.

        The manual agentic loop: send the conversation (plus the tool registry); if the
        model asks for tools, run them, feed the results back, and let it continue — it may
        call several tools across several rounds before it's ready to answer. Raises
        llm.LLMError on a backend failure; the caller surfaces it (the text loop prints it
        and reprompts).
        """
        self.history.append({"role": "user", "content": user_text})
        available = toolkit.all_tools()

        result = None
        for _ in range(MAX_TOOL_ITERATIONS):
            result = llm.stream(
                config=self.config,
                system=self.system,
                messages=self.history,
                tools=available,
                on_text=on_text,
            )
            audit.record_usage(result.input_tokens, result.output_tokens)
            self.history.append(result.assistant_message)

            if not result.tool_calls:
                break

            outcomes = [self._run_one_tool(call) for call in result.tool_calls]
            self.history.extend(llm.format_tool_results(self.config, outcomes))

        # Never leave the user with silence — e.g. when the model kept reaching for a
        # capability that doesn't exist yet and produced no words.
        if result is None or not result.text.strip():
            fallback = ("Sorry, I couldn't work that one out just now. I can take reminders "
                        "and remember things for you — calendar and email aren't set up yet.")
            if on_text is not None:
                on_text(fallback)
            if result is None:
                result = llm.LLMResult(
                    text=fallback,
                    assistant_message={"role": "assistant", "content": fallback},
                )
            else:
                result.text = fallback
        return result

    def _run_one_tool(self, call: llm.ToolCall) -> tuple:
        """Run a single tool call — through the confirmation gate if it's consequential."""
        tool = toolkit.get(call.name)
        if tool is not None and safety.needs_confirmation(tool, self.config):
            desc = safety.describe(tool, call.arguments)
            if not self.confirmer(desc):
                audit.log("tool_declined", desc, tool=call.name)
                # The model gets a plain note and can respond; the action never ran.
                return (call, "The user declined this action, so it was not performed.", False)
            audit.log("tool_confirmed", desc, tool=call.name)

        output, is_error = toolkit.dispatch(call.name, call.arguments)
        audit.log("tool_error" if is_error else "tool_run", call.name, args=call.arguments)
        return (call, output, is_error)


_THINKING = "Nexus: (thinking...)"


def _streaming_printer():
    """Print a 'thinking' indicator immediately, then stream the reply over it.

    The indicator appears the instant the user hits enter, so the brief adaptive-thinking
    pause never reads as 'it broke'. On the first chunk it's wiped and the reply streams in
    under a clean 'Nexus:' label. Returns (on_text, finish); call finish() exactly once when
    the turn ends — it either terminates the line (if text streamed) or erases the indicator
    (if the turn failed before any text).
    """
    sys.stdout.write(_THINKING)
    sys.stdout.flush()
    state = {"started": False}

    def on_text(chunk: str) -> None:
        if not state["started"]:
            sys.stdout.write("\r" + " " * len(_THINKING) + "\rNexus: ")
            state["started"] = True
        sys.stdout.write(chunk)
        sys.stdout.flush()

    def finish() -> None:
        if state["started"]:
            sys.stdout.write("\n")
        else:
            sys.stdout.write("\r" + " " * len(_THINKING) + "\r")
        sys.stdout.flush()

    return on_text, finish


_HELP = """\
Commands:
  /help            show this
  /inbox           show notices the heartbeat is holding for you
  /dismiss <n>     clear inbox item n  (/dismiss all clears everything)
  /pause           kill switch: pause all proactive behavior (you can still talk)
  /resume          resume proactive behavior
  /usage           show the running token tally
  /exit, /quit     leave
Just type to talk to Nexus. (Voice arrives in Tier 3 — the typed path stays forever.)"""


def _show_new_interrupts() -> None:
    """Catch-up-on-return: surface interrupt notices the heartbeat held while we were away
    or busy — once each, never nagging."""
    items = inbox.new_unshown("interrupt")
    if not items:
        return
    print()
    for it in items:
        print(f"Nexus (heads up): {it['text']}")
    inbox.mark_shown([it["id"] for it in items])
    print("  (/inbox to manage, /dismiss <n> to clear)")


def _show_inbox() -> None:
    items = inbox.pending()
    if not items:
        print("Inbox is empty.")
        return
    for i, it in enumerate(items, 1):
        print(f"  {i}. [{it['level']}] {it['text']}")
    print("  (/dismiss <n> to clear one, /dismiss all to clear everything)")


def _dismiss(arg: str) -> None:
    items = inbox.pending()
    arg = arg.strip()
    if arg == "all":
        print(f"Dismissed {inbox.dismiss_all()} item(s).")
        return
    try:
        idx = int(arg)
    except ValueError:
        print("Usage: /dismiss <number>  (or /dismiss all)")
        return
    if 1 <= idx <= len(items):
        inbox.dismiss(items[idx - 1]["id"])
        print("Dismissed.")
    else:
        print("No inbox item with that number.")


def _ensure_utf8_console() -> None:
    """On Windows the console codepage is often cp1252; the model emits Unicode (em-dashes,
    smart quotes) and input may arrive UTF-8 (incl. a BOM). Force UTF-8 on stdin/stdout/stderr
    so replies don't turn into mojibake and typed/piped input decodes correctly."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


def run_text_repl(config: Config | None = None) -> None:
    """The Tier 1 text interface: type a message, get a streamed reply that remembers."""
    _ensure_utf8_console()
    config = config or load_config()
    convo = Conversation.start(config)
    convo.confirmer = safety.interactive_confirmer()  # the gate asks via a y/N prompt

    print(f"{config.name} — {config.tagline}")
    print("Type /help for commands, /exit to leave.")
    if killswitch.is_paused():
        print("(proactive behavior is paused — /resume to re-enable)")

    # The heartbeat runs alongside the conversation, filling the inbox in the background.
    hb_stop = None
    if config.heartbeat_enabled:
        _thread, hb_stop = heartbeat.start_background(config)

    _show_new_interrupts()  # catch up on anything held while we were away
    print()

    try:
        while True:
            try:
                raw = input("you: ")
                # Drop invisible format chars (e.g. a stray BOM from piped input) before matching.
                user = "".join(c for c in raw if unicodedata.category(c) != "Cf").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nGoodbye.")
                return

            if not user:
                continue
            if user in ("/exit", "/quit"):
                print("Goodbye.")
                return
            if user == "/help":
                print(_HELP)
                continue
            if user == "/inbox":
                _show_inbox()
                continue
            if user.startswith("/dismiss"):
                _dismiss(user[len("/dismiss"):])
                continue
            if user == "/pause":
                killswitch.pause()
                print("Proactive behavior paused. You can still talk to me. (/resume to re-enable)")
                continue
            if user == "/resume":
                killswitch.resume()
                print("Proactive behavior resumed.")
                continue
            if user == "/usage":
                t = audit.totals()
                print(f"  {t.get('turns', 0)} turns — "
                      f"{t.get('input_tokens', 0)} in / {t.get('output_tokens', 0)} out tokens "
                      f"(local model: $0.00)")
                continue

            on_text, finish = _streaming_printer()
            try:
                convo.respond(user, on_text=on_text)
                finish()
            except llm.LLMError as err:
                # No stack trace, clean reprompt — a daily driver shrugs off provider hiccups.
                finish()
                print(f"Nexus: {err}")
            except KeyboardInterrupt:
                finish()
                print("(interrupted)")

            _show_new_interrupts()  # surface anything the heartbeat noticed this turn
    finally:
        if hb_stop is not None:
            hb_stop.set()
