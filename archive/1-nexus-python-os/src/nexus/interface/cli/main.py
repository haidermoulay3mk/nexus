"""Nexus command-line interface.

Text-first entry point. Study, memory (keyword), and doctor work fully offline;
``ask`` needs Ollama running and degrades with a clear message if it isn't.

Examples:
    nexus doctor
    nexus setup
    nexus study paper Physics 54 75 --paper "Paper 1 2022"
    nexus study weak
    nexus study progress
    nexus ask "what should I revise today?"
"""

from __future__ import annotations

import argparse
import sys

from rich.console import Console
from rich.table import Table

# Windows legacy consoles default to cp1252 and crash on non-ASCII output.
# Force UTF-8 so emoji/box characters render instead of raising.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001 - older/odd streams: best effort
        pass

console = Console()


def _app():
    # Imported lazily so `--help` is instant and import errors are localized.
    from nexus.app import NexusApp

    return NexusApp()


# --- commands -----------------------------------------------------------------

def cmd_doctor(_args) -> int:
    app = _app()
    h = app.doctor()
    table = Table(title="Nexus — system check", show_header=False, box=None)
    table.add_row("Home", h["home"])
    table.add_row("Database", h["db_path"])
    table.add_row("Ollama host", h["host"])
    ok = "[green]reachable[/]" if h["ollama_available"] else "[red]not reachable[/]"
    table.add_row("Ollama", ok)
    table.add_row("Agents", ", ".join(h["agents"]) or "(none)")
    console.print(table)

    mt = Table(title="Model tiers")
    mt.add_column("Tier"); mt.add_column("Model"); mt.add_column("Installed")
    for tier, info in h["tiers"].items():
        flag = "[green]yes[/]" if info["installed"] else "[yellow]missing[/]"
        mt.add_row(tier, info["model"], flag)
    console.print(mt)

    if not h["ollama_available"]:
        console.print("\n[yellow]Ollama isn't running.[/] Install from https://ollama.com, "
                      "then run the models shown above with e.g. "
                      "[bold]ollama pull qwen2.5:3b-instruct[/].")
    return 0


def cmd_setup(_args) -> int:
    app = _app()
    subjects = app.study.seed_default_subjects()
    console.print(f"[green]Seeded subjects:[/] {', '.join(subjects)}")
    h = app.doctor()
    if h["ollama_available"]:
        console.print("[green]Ollama is reachable.[/]")
    else:
        console.print("[yellow]Next:[/] install Ollama and pull a model:")
        console.print("  [bold]ollama pull qwen2.5:3b-instruct[/]  (balanced)")
        console.print("  [bold]ollama pull llama3.2:1b[/]          (fast routing)")
        console.print("  [bold]ollama pull nomic-embed-text[/]     (memory embeddings)")
    console.print("\nTry: [bold]nexus study weak[/] or [bold]nexus ask \"plan my study\"[/]")
    return 0


def cmd_ask(args) -> int:
    app = _app()
    if not app.router.is_ready():
        console.print("[yellow]No model backend ready.[/] Start Ollama, or add a free "
                      "Gemini key (Settings in the app). Run [bold]nexus doctor[/].")
        return 1
    name, answer = app.ask(args.text)
    console.print(f"[dim]({name})[/] {answer}")
    return 0


def cmd_study(args) -> int:
    app = _app()
    s = app.study
    if args.study_cmd == "subjects":
        for row in s.list_subjects():
            console.print(f"- {row['name']} ({row['board']})")
    elif args.study_cmd == "add-subject":
        s.add_subject(args.name, args.board)
        console.print(f"[green]Added[/] {args.name}")
    elif args.study_cmd == "add-topic":
        s.add_topic(args.subject, args.name, chapter=args.chapter, confidence=args.confidence)
        console.print(f"[green]Tracking[/] {args.name} under {args.subject}")
    elif args.study_cmd == "confidence":
        s.set_confidence(args.subject, args.topic, args.level)
        console.print(f"[green]Updated[/] {args.topic} -> {args.level}/5")
    elif args.study_cmd == "paper":
        r = s.log_paper(args.subject, args.score, args.max_score,
                        paper=args.paper, year=args.year, season=args.season)
        console.print(f"[green]Logged[/] {r.subject}: {r.score}/{r.max_score} = {r.percentage}%")
    elif args.study_cmd == "weak":
        rows = s.weak_topics(args.threshold)
        if not rows:
            console.print("No weak topics recorded.")
        for r in rows:
            console.print(f"[red]{r['confidence']}/5[/] {r['subject']}: {r['name']}")
    elif args.study_cmd == "progress":
        prog = s.progress(args.subject)
        table = Table(title="Study progress")
        for col in ("Subject", "Topics", "Done", "Avg conf", "Papers", "Avg %"):
            table.add_column(col)
        for name, p in prog.items():
            table.add_row(name, str(p["topics_total"]), f"{p['completion_pct']}%",
                          str(p["avg_confidence"]), str(p["papers_logged"]),
                          "-" if p["avg_paper_pct"] is None else f"{p['avg_paper_pct']}%")
        console.print(table)
    elif args.study_cmd == "recommend":
        for rec in s.recommendations():
            console.print(f"- {rec}")
    else:
        console.print("Unknown study command. Try: subjects, paper, weak, progress, recommend")
        return 1
    return 0


