// rough token estimate without a tokenizer, biased slightly high so budgets hold
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function estimateTokensOf(value: unknown): number {
  return estimateTokens(typeof value === 'string' ? value : JSON.stringify(value) ?? '');
}

export function truncate(text: string, maxChars: number, note = '…'): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}${note}`;
}
