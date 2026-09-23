import { DEFAULT_THRESHOLDS, type Answer, type Band, type Thresholds } from './types.ts';

// a noul is banded on its probability, a choice or score on what it picked: a confident pick of a violating option
// key or level index is violated, a confident other pick satisfied, and any pick below hi unclear
export function bandOf(answer: Answer, thresholds: Thresholds = DEFAULT_THRESHOLDS, violates: readonly (string | number)[] = []): Band {
  if (answer.type === 'noul') {
    if (answer.p >= thresholds.hi) return 'satisfied';
    if (answer.p <= thresholds.lo) return 'violated';
    return 'unclear';
  }
  if (answer.confidence < thresholds.hi) return 'unclear';
  return violates.includes(answer.type === 'choice' ? answer.choice : answer.score) ? 'violated' : 'satisfied';
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
