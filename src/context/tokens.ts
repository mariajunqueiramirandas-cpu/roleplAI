/** Token estimates with a safety margin; chars-per-token is calibrated per model from real counts. */
export const SAFETY = 1.1;

export function estimateTokens(text: string, charsPerToken = 3.6): number {
  return Math.ceil((text.length / charsPerToken) * SAFETY - 1e-9);
}

/** Cut text to roughly `tokens`, on a sentence or word boundary. */
export function fitText(text: string, tokens: number, charsPerToken = 3.6): string {
  const maxChars = Math.floor((tokens * charsPerToken) / SAFETY);
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, Math.max(0, maxChars - 1));
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return (lastStop > maxChars * 0.6 ? cut.slice(0, lastStop + 1) : cut.replace(/\s+\S*$/, "")) + "…";
}

/** The summary an item is replaced by before it is dropped: its first sentence. */
export function summaryOf(text: string, maxWords = 25): string {
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  const w = first.split(/\s+/);
  return w.length > maxWords ? w.slice(0, maxWords).join(" ") + "…" : first;
}
