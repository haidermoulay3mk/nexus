/**
 * Pure feed parsing + filtering for the scholarships sweep.
 * All rules are CODE — a weak (or absent) model cannot break them.
 */

export interface FeedItem {
  title: string;
  link: string;
  published: string; // YYYY-MM-DD or ""
  snippet: string;
}

export interface FilterRules {
  /** at least one must appear in title+snippet (case-insensitive) */
  include: string[];
  /** postgrad-only markers — excluded unless an undergrad marker also appears */
  postgrad: string[];
  /** undergrad markers that rescue an item containing postgrad markers */
  undergrad: string[];
}

export const DEFAULT_RULES: FilterRules = {
  include: ["scholarship", "fellowship", "bursary", "financial aid", "fully funded", "grant"],
  postgrad: ["master", "mba", "phd", "doctoral", "postdoc", "postgraduate"],
  undergrad: ["undergraduate", "undergrad", "bachelor", "high school", "school leavers"],
};

/** Feeds are ordinary WordPress/Atom feeds — free, keyless. Dead feeds are
 *  tolerated: the sweep reports per-feed status instead of failing. */
export const DEFAULT_FEEDS: string[] = [
  "https://opportunitydesk.org/feed/",
  "https://www.opportunitiesforafricans.com/feed/",
  "https://opportunitiescircle.com/feed/",
  "https://www.scholars4dev.com/feed/",
  "https://www.afterschoolafrica.com/feed/",
  "https://scholarshiproar.com/feed/",
];

const decode = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8211;|&ndash;|&#8212;|&mdash;/g, "-")
    .replace(/&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tag = (xml: string, name: string): string =>
  xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? "";

/** Parse RSS 2.0 `<item>` and Atom `<entry>` blocks. Regex-based on purpose:
 *  zero dependencies, tolerant of the messy XML real feeds emit. */
export function parseFeed(xml: string, limit = 30): FeedItem[] {
  const out: FeedItem[] = [];
  const blocks = [
    ...(xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []),
    ...(xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? []),
  ];
  for (const block of blocks) {
    const title = decode(tag(block, "title"));
    let link = decode(tag(block, "link"));
    if (!link) link = block.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? "";
    const dateRaw = tag(block, "pubDate") || tag(block, "published") || tag(block, "dc:date");
    let published = "";
    if (dateRaw) {
      const d = new Date(decode(dateRaw));
      if (!Number.isNaN(d.getTime())) published = d.toISOString().slice(0, 10);
    }
    const snippet = decode(
      tag(block, "description") || tag(block, "summary") || tag(block, "content"),
    ).slice(0, 280);
    if (title && link) out.push({ title, link: link.trim(), published, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

/** The whole filter, as one auditable function. */
export function matchesRules(item: FeedItem, rules: FilterRules): boolean {
  const text = `${item.title} ${item.snippet}`.toLowerCase();
  if (!rules.include.some((w) => text.includes(w.toLowerCase()))) return false;
  const hasPostgrad = rules.postgrad.some((w) => new RegExp(`\\b${w}`, "i").test(text));
  const hasUndergrad = rules.undergrad.some((w) => text.includes(w.toLowerCase()));
  if (hasPostgrad && !hasUndergrad) return false;
  return true;
}

/** Stable 8-hex id from the item link (FNV-1a) — the dedupe key. */
export function itemId(link: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < link.length; i++) {
    h ^= link.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