def cmd_connect(args) -> int:
    if args.service != "google":
        console.print(f"[red]Unknown service:[/] {args.service}")
        return 1
    from nexus.connectors import google_auth
    from nexus.connectors.google_auth import GoogleAuthError

    if not google_auth.is_configured():
        console.print("[red]Missing your Google client secret file.[/]")
        console.print(f"Put it here, named [bold]google_client_secret.json[/]:\n  {google_auth.client_secret_path()}")
        return 1
    console.print("[dim]Opening your browser to sign in... choose the account to connect.[/]")
    try:
        email = google_auth.connect_account()
    except GoogleAuthError as e:
        console.print(f"[red]Couldn't connect:[/] {e}")
        return 1
    accounts = google_auth.list_accounts()
    console.print(f"[green]Connected:[/] {email}")
    console.print(f"Accounts connected: {', '.join(accounts)}")
    console.print("[dim]Run `nexus connect google` again to add another account.[/]")
    return 0


def cmd_email_add(args) -> int:
    import getpass

    from nexus.connectors.simple_accounts import add_email_account

    pw = args.password
    if not pw:
        console.print("[dim]Paste your 16-character Gmail App Password (typing stays hidden):[/]")
        try:
            pw = getpass.getpass("App password: ")
        except Exception:  # noqa: BLE001
            console.print("[red]Couldn't read input here.[/] Use: nexus email-add EMAIL --password \"xxxx xxxx xxxx xxxx\"")
            return 1
    if not pw.strip():
        console.print("[red]No password entered.[/]")
        return 1
    add_email_account(args.email, pw)
    console.print(f"[green]Saved[/] email account: {args.email}")
    console.print("[dim]Test it with:[/] nexus ask \"summarize my inbox\"")
    return 0


def cmd_calendar_add(args) -> int:
    from nexus.connectors.simple_accounts import add_calendar

    add_calendar(args.name, args.url)
    console.print(f"[green]Saved[/] calendar: {args.name}")
    console.print("[dim]Test it with:[/] nexus ask \"what's on my calendar\"")
    return 0


def cmd_connections(_args) -> int:
    from nexus.connectors.simple_accounts import list_calendars, list_email_accounts

    emails = list_email_accounts()
    cals = list_calendars()
    console.print("[bold]Email accounts:[/]")
    for e in emails:
        console.print(f"  - {e}")
    if not emails:
        console.print("  [dim](none - add with: nexus email-add <your-email>)[/]")
    console.print("[bold]Calendars:[/]")
    for c in cals:
        console.print(f"  - {c}")
    if not cals:
        console.print("  [dim](none - add with: nexus calendar-add <name> <link>)[/]")
    return 0


def cmd_accounts(_args) -> int:
    from nexus.connectors import google_auth

    accounts = google_auth.list_accounts()
    if not accounts:
        console.print("No Google accounts connected. Run [bold]nexus connect google[/].")
        return 0
    main = google_auth.main_account()
    for a in accounts:
        tag = " [dim](main)[/]" if a == main else ""
        console.print(f"- {a}{tag}")
    return 0


def cmd_voice(args) -> int:
    from nexus.speech.interfaces import VoiceUnavailable

    app = _app()
    try:
        from nexus.speech.runtime import run
    except ImportError:
        console.print("[yellow]Voice module unavailable.[/]")
        return 1
    hint = "press your hotkey" if args.mode == "hotkey" else "say a wake phrase"
    console.print(f"[green]Voice ready[/] (mode: {args.mode}). When prompted, {hint}. Ctrl+C to stop.")
    try:
        run(app, mode=args.mode)
    except VoiceUnavailable as e:
        console.print(f"[yellow]Voice needs extra parts:[/] {e}")
        console.print("Install with: [bold]pip install -e .[voice][/]")
        return 1
    except KeyboardInterrupt:
        console.print("\n[dim]Voice stopped.[/]")
    return 0


def cmd_desktop(_args) -> int:
    try:
        from nexus.interface.desktop.app import run
    except ImportError:
        console.print("[yellow]Desktop window needs pywebview.[/] Run: pip install pywebview")
        return 1
    run()
    return 0


