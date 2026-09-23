import { describe, expect, it, vi } from "vitest";
import {
  buildDevlogInput,
  findMissingPrRefs,
  findUnknownPrRefs,
  isoWeekLabel,
  isPrListTruncated,
  isValidDate,
  isValidRepo,
  listMergedPrs,
  PR_LIST_LIMIT,
  type MergedPr,
} from "../src/devlog.js";

const pr = (number: number, mergedAt = "2026-09-20T10:00:00Z", body = "b"): MergedPr => ({
  number,
  title: `PR ${number}`,
  body,
  mergedAt,
  url: `https://github.com/o/r/pull/${number}`,
});

describe("isoWeekLabel", () => {
  it.each([
    ["2026-01-01", "2026-W01"], // Thursday
    ["2025-12-29", "2026-W01"], // Monday of the week containing 2026-01-01
    ["2027-01-01", "2026-W53"], // Friday: still the last ISO week of 2026
    ["2026-09-23", "2026-W39"],
    ["2026-09-27", "2026-W39"], // Sunday ends the ISO week
    ["2026-09-28", "2026-W40"],
  ])("%s → %s", (date, label) => {
    expect(isoWeekLabel(new Date(`${date}T12:00:00Z`))).toBe(label);
  });
});

describe("listMergedPrs", () => {
  it("calls gh with a merged-since search and sorts oldest first", async () => {
    const run = vi.fn(async () => JSON.stringify([pr(2, "2026-09-21T00:00:00Z"), pr(1, "2026-09-20T00:00:00Z")]));
    const prs = await listMergedPrs("Org/repo", "2026-09-16", run);
    expect(prs.map((p) => p.number)).toEqual([1, 2]);
    expect(run).toHaveBeenCalledWith("gh", expect.arrayContaining(["--repo", "Org/repo", "--state", "merged", "--search", "merged:>=2026-09-16"]));
  });

  it("rejects malformed repo names and dates before running anything", async () => {
    const run = vi.fn(async () => "[]");
    await expect(listMergedPrs("not a repo; rm -rf /", "2026-09-16", run)).rejects.toThrow(/Invalid repo/);
    await expect(listMergedPrs("o/r", "last week", run)).rejects.toThrow(/Invalid date/);
    expect(run).not.toHaveBeenCalled();
  });

  it("asks gh for one more than PR_LIST_LIMIT, so a capped list is detectable", async () => {
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      const limit = Number(args[args.indexOf("--limit") + 1]);
      return JSON.stringify(Array.from({ length: limit }, (_, i) => pr(i + 1)));
    });
    const prs = await listMergedPrs("o/r", "2026-06-25", run);
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(["--limit", String(PR_LIST_LIMIT + 1)]));
    expect(isPrListTruncated(prs)).toBe(true);
    expect(isPrListTruncated(prs.slice(0, PR_LIST_LIMIT))).toBe(false);
  });

  it("validates gh output and maps a null body to an empty string", async () => {
    const withNull = JSON.stringify([{ ...pr(5), body: null }]);
    await expect(listMergedPrs("o/r", "2026-09-16", async () => withNull)).resolves.toEqual([{ ...pr(5), body: "" }]);
    await expect(listMergedPrs("o/r", "2026-09-16", async () => JSON.stringify([{ ...pr(5), number: 5.5 }]))).rejects.toThrow(/unexpected PR list.*0\.number/);
    await expect(listMergedPrs("o/r", "2026-09-16", async () => JSON.stringify([{ ...pr(5), url: 1 }]))).rejects.toThrow(/0\.url/);
    await expect(listMergedPrs("o/r", "2026-09-16", async () => "<html>")).rejects.toThrow(/isn't JSON/);
  });
});

describe("repo and date validation", () => {
  it("accepts GitHub-shaped owners and names", () => {
    expect(isValidRepo("a".repeat(39) + "/r")).toBe(true);
    expect(isValidRepo("o/.github")).toBe(true);
    expect(isValidRepo("o/_x")).toBe(true);
  });

  it("rejects flag-like, over-long and dot-only parts", () => {
    for (const bad of ["-o/r", "--help/r", "o/-r", "o/..", "o/.", "a".repeat(40) + "/r", "o_x/r", "o.x/r"]) {
      expect(isValidRepo(bad), bad).toBe(false);
    }
  });

  it("accepts only real calendar dates", () => {
    expect(isValidDate("2024-02-29")).toBe(true);
    for (const bad of ["2026-13-01", "2026-02-30", "2025-02-29", "0000-00-00", "0099-01-01", "2026-00-10", "2026-04-31"]) {
      expect(isValidDate(bad), bad).toBe(false);
    }
  });
});

describe("buildDevlogInput", () => {
  it("caps long descriptions and marks empty ones", () => {
    const input = buildDevlogInput("o/r", [pr(1, undefined, "x".repeat(5000)), pr(2, undefined, "")], 100);
    expect(input).toContain("[... description truncated ...]");
    expect(input).not.toContain("x".repeat(101));
    expect(input).toContain("(no description)");
    expect(input).toContain("===== PR #2 (o/r, merged 2026-09-20) =====");
  });
});

describe("PR reference checks", () => {
  const prs = [pr(12), pr(13)];
  it("flags cited PR numbers that weren't in the input", () => {
    expect(findUnknownPrRefs("Did a thing (#12). Also (#99) and (#99) and (#7).", prs)).toEqual([7, 99]);
  });
  it("only counts parenthesized references, the format the instruction mandates", () => {
    // A bare "#7" is as likely a hex colour (#333) or an anchor; only "(#7)" is a citation.
    expect(findUnknownPrRefs("Did a thing (#12) and #7.", prs)).toEqual([]);
    expect(findMissingPrRefs("Did #12 and #13.", prs)).toEqual([12, 13]);
  });
  it("flags input PRs the draft never cites", () => {
    expect(findMissingPrRefs("Only (#12).", prs)).toEqual([13]);
  });
});
