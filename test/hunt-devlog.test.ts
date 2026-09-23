// Independent (test-hunter) pass on the devlog helpers. Written from the README and the
// doc comments in src/devlog.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { findMissingPrRefs, findUnknownPrRefs, isoWeekLabel, listMergedPrs, type MergedPr } from "../src/devlog.js";

const pr = (number: number): MergedPr => ({
  number,
  title: `PR ${number}`,
  body: "b",
  mergedAt: "2026-09-20T10:00:00Z",
  url: `https://github.com/o/r/pull/${number}`,
});

describe("isoWeekLabel: year boundaries and leap years (noon UTC)", () => {
  it.each([
    ["2020-12-31", "2020-W53"], // Thu, 2020 has 53 weeks
    ["2021-01-01", "2020-W53"],
    ["2021-01-03", "2020-W53"], // Sunday
    ["2021-01-04", "2021-W01"], // Monday
    ["2024-12-30", "2025-W01"], // Monday belongs to next ISO year
    ["2024-12-29", "2024-W52"],
    ["2008-12-29", "2009-W01"],
    ["2010-01-03", "2009-W53"],
    ["2016-01-01", "2015-W53"], // Friday after a leap-year start
    ["2024-02-29", "2024-W09"], // leap day
    ["2024-03-01", "2024-W09"],
    ["2028-02-29", "2028-W09"],
    ["2000-02-29", "2000-W09"],
    ["2026-01-05", "2026-W02"], // zero-padded
    ["2026-12-31", "2026-W53"],
    ["2032-12-31", "2032-W53"], // leap year starting on Thursday
  ])("%s -> %s", (date, label) => {
    expect(isoWeekLabel(new Date(`${date}T12:00:00Z`))).toBe(label);
  });

  it("property: agrees with a reference implementation for every day 1999-2031", () => {
    const ref = (y: number, m: number, d: number) => {
      const t = new Date(Date.UTC(y, m, d));
      const dow = (t.getUTCDay() + 6) % 7; // Mon=0
      t.setUTCDate(t.getUTCDate() - dow + 3); // Thursday of this week
      const isoYear = t.getUTCFullYear();
      // Week number = which 7-day block of the ISO year the Thursday falls in.
      const week = Math.floor((t.getTime() - Date.UTC(isoYear, 0, 1)) / 864e5 / 7) + 1;
      return `${isoYear}-W${String(week).padStart(2, "0")}`;
    };
    for (let t = Date.UTC(1999, 0, 1); t < Date.UTC(2032, 0, 1); t += 864e5) {
      const d = new Date(t);
      const noon = new Date(t + 12 * 3600e3);
      expect(isoWeekLabel(noon)).toBe(ref(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
  });

  it("rejects an invalid Date instead of returning 'NaN-WNaN'", () => {
    let out: string | undefined;
    try {
      out = isoWeekLabel(new Date("not a date"));
    } catch {
      out = undefined;
    }
    expect(out ?? "threw").not.toMatch(/NaN/);
  });
});

describe("isoWeekLabel: local vs UTC", () => {
  const savedTz = process.env.TZ;
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  // The CLI labels "this week" for a person running it locally (e.g. a Friday 17:00 task).
  // The label should follow the local calendar date, not the UTC one.
  it("labels a late Sunday evening in a UTC-negative zone as that (local) week", () => {
    process.env.TZ = "America/Chicago";
    const sundayNight = new Date(2026, 8, 27, 23, 30); // local Sun 2026-09-27 23:30 = Mon 04:30Z
    expect(sundayNight.getDay()).toBe(0);
    expect(isoWeekLabel(sundayNight)).toBe("2026-W39");
  });

  it("labels an early Monday morning in a UTC-positive zone as the new (local) week", () => {
    process.env.TZ = "Pacific/Auckland";
    const mondayMorning = new Date(2026, 8, 28, 8, 0); // local Mon 08:00 = Sun 19:00Z
    expect(mondayMorning.getDay()).toBe(1);
    expect(isoWeekLabel(mondayMorning)).toBe("2026-W40");
  });

  it("labels New Year's Eve evening in a UTC-negative zone with the old year", () => {
    process.env.TZ = "America/Los_Angeles";
    const nye = new Date(2026, 11, 31, 20, 0); // local Thu 2026-12-31 = Fri 2027-01-01Z
    expect(isoWeekLabel(nye)).toBe("2026-W53");
  });
});

describe("findUnknownPrRefs / findMissingPrRefs: false positives and negatives", () => {
  it("does not treat #12 as a citation of #1", () => {
    expect(findMissingPrRefs("Did it (#12).", [pr(1), pr(12)])).toEqual([1]);
    expect(findMissingPrRefs("Did it (#120).", [pr(12)])).toEqual([12]);
  });

  it("returns sorted, de-duplicated numbers", () => {
    // Citations use the mandated "(#N)" form: bare "#100" can't be told apart from a hex
    // colour like "#333" (see the colour test above), so it isn't counted.
    expect(findUnknownPrRefs("(#9) (#3) (#9, #3) (#100)", [pr(1)])).toEqual([3, 9, 100]);
  });

  it("recognises several citations in one parenthesis", () => {
    expect(findMissingPrRefs("Refactor (#12, #13).", [pr(12), pr(13)])).toEqual([]);
    expect(findMissingPrRefs("Refactor (#12/#13).", [pr(12), pr(13)])).toEqual([]);
  });

  it("ignores markdown headings", () => {
    expect(findUnknownPrRefs("# Week 39\n\n## Highlights\n\nThing (#12).", [pr(12)])).toEqual([]);
  });

  it("ignores CSS hex colours, including ones that start with digits", () => {
    expect(findUnknownPrRefs("Changed the accent to #fff and #ffcc00.", [pr(12)])).toEqual([]);
    expect(findUnknownPrRefs("Changed the accent to #123abc (#12).", [pr(12)])).toEqual([]);
    expect(findUnknownPrRefs("Swapped #000 for #333 (#12).", [pr(12)])).toEqual([]);
  });

  it("ignores URL fragments / anchors", () => {
    expect(findUnknownPrRefs("See https://example.com/docs#42 (#12).", [pr(12)])).toEqual([]);
  });

  it("does not count a reference to another repo as a citation of this repo's PR", () => {
    // other/repo#12 is not this repo's #12.
    expect(findMissingPrRefs("Bumped other/lib#12.", [pr(12)])).toEqual([12]);
  });

  it("returns nothing for empty drafts and empty PR lists", () => {
    expect(findUnknownPrRefs("", [])).toEqual([]);
    expect(findMissingPrRefs("", [])).toEqual([]);
    expect(findMissingPrRefs("", [pr(1), pr(2)])).toEqual([1, 2]);
  });

  it("does not report #0 or leading-zero spellings as distinct PRs", () => {
    expect(findUnknownPrRefs("(#012)", [pr(12)])).toEqual([]);
  });
});

describe("listMergedPrs: input validation", () => {
  const ok = async () => "[]";

  it.each([
    ["o/r"],
    ["Org-Name/repo.name"],
    ["o/r_1"],
    ["a1/b-2.c_d"],
  ])("accepts %s", async (repo) => {
    await expect(listMergedPrs(repo, "2026-09-16", ok)).resolves.toEqual([]);
  });

  it.each([
    ["-o/r"], // looks like a flag to gh
    ["--help/r"],
    ["o/r/extra"],
    ["o/"],
    ["/r"],
    ["o"],
    [""],
    ["o/r\n"],
    ["o/r "],
    [" o/r"],
    ["o/.."],
    ["../r"],
    ["o/r;x"],
    ["o\\r"],
  ])("rejects repo %j without running gh", async (repo) => {
    const run = vi.fn(ok);
    await expect(listMergedPrs(repo, "2026-09-16", run)).rejects.toThrow(/Invalid repo/);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-9-16"],
    ["2026-09-16T00:00:00Z"],
    ["2026-09-16 author:someone"],
    ["2026-09-16\n"],
    ["x2026-09-16"],
    [""],
    ["2026-13-01"],
    ["2026-02-30"],
    ["0000-00-00"],
  ])("rejects date %j without running gh", async (date) => {
    const run = vi.fn(ok);
    await expect(listMergedPrs("o/r", date, run)).rejects.toThrow(/Invalid date/);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects gh output that isn't a JSON array of PRs", async () => {
    await expect(listMergedPrs("o/r", "2026-09-16", async () => "not json")).rejects.toThrow();
    await expect(listMergedPrs("o/r", "2026-09-16", async () => '{"message":"x"}')).rejects.toThrow();
    await expect(listMergedPrs("o/r", "2026-09-16", async () => "null")).rejects.toThrow();
  });

  it("rejects PR records with missing or mistyped fields", async () => {
    const bad = JSON.stringify([{ number: "12", title: 5, mergedAt: null }]);
    await expect(listMergedPrs("o/r", "2026-09-16", async () => bad)).rejects.toThrow();
  });

  it("doesn't silently drop PRs beyond gh's --limit", async () => {
    // A busy repo can merge more than 100 PRs in 90 days (--days allows up to 90). If the
    // list is capped, the draft (and its "never cites" check) silently miss PRs.
    const many = Array.from({ length: 100 }, (_, i) => pr(i + 1));
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      const limit = Number(args[args.indexOf("--limit") + 1]);
      return JSON.stringify(many.slice(0, limit));
    });
    const result = await listMergedPrs("o/r", "2026-06-25", run).then(
      (prs) => ({ ok: true as const, n: prs.length }),
      (err: Error) => ({ ok: false as const, msg: err.message }),
    );
    // Acceptable: either a limit comfortably above what gh returned, or an explicit error/warning
    // when the result hits the limit. Returning exactly `limit` PRs with no signal is the bug.
    const args = run.mock.calls[0]![1];
    const limit = Number(args[args.indexOf("--limit") + 1]);
    expect(result.ok && result.n === limit).toBe(false);
  });
});
