/** Rough chars-per-token for English prose and code. Only used for sizing, never for billing. */
export const CHARS_PER_TOKEN = 3.5;
/** Tokens held back for the system prompt, instruction and the model's answer. */
export const RESERVED_TOKENS = 4096;
/** Never ask Ollama for less than this; small inputs still get room to answer. */
export const MIN_CTX = 8192;

export interface InputFile {
  path: string;
  text: string;
}

export function fileHeader(p: string) {
  return `\n===== FILE: ${p} =====\n`;
}
export const FILE_FOOTER = "\n===== END FILE =====";
/** What the server joins the instruction and the framed files with. */
export const PART_SEPARATOR = "\n";

/**
 * Characters of file content that fit once the instruction and per-file framing are
 * accounted for. The server builds `[instruction, ...files].join(PART_SEPARATOR)`, so each
 * file also costs one separator.
 */
export function contentBudgetChars(maxCtx: number, instruction: string, paths: readonly string[]): number {
  const framing = paths.reduce((n, p) => n + fileHeader(p).length + FILE_FOOTER.length + PART_SEPARATOR.length, 0);
  return Math.max(0, Math.floor((maxCtx - RESERVED_TOKENS) * CHARS_PER_TOKEN) - instruction.length - framing);
}

export function omissionMarker(cut: number) {
  return `\n\n[... ${cut} chars omitted ...]\n\n`;
}

/**
 * Per-file character shares by max-min fairness: files smaller than an equal split of
 * what's left are kept whole, and the remainder is split evenly among the larger ones.
 * (Proportional shares would reduce a tiny config file next to a huge log to nothing.)
 */
export function fairShares(lengths: readonly number[], budgetChars: number): number[] {
  const shares = Array.from({ length: lengths.length }, () => 0);
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len);
  let remaining = Math.max(0, budgetChars);
  order.forEach(({ len, i }, k) => {
    const fair = Math.floor(remaining / (order.length - k));
    shares[i] = Math.min(len, fair);
    remaining -= shares[i]!;
  });
  return shares;
}

/**
 * Fits files into `budgetChars` total (see fairShares). An oversized file keeps its head
 * (1/3) and tail (2/3), since logs usually end with the part that matters. The omission
 * marker counts against the file's share, so the result never exceeds the budget.
 */
export function fitToBudget(files: readonly InputFile[], budgetChars: number): { files: InputFile[]; truncated: boolean } {
  const total = files.reduce((n, f) => n + f.text.length, 0);
  if (total <= budgetChars) return { files: [...files], truncated: false };

  const shares = fairShares(
    files.map((f) => f.text.length),
    budgetChars,
  );
  return {
    truncated: true,
    files: files.map((f, i) => {
      const share = shares[i]!;
      if (f.text.length <= share) return f;
      // Upper bound on the marker's length: `cut` never has more digits than the file length.
      const markerLen = omissionMarker(f.text.length).length;
      // Not even room for the marker: drop the content entirely (the caller reports truncation).
      if (share < markerLen) return { ...f, text: "" };
      const keep = share - markerLen;
      let head = Math.floor(keep / 3);
      let tail = keep - head;
      // Never split a UTF-16 surrogate pair (the model would get a lone surrogate).
      // Shrinking a cut by one unit keeps the result within the share.
      if (head > 0 && isHighSurrogate(f.text.charCodeAt(head - 1))) head--;
      if (tail > 0 && isLowSurrogate(f.text.charCodeAt(f.text.length - tail))) tail--;
      const cut = f.text.length - head - tail;
      // Note: slice(-0) would return the WHOLE string, hence the explicit guard.
      const tailText = tail > 0 ? f.text.slice(-tail) : "";
      return { ...f, text: f.text.slice(0, head) + omissionMarker(cut) + tailText };
    }),
  };
}

function isHighSurrogate(c: number) {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLowSurrogate(c: number) {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** The num_ctx to request: enough for the input plus headroom, within [MIN_CTX, maxCtx]. */
export function contextSize(inputChars: number, maxCtx: number): number {
  return Math.min(maxCtx, Math.max(MIN_CTX, Math.ceil(inputChars / CHARS_PER_TOKEN) + RESERVED_TOKENS));
}
