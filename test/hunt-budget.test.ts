// Independent (test-hunter) pass on input budgeting. Written from the README and the
// doc comments in src/budget.ts.
import { describe, expect, it } from "vitest";
import { contentBudgetChars, contextSize, fairShares, fitToBudget, MIN_CTX, RESERVED_TOKENS, type InputFile } from "../src/budget.js";

const total = (files: { text: string }[]) => files.reduce((n, f) => n + f.text.length, 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// Small deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("fairShares", () => {
  it("returns an empty array for no files", () => {
    expect(fairShares([], 1000)).toEqual([]);
    expect(fairShares([], 0)).toEqual([]);
  });

  it("gives every file its full length when the budget covers the total", () => {
    expect(fairShares([10, 20, 30], 60)).toEqual([10, 20, 30]);
    expect(fairShares([10, 20, 30], 1_000_000)).toEqual([10, 20, 30]);
  });

  it("keeps small files whole and splits the rest evenly (max-min fairness)", () => {
    expect(fairShares([10, 1000, 1000], 1010)).toEqual([10, 500, 500]);
    // After the 10 is served, 90 remain for two large files: 45 each.
    expect(fairShares([1000, 10, 1000], 100)).toEqual([45, 10, 45]);
  });

  it("serves a file that becomes small only after another is served (iterative fill)", () => {
    // Equal split of 300 is 100; 50 fits. Remaining 250 over two files: 125 each, so the
    // 120 file fits whole too; the last gets 130.
    expect(fairShares([50, 120, 10_000], 300)).toEqual([50, 120, 130]);
  });

  it("handles zero-length files without NaN or negatives", () => {
    const s = fairShares([0, 0, 100], 50);
    expect(s).toEqual([0, 0, 50]);
    expect(fairShares([0, 0], 0)).toEqual([0, 0]);
    expect(fairShares([0], 10)).toEqual([0]);
  });

  it("returns all zeros for a zero budget", () => {
    expect(fairShares([5, 10, 100], 0)).toEqual([0, 0, 0]);
  });

  it("never returns negative or NaN shares for a negative budget", () => {
    const s = fairShares([5, 10, 100], -50);
    for (const x of s) {
      expect(Number.isNaN(x)).toBe(false);
      expect(x).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns integer shares even for a fractional budget", () => {
    // contentBudgetChars multiplies by 3.5, so an odd token count gives a .5 budget.
    const s = fairShares([100, 100, 100], 100.5);
    for (const x of s) expect(Number.isInteger(x)).toBe(true);
    expect(sum(s)).toBeLessThanOrEqual(100.5);
  });

  it("property: shares are within [0, length], sum within budget, and nothing is wasted", () => {
    const r = rng(42);
    for (let i = 0; i < 2000; i++) {
      const n = Math.floor(r() * 8);
      const lengths = Array.from({ length: n }, () => (r() < 0.2 ? 0 : Math.floor(r() * 5000)));
      const budget = Math.floor(r() * 12_000);
      const s = fairShares(lengths, budget);
      expect(s.length).toBe(n);
      s.forEach((x, k) => {
        expect(Number.isFinite(x)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(lengths[k]!);
      });
      expect(sum(s)).toBeLessThanOrEqual(budget);
      // Unused budget only when every file is whole, or at most rounding slack (< n).
      if (sum(lengths) > budget) expect(budget - sum(s)).toBeLessThan(Math.max(n, 1));
      else expect(s).toEqual(lengths);
    }
  });
});

describe("fitToBudget", () => {
  it("handles no files", () => {
    expect(fitToBudget([], 100)).toEqual({ files: [], truncated: false });
    expect(fitToBudget([], 0)).toEqual({ files: [], truncated: false });
  });

  it("handles empty files and does not report truncation for them", () => {
    const r = fitToBudget([{ path: "e", text: "" }], 0);
    expect(r.truncated).toBe(false);
    expect(r.files[0]!.text).toBe("");
  });

  it("returns files unchanged when the budget is larger than the total", () => {
    const files = [
      { path: "a", text: "abc" },
      { path: "b", text: "" },
    ];
    const r = fitToBudget(files, 10_000);
    expect(r.truncated).toBe(false);
    expect(r.files).toEqual(files);
  });

  it("keeps small files whole next to a huge one", () => {
    const r = fitToBudget(
      [
        { path: "cfg", text: "k=v\n".repeat(10) },
        { path: "log", text: "L".repeat(1_000_000) },
      ],
      2_000,
    );
    expect(r.truncated).toBe(true);
    expect(r.files[0]!.text).toBe("k=v\n".repeat(10));
    expect(total(r.files)).toBeLessThanOrEqual(2_000);
  });

  it("keeps roughly 1/3 head and 2/3 tail of an oversized file", () => {
    const text = Array.from({ length: 30_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const [f] = fitToBudget([{ path: "x", text }], 3_000).files;
    const m = f!.text.match(/^([\s\S]*?)\n\n\[\.\.\. (\d+) chars omitted \.\.\.\]\n\n([\s\S]*)$/);
    expect(m).not.toBeNull();
    const head = m![1]!;
    const tail = m![3]!;
    expect(text.startsWith(head)).toBe(true);
    expect(text.endsWith(tail)).toBe(true);
    expect(tail.length).toBeGreaterThan(head.length);
    expect(tail.length / (head.length + tail.length)).toBeCloseTo(2 / 3, 1);
    // The marker's count should be the real number of omitted characters.
    expect(Number(m![2])).toBe(text.length - head.length - tail.length);
  });

  it("does not return a file whose text is the full original when truncation is reported", () => {
    const r = fitToBudget([{ path: "a", text: "a".repeat(100) }], 99);
    expect(r.truncated).toBe(true);
    expect(r.files[0]!.text.length).toBeLessThanOrEqual(99);
  });

  it("stays within a fractional budget", () => {
    const files = [
      { path: "a", text: "a".repeat(20_000) },
      { path: "b", text: "b".repeat(20_000) },
    ];
    const r = fitToBudget(files, 14_339.5);
    expect(total(r.files)).toBeLessThanOrEqual(14_339.5);
  });

  it("property: never exceeds the budget, never grows a file, keeps fitting files verbatim", () => {
    const r = rng(7);
    for (let i = 0; i < 1500; i++) {
      const n = 1 + Math.floor(r() * 6);
      const files: InputFile[] = Array.from({ length: n }, (_, k) => ({ path: `f${k}`, text: "x".repeat(Math.floor(r() * 4000)) }));
      const budget = Math.floor(r() * 9000);
      const out = fitToBudget(files, budget);
      expect(out.files.length).toBe(n);
      expect(total(out.files)).toBeLessThanOrEqual(Math.max(budget, 0));
      out.files.forEach((f, k) => {
        expect(f.path).toBe(files[k]!.path);
        expect(f.text.length).toBeLessThanOrEqual(files[k]!.text.length);
      });
      expect(out.truncated).toBe(total(files) > budget);
    }
  });

  it("doesn't split a UTF-16 surrogate pair (the model would get a lone surrogate)", () => {
    const text = "\u{1F600}".repeat(5_000); // 10,000 UTF-16 code units
    // Try a few budgets so both even and odd head/tail lengths occur.
    for (const budget of [1_000, 1_001, 1_002, 1_003, 1_004]) {
      const [f] = fitToBudget([{ path: "emoji", text }], budget).files;
      // A lone high or low surrogate (String#isWellFormed isn't in this tsconfig's lib).
      const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      expect(lone.test(f!.text), `budget ${budget}`).toBe(false);
    }
  });
});

describe("contentBudgetChars", () => {
  it("is (maxCtx - reserved) * chars/token with no instruction or files", () => {
    expect(contentBudgetChars(32768, "", [])).toBe((32768 - RESERVED_TOKENS) * 3.5);
  });

  it("is never negative and never NaN", () => {
    expect(contentBudgetChars(1000, "", [])).toBeGreaterThanOrEqual(0);
    expect(contentBudgetChars(MIN_CTX, "", Array.from({ length: 20 }, () => "p".repeat(100_000)))).toBe(0);
  });

  it("charges more framing for longer paths", () => {
    expect(contentBudgetChars(32768, "", ["/a"])).toBeGreaterThan(contentBudgetChars(32768, "", ["/a/very/long/path/name.txt"]));
  });

  it("returns an integer number of characters", () => {
    expect(Number.isInteger(contentBudgetChars(8193, "", []))).toBe(true);
  });
});

describe("contextSize", () => {
  it("stays within [MIN_CTX, maxCtx] and returns an integer", () => {
    for (const chars of [0, 1, 3, 3.5, 1000, 99_999, 10_000_000]) {
      const c = contextSize(chars, 32768);
      expect(c).toBeGreaterThanOrEqual(MIN_CTX);
      expect(c).toBeLessThanOrEqual(32768);
      expect(Number.isInteger(c)).toBe(true);
    }
  });

  it("is monotonic in input size", () => {
    let prev = 0;
    for (let chars = 0; chars < 200_000; chars += 777) {
      const c = contextSize(chars, 65536);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });

  it("fits whatever contentBudgetChars allowed at the same maxCtx", () => {
    // If the server fills the content budget exactly, the requested context must still be
    // big enough for it plus the reserved tokens.
    for (const maxCtx of [8192, 8193, 16384, 32768]) {
      const budget = contentBudgetChars(maxCtx, "", []);
      expect(contextSize(budget, maxCtx)).toBe(maxCtx);
    }
  });
});
