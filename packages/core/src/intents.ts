/**
 * Canonical intent keys for the COMMAND DECK.
 * Each intent is registered by a first-party plugin; these constants keep
 * the deck layout, scheduler, and tests in sync.
 */
export const INTENT = {
  METRICS_PULL: "metrics.pull",
  AM_REPORT: "report.morning",
  INBOX_BRIEF: "inbox.brief",
  GH_TRENDING: "intel.gh-trending",
  TREND_SCAN: "intel.trend-scan",
  YT_WEEK: "intel.yt-week",
  PLAN_TODAY: "plan.today",
  PLAN_TMRW: "plan.tomorrow",
  WK_REVIEW: "review.week",
  VAULT_CLEAN: "system.vault-clean",
  /* Life-tracking suite (v0.2) */
  ACADEMICS_BOARD: "academics.board",
  ACADEMICS_REVISE: "academics.revise",
  ACADEMICS_CMD: "academics.command",
  SCHOLAR_SWEEP: "scholarships.sweep",
  SCHOLAR_CMD: "scholarships.command",
  COURSE_CHECK: "courses.check",
  COURSE_CMD: "courses.command",
  AGENCY_BOARD: "agency.board",
  AGENCY_CMD: "agency.command",
  EMAIL_DRAFT: "email.draft",
  CAL_REMIND: "calendar.remind",
  SYS_AUDIT: "system.audit",
  /* Brain (v0.3) */
  BRAIN_CMD: "brain.command",
  BRAIN_EXTRACT: "brain.extract",
  /** free-form voice / palette command routed by the Planner */
  COMMAND: "nexus.command",
} as const;

export type IntentKey = (typeof INTENT)[keyof typeof INTENT];

/** Display order on the COMMAND DECK (two columns, top-to-bottom). */
export const DECK_ORDER: IntentKey[] = [
  INTENT.ACADEMICS_BOARD,
  INTENT.ACADEMICS_REVISE,
  INTENT.SCHOLAR_SWEEP,
  INTENT.COURSE_CHECK,
  INTENT.AGENCY_BOARD,
  INTENT.SYS_AUDIT,
  INTENT.METRICS_PULL,
  INTENT.AM_REPORT,
  INTENT.INBOX_BRIEF,
  INTENT.GH_TRENDING,
  INTENT.TREND_SCAN,
  INTENT.YT_WEEK,
  INTENT.PLAN_TODAY,
  INTENT.PLAN_TMRW,
  INTENT.WK_REVIEW,
  INTENT.VAULT_CLEAN,
];

/**
 * Integration *categories* an intent may require. A category is satisfied
 * when ANY of its providers is connected (e.g. email works via Gmail OR
 * plain IMAP) — Nexus is never provider-locked.
 */
export const CATEGORY_PROVIDERS: Record<string, string[]> = {
  email: ["google", "imap"],
  calendar: ["google", "caldav"],
  notion: ["notion"],
};

export function categorySatisfied(category: string, connectedProviders: Set<string>): boolean {
  const providers = CATEGORY_PROVIDERS[category];
  if (!providers) return connectedProviders.has(category);
  return providers.some((p) => connectedProviders.has(p));
}

export const AGENT = {
  PLANNER: "planner",
  ANALYST: "analyst",
  SCRIBE: "scribe",
  RESEARCHER: "researcher",
  INBOX: "inbox",
  CURATOR: "curator",
  SYSTEM: "system",
  /** the operator-facing conversational voice of the whole system */
  NEXUS: "nexus",
} as const;
export type AgentName = (typeof AGENT)[keyof typeof AGENT];
