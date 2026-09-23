import { describe, expect, it } from "vitest";
import { contentBudgetChars, contextSize, fitToBudget, MIN_CTX, RESERVED_TOKENS } from "../src/budget.js";

const total = (files: { text: string }[]) => files.reduce((n, f) => n + f.text.length, 0);

describe("fitToBudget", () => {
  it("returns files unchanged when they fit", () => {
    const files = [{ path: "a", text: "x".repeat(100) }];
    const r = fitToBudget(files, 100);
    expect(r.truncated).toBe(false);
    expect(r.files).toEqual(files);
  });

  it("never exceeds the budget, markers included", () => {
    const files = [
      { path: "a", text: "a".repeat(50_000) },
      { path: "b", text: "b".repeat(5_000) },
      { path: "c", text: "c".repeat(123) },
    ];
    for (const budget of [0, 1, 50, 500, 5_000, 30_000]) {
      const r = fitToBudget(files, budget);
      expect(r.truncated).toBe(true);
      expect(total(r.files)).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps the head and a larger tail of an oversized file", () => {
    const text = "HEAD-" + "m".repeat(10_000) + "-TAIL";
    const [f] = fitToBudget([{ path: "log", text }], 600).files;
    expect(f!.text.startsWith("HEAD-")).toBe(true);
    expect(f!.text.endsWith("-TAIL")).toBe(true);
    expect(f!.text).toMatch(/\[\.\.\. \d+ chars omitted \.\.\.\]/);
  });

  it("doesn't return the whole file when the share leaves no room for a tail", () => {
    // A share smaller than the marker used to hit slice(-0), which returns the entire string.
    const [f] = fitToBudget([{ path: "log", text: "z".repeat(10_000) }], 5).files;
    expect(f!.text.length).toBeLessThan(10_000);
    expect(f!.text).not.toContain("zzzzzzzzzz");
  });

  it("gives small files their full text when their share covers them", () => {
    const r = fitToBudget(
      [
        { path: "big", text: "b".repeat(90_000) },
        { path: "small", text: "tiny" },
      ],
      45_000,
    );
    expect(r.files[1]!.text).toBe("tiny");
  });
});

describe("contextSize", () => {
  it("is at least MIN_CTX and at most maxCtx", () => {
    expect(contextSize(0, 32768)).toBe(MIN_CTX);
    expect(contextSize(10_000_000, 32768)).toBe(32768);
  });
  it("adds headroom for the answer", () => {
    expect(contextSize(70_000, 65536)).toBe(Math.ceil(70_000 / 3.5) + RESERVED_TOKENS);
  });
});

describe("contentBudgetChars", () => {
  it("subtracts the instruction and per-file framing, never going negative", () => {
    const base = contentBudgetChars(32768, "", []);
    expect(contentBudgetChars(32768, "x".repeat(100), [])).toBe(base - 100);
    expect(contentBudgetChars(32768, "", ["a"])).toBeLessThan(base);
    expect(contentBudgetChars(8192, "x".repeat(10_000_000), [])).toBe(0);
  });
});