def cmd_dashboard(args) -> int:
    try:
        from nexus.interface.api.server import serve
    except ImportError:
        console.print("[yellow]Web extra not installed.[/] Run: pip install -e .[web]")
        return 1
    console.print(f"[green]Nexus dashboard[/] -> http://{args.host}:{args.port}")
    serve(host=args.host, port=args.port)
    return 0


def cmd_digest(_args) -> int:
    from nexus.scheduler.digest import build_digest

    app = _app()
    console.print("[bold]Nexus daily digest[/]\n")
    console.print(build_digest(app))
    return 0


def cmd_scheduler(args) -> int:
    import time

    from nexus.scheduler.runner import SchedulerService

    app = _app()
    svc = SchedulerService(app)
    jobs = svc.configure()
    console.print(f"[green]Scheduler configured[/] with jobs: {', '.join(jobs)}")
    if args.scheduler_cmd != "start":
        return 0
    svc.start()
    console.print("Scheduler running. Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        svc.shutdown()
        console.print("\n[dim]Scheduler stopped.[/]")
    return 0


def cmd_task(args) -> int:
    p = _app().productivity
    if args.task_cmd == "add":
        tid = p.add_task(args.title, due=args.due or None, priority=args.priority, project=args.project)
        console.print(f"[green]Added task #{tid}[/]")
    elif args.task_cmd == "list":
        tasks = p.list_tasks(args.status)
        if not tasks:
            console.print(f"No {args.status} tasks.")
        for t in tasks:
            due = f" (due {t.due_date})" if t.due_date else ""
            console.print(f"#{t.id} P{t.priority} {t.title}{due}")
    elif args.task_cmd == "done":
        ok = p.complete_task(args.id)
        console.print("[green]Done.[/]" if ok else f"No open task #{args.id}.")
    else:
        console.print("Task commands: add, list, done")
        return 1
    return 0


def cmd_goal(args) -> int:
    p = _app().productivity
    if args.goal_cmd == "add":
        gid = p.add_goal(args.title, description=args.description, target_date=args.target_date or None)
        console.print(f"[green]Added goal #{gid}[/]")
    elif args.goal_cmd == "list":
        goals = p.list_goals("active")
        if not goals:
            console.print("No active goals.")
        for g in goals:
            by = f" (by {g['target_date']})" if g["target_date"] else ""
            console.print(f"#{g['id']} {g['title']} - {g['progress']}%{by}")
    elif args.goal_cmd == "progress":
        val = p.update_goal_progress(args.id, args.percent)
        console.print(f"[green]Goal #{args.id} -> {val}%[/]")
    else:
        console.print("Goal commands: add, list, progress")
        return 1
    return 0


def cmd_reminders(args) -> int:
    app = _app()
    if args.check:
        from nexus.scheduler.reminders import run_reminder_check

        new = run_reminder_check(app)
        console.print(f"[dim]Checked calendar; {len(new)} new reminder(s).[/]")
    pending = app.memory.get(namespace="reminders", limit=20)
    if not pending:
        console.print("No reminders.")
    for r in pending:
        console.print(f"- {r.content}")
    return 0


def cmd_remember(args) -> int:
    app = _app()
    app.memory.store(args.text, title=args.title or "", namespace="knowledge")
    console.print("[green]Remembered.[/]")
    return 0


def cmd_backup(_args) -> int:
    from nexus.maintenance import backup_database, prune_backups

    dest = backup_database()
    removed = prune_backups(keep=10)
    console.print(f"[green]Backed up[/] to {dest}")
    if removed:
        console.print(f"[dim]Pruned {removed} old backup(s).[/]")
    return 0


def cmd_recall(args) -> int:
    app = _app()
    hits = app.memory.search(args.query, k=5)
    if not hits:
        console.print("Nothing relevant found.")
        return 0
    for rec, score in hits:
        tag = f"[dim]{score:.2f}[/] " if score else ""
        console.print(f"{tag}{rec.title or '(untitled)'}: {rec.content}")
    return 0


# --- parser -------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="nexus", description="Nexus — personal AI operating system")
    sub = p.add_subparsers(dest="command")

    sub.add_parser("doctor", help="check Ollama, models, and storage").set_defaults(func=cmd_doctor)
    sub.add_parser("setup", help="seed subjects and show setup steps").set_defaults(func=cmd_setup)

    ask = sub.add_parser("ask", help="ask Nexus anything (routes to an agent)")
    ask.add_argument("text")
    ask.set_defaults(func=cmd_ask)

    study = sub.add_parser("study", help="A-Level study tracking")
    ssub = study.add_subparsers(dest="study_cmd")
    ssub.add_parser("subjects")
    a = ssub.add_parser("add-subject"); a.add_argument("name"); a.add_argument("--board", default="A-Level")
    a = ssub.add_parser("add-topic")
    a.add_argument("subject"); a.add_argument("name")
    a.add_argument("--chapter", default=""); a.add_argument("--confidence", type=int, default=0)
    a = ssub.add_parser("confidence")
    a.add_argument("subject"); a.add_argument("topic"); a.add_argument("level", type=int)
    a = ssub.add_parser("paper")
    a.add_argument("subject"); a.add_argument("score", type=float)
    a.add_argument("max_score", type=float, nargs="?", default=100.0)
    a.add_argument("--paper", default=""); a.add_argument("--year", type=int, default=0)
    a.add_argument("--season", default="")
    a = ssub.add_parser("weak"); a.add_argument("--threshold", type=int, default=2)
    a = ssub.add_parser("progress"); a.add_argument("subject", nargs="?", default="")
    ssub.add_parser("recommend")
    study.set_defaults(func=cmd_study)

    task = sub.add_parser("task", help="tasks / to-dos")
    tsub = task.add_subparsers(dest="task_cmd")
    ta = tsub.add_parser("add"); ta.add_argument("title")
    ta.add_argument("--due", default=""); ta.add_argument("--priority", type=int, default=2)
    ta.add_argument("--project", default="")
    tl = tsub.add_parser("list"); tl.add_argument("--status", default="open")
    td = tsub.add_parser("done"); td.add_argument("id", type=int)
    task.set_defaults(func=cmd_task)

    goal = sub.add_parser("goal", help="longer-term goals")
    gsub = goal.add_subparsers(dest="goal_cmd")
    ga = gsub.add_parser("add"); ga.add_argument("title")
    ga.add_argument("--description", default=""); ga.add_argument("--target-date", dest="target_date", default="")
    gsub.add_parser("list")
    gp = gsub.add_parser("progress"); gp.add_argument("id", type=int); gp.add_argument("percent", type=int)
    goal.set_defaults(func=cmd_goal)

    rmd = sub.add_parser("reminders", help="show calendar reminders")
    rmd.add_argument("--check", action="store_true", help="scan the calendar now")
    rmd.set_defaults(func=cmd_reminders)

    sub.add_parser("desktop", help="open Nexus in its own native window").set_defaults(func=cmd_desktop)

    voice = sub.add_parser("voice", help="talk to Nexus (needs the voice extra)")
    voice.add_argument("--mode", choices=["hotkey", "wake"], default="hotkey")
    voice.set_defaults(func=cmd_voice)

    dash = sub.add_parser("dashboard", help="run the local web dashboard")
    dash.add_argument("--host", default="127.0.0.1"); dash.add_argument("--port", type=int, default=8765)
    dash.set_defaults(func=cmd_dashboard)

    sub.add_parser("digest", help="build today's briefing now").set_defaults(func=cmd_digest)

    sched = sub.add_parser("scheduler", help="configure/start the background scheduler")
    sched.add_argument("scheduler_cmd", choices=["configure", "start"], nargs="?", default="configure")
    sched.set_defaults(func=cmd_scheduler)

    conn = sub.add_parser("connect", help="connect an external service (google); run once per account")
    conn.add_argument("service", choices=["google"])
    conn.set_defaults(func=cmd_connect)

    sub.add_parser("accounts", help="list connected Google accounts (OAuth path)").set_defaults(func=cmd_accounts)

    em = sub.add_parser("email-add", help="connect a Gmail account via App Password")
    em.add_argument("email"); em.add_argument("--password", default="")
    em.set_defaults(func=cmd_email_add)

    ca = sub.add_parser("calendar-add", help="connect a calendar via its private iCal link")
    ca.add_argument("name"); ca.add_argument("url")
    ca.set_defaults(func=cmd_calendar_add)

    sub.add_parser("connections", help="list connected emails and calendars").set_defaults(func=cmd_connections)

    rem = sub.add_parser("remember", help="save a note to memory")
    rem.add_argument("text"); rem.add_argument("--title", default="")
    rem.set_defaults(func=cmd_remember)

    rec = sub.add_parser("recall", help="search your memory")
    rec.add_argument("query")
    rec.set_defaults(func=cmd_recall)

    sub.add_parser("backup", help="back up the database").set_defaults(func=cmd_backup)

    return p


def main(argv: list[str] | None = None) -> int:
    from nexus.kernel.logging_setup import setup_logging

    setup_logging()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 0
    # study with no subcommand
    if args.command == "study" and not getattr(args, "study_cmd", None):
        console.print("Study commands: subjects, add-subject, add-topic, confidence, "
                      "paper, weak, progress, recommend")
        return 0
    try:
        return args.func(args)
    except KeyError as e:
        console.print(f"[red]Error:[/] {e}")
        return 1
    except Exception as e:  # noqa: BLE001 - friendly CLI errors
        console.print(f"[red]Unexpected error:[/] {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
