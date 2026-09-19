import { DEFAULT_THRESHOLDS, type Answer, type Band, type Thresholds } from './types.ts';

// a noul is banded on its probability, a choice or score on its confidence
export function bandOf(answer: Answer, thresholds: Thresholds = DEFAULT_THRESHOLDS): Band {
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
