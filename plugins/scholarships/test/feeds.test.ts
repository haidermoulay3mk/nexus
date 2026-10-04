import { describe, expect, test } from "bun:test";
import { DEFAULT_RULES, type FeedItem, itemId, matchesRules, parseFeed } from "../src/feeds";

const RSS2 = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test Feed</title>
<item>
  <title><![CDATA[Fully Funded Undergraduate Scholarship in Japan 2027]]></title>
  <link>https://example.org/japan-2027</link>
  <pubDate>Mon, 06 Jul 2026 08:00:00 +0000</pubDate>
  <description><![CDATA[<p>Apply now &amp; study for a <b>bachelor</b> degree.</p>]]></description>
</item>
<item>
  <title>PhD Fellowship at Example University</title>
  <link>https://example.org/phd-fellowship</link>
  <pubDate>Sun, 05 Jul 2026 08:00:00 +0000</pubDate>
  <description>Doctoral researchers only.</description>
</item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <title>Bachelor Grants for International Students</title>
  <link href="https://example.com/bachelor-grants"/>
  <published>2026-07-04T10:00:00Z</published>
  <summary>Undergraduate grant program.</summary>
</entry>
</feed>`;

describe("feed parsing", () => {
  test("parses RSS 2.0 items with CDATA, entities and dates", () => {
    const items = parseFeed(RSS2);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe("Fully Funded Undergraduate Scholarship in Japan 2027");
    expect(items[0]?.link).toBe("https://example.org/japan-2027");
    expect(items[0]?.published).toBe("2026-07-06");
    expect(items[0]?.snippet).toContain("Apply now & study for a bachelor degree.");
  });

  test("parses Atom entries with href links", () => {
    const items = parseFeed(ATOM);
    expect(items).toHaveLength(1);
    expect(items[0]?.link).toBe("https://example.com/bachelor-grants");
  });

  test("garbage in → empty list, never a throw", () => {
    expect(parseFeed("<html>not a feed</html>")).toEqual([]);
    expect(parseFeed("")).toEqual([]);
  });
});

describe("filter rules", () => {
  const item = (title: string, snippet = ""): FeedItem => ({
    title,
    link: "https://x/y",
    published: "",
    snippet,
  });

  test("undergraduate scholarship passes", () => {
    expect(
      matchesRules(item("Fully Funded Undergraduate Scholarship in Japan"), DEFAULT_RULES),
    ).toBe(true);
  });

  test("postgrad-only content is excluded", () => {
    expect(matchesRules(item("PhD Fellowship at MIT"), DEFAULT_RULES)).toBe(false);
    expect(matchesRules(item("Masters Scholarship in Germany"), DEFAULT_RULES)).toBe(false);
  });

  test("mixed-level items are rescued by undergrad markers", () => {
    expect(matchesRules(item("Masters and Undergraduate Scholarships 2027"), DEFAULT_RULES)).toBe(
      true,
    );
  });

  test("non-scholarship content is excluded", () => {
    expect(matchesRules(item("10 Remote Job Openings for Students"), DEFAULT_RULES)).toBe(false);
  });

  test("level-silent scholarship passes (no level markers at all)", () => {
    expect(
      matchesRules(item("Government Scholarship for International Students"), DEFAULT_RULES),
    ).toBe(true);
  });
});

describe("item ids", () => {
  test("stable and distinct", () => {
    expect(itemId("https://example.org/a")).toBe(itemId("https://example.org/a"));
    expect(itemId("https://example.org/a")).not.toBe(itemId("https://example.org/b"));
    expect(itemId("https://example.org/a")).toMatch(/^[0-9a-f]{8}$/);
  });
});
