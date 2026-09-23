import { DEFAULT_THRESHOLDS, type Answer, type Band, type Thresholds } from './types.ts';

// a noul is banded on its probability, a score on its confidence, a choice on what it picked: a confident pick of a
// violating option is violated, a confident other pick satisfied, and any pick below hi unclear
export function bandOf(answer: Answer, thresholds: Thresholds = DEFAULT_THRESHOLDS, violates: readonly string[] = []): Band {
  if (answer.type === 'choice') {
    if (answer.confidence < thresholds.hi) return 'unclear';
    return violates.includes(answer.choice) ? 'violated' : 'satisfied';
  }
  const p = answer.type === 'noul' ? answer.p : answer.confidence;
  if (p >= thresholds.hi) return 'satisfied';
  if (p <= thresholds.lo) return 'violated';
  return 'unclear';
}

export function probabilityOf(answer: Answer): number {
  return answer.type === 'noul' ? answer.p : answer.confidence;
}

export function labelOf(answer: Answer): string {
  switch (answer.type) {
    case 'noul':
      return answer.p.toFixed(2);
    case 'choice':
      return `${answer.choice}@${answer.confidence.toFixed(2)}`;
    case 'score':
      return `${answer.legend}@${answer.confidence.toFixed(2)}`;
  }
}
