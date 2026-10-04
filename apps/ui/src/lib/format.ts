/** 3225 → "3,225" */
export const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-US");

/** 140000 → "140K", 1_100_000 → "1.10M" */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1000)}K`;
  if (abs >= 1_000) return `${(n / 1000).toFixed(1)}K`;
  return fmtInt(n);
}

export function fmtDelta(delta: number | null, unit: string | null): string {
  if (delta === null || delta === 0) return "—";
  const arrow = delta > 0 ? "▲" : "▼";
  return `${arrow} ${fmtCompact(Math.abs(delta))}${unit ?? ""}`;
}

export const fmtClock = (d: Date): { hm: string; s: string; date: string } => ({
  hm: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  s: String(d.getSeconds()).padStart(2, "0"),
  date: d
    .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    .toUpperCase()
    .replace(",", " ·"),
});

/**
 * Markdown → readable plain text for the small result-card preview (the full
 * document keeps its markdown in the vault): drops **, `, # and comments, and
 * turns table rows into "a · b · c".
 */
export function mdPreview(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !/^\s*\|?\s*:?-{3,}/.test(line))
    .map((line) =>
      line.trim().startsWith("|")
        ? line
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((cell) => cell.trim())
            .filter(Boolean)
            .join(" · ")
        : line,
    )
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const fmtAgo = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};
