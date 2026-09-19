import { messageOf, parseAnswer } from './jev.ts';
import type { Answers, Judge, Judgement, Questions } from './types.ts';

export type CompleteLike = (request: {
  model: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
}) => Promise<string>;

const SYSTEM = `You are a calibrated classifier. You never write prose. You answer a set of typed questions about a state with one JSON object and nothing else.
For a "noul" question answer {"noul": p} where p in [0,1] is the probability the statement holds.
For a "choice" question answer {"choice": key, "confidence": p} with one key from its criteria.
For a "score" question answer {"score": i, "confidence": p} where i is the 0-based index into its criteria.
Be honest about uncertainty: use probabilities near 0.5 when the state does not settle the question.`;

export function buildPrompt(state: unknown, questions: Questions): string {
  return [
    'STATE:',
    JSON.stringify(state, null, 1),
    '',
    'QUESTIONS:',
    JSON.stringify(questions, null, 1),
    '',
    'Answer with one JSON object keyed by question id.',
  ].join('\n');
}

export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// fills the fields a chat model is not asked for so parseAnswer accepts the reply
function widen(raw: unknown, question: Questions[string]): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const r = { ...(raw as Record<string, unknown>) };
  if (question.type === 'choice' && typeof r['choice'] === 'string' && r['probabilities'] === undefined) {
    const confidence = typeof r['confidence'] === 'number' ? r['confidence'] : 1;
    const others = Object.keys(question.criteria).filter((k) => k !== r['choice']);
    const rest = others.length > 0 ? (1 - confidence) / others.length : 0;
    r['probabilities'] = Object.fromEntries(
      Object.keys(question.criteria).map((k) => [k, k === r['choice'] ? confidence : rest]),
    );
  }
  if (question.type === 'score' && typeof r['score'] === 'number' && r['probabilities'] === undefined) {
    const confidence = typeof r['confidence'] === 'number' ? r['confidence'] : 1;
    const n = question.criteria.length;
    const rest = n > 1 ? (1 - confidence) / (n - 1) : 0;
    r['probabilities'] = question.criteria.map((_, i) => (i === r['score'] ? confidence : rest));
  }
  return r;
}

export class ModelJudge implements Judge {
  readonly name: string;
  constructor(
    private readonly model: string,
    private readonly complete: CompleteLike,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.name = `model:${model}`;
  }

  async ask(state: unknown, questions: Questions): Promise<Judgement> {
    const started = this.now();
    let text: string;
    try {
      text = await this.complete({
        model: this.model,
        system: SYSTEM,
        prompt: buildPrompt(state, questions),
        maxTokens: 64 + Object.keys(questions).length * 40,
      });
    } catch (error) {
      return { ok: false, reason: 'unavailable', message: messageOf(error), backend: this.name };
    }
    const parsed = extractJson(text);
    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, reason: 'malformed', message: 'reply held no JSON object', backend: this.name };
    }
    const answers: Answers = {};
    for (const [id, question] of Object.entries(questions)) {
      const answer = parseAnswer(widen((parsed as Record<string, unknown>)[id], question), question);
      if (!answer) {
        return { ok: false, reason: 'malformed', message: `no usable answer for ${id}`, backend: this.name };
      }
      answers[id] = answer;
    }
    return { ok: true, answers, backend: this.name, latencyMs: this.now() - started };
  }
}
