// one shell word: single quotes verbatim, double quotes with backslash escapes, else up to whitespace
export function shellWord(text: string): string | undefined {
  if (text.length === 0) return undefined;
  const q = text[0];
  if (q === "'") {
    const end = text.indexOf("'", 1);
    return end < 0 ? text.slice(1) : text.slice(1, end);
  }
  if (q === '"') {
    let out = '';
    for (let i = 1; i < text.length; i++) {
      const c = text[i]!;
      if (c === '\\' && i + 1 < text.length && '$`"\\\n'.includes(text[i + 1]!)) {
        out += text[++i];
        continue;
      }
      if (c === '"') return out;
      out += c;
    }
    return out;
  }
  return /^\S+/.exec(text)?.[0];
}

const WRAPPERS = new Set(['env', 'command', 'exec', 'time', 'nohup', 'builtin']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// a redirection word: an optional descriptor, the operator, and the target when it is glued on
const REDIRECT = /^(?:\d+|&)?(?:>>|>&|<&|>\||>|<)(.*)$/;

type Frame = { words: string[]; word: string | undefined; kind: 'paren' | 'tick'; quoted: boolean };

// the simple commands of a shell command line, each as its words with quotes removed: split at ; & | and newlines,
// at subshells, $( ) (inside double quotes too) and backticks. heredoc bodies, comments and redirections are dropped,
// and so are leading variable assignments and wrappers such as env, so each command starts with the program it runs
export function simpleCommands(line: string): string[][] {
  const out: string[][] = [];
  const stack: Frame[] = [];
  let words: string[] = [];
  let word: string | undefined;
  // inside double quotes, and whether the innermost subshell opened inside them
  let dq = false;
  let quoted = false;
  let heredocs: { delim: string; strip: boolean }[] = [];
  let skipNext = false;
  const endWord = () => {
    if (word === undefined) return;
    const w = word;
    word = undefined;
    if (skipNext) {
      skipNext = false;
      return;
    }
    if (w.startsWith('<<<')) {
      skipNext = w.length === 3;
      return;
    }
    const heredoc = /^<<(-?)(.*)$/.exec(w);
    if (heredoc) {
      heredocs.push({ delim: heredoc[2]!, strip: heredoc[1] === '-' });
      return;
    }
    const pending = heredocs[heredocs.length - 1];
    if (pending && pending.delim === '') {
      pending.delim = w;
      return;
    }
    const redirect = REDIRECT.exec(w);
    if (redirect) {
      skipNext = redirect[1] === '';
      return;
    }
    words.push(w);
  };
  const endCommand = () => {
    endWord();
    skipNext = false;
    let i = 0;
    while (i < words.length && (ASSIGNMENT.test(words[i]!) || WRAPPERS.has(words[i]!))) i++;
    if (i < words.length) out.push(words.slice(i));
    words = [];
  };
  const open = (kind: Frame['kind']) => {
    stack.push({ words, word, kind, quoted });
    words = [];
    word = undefined;
    quoted = dq;
    dq = false;
  };
  const close = () => {
    const outer = stack.pop()!;
    endCommand();
    words = outer.words;
    word = outer.word;
    dq = quoted;
    quoted = outer.quoted;
  };
  // the bodies of the heredocs opened on the line that ends at i, each up to its delimiter alone on a line
  const skipHeredocs = (i: number): number => {
    for (const h of heredocs) {
      while (i < line.length) {
        const end = line.indexOf('\n', i + 1);
        const next = line.slice(i + 1, end < 0 ? line.length : end);
        i = end < 0 ? line.length : end;
        if ((h.strip ? next.replace(/^\t+/, '') : next) === h.delim) break;
      }
    }
    heredocs = [];
    return i;
  };
  const top = () => stack[stack.length - 1]?.kind;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const next = line[i + 1];
    if (dq) {
      if (c === '"') dq = false;
      else if (c === '\\' && next !== undefined && '$`"\\\n'.includes(next)) word += next === '\n' ? '' : line[++i]!;
      else if (c === '$' && next === '(') {
        i++;
        open('paren');
      } else if (c === '`') {
        if (top() === 'tick') close();
        else open('tick');
      } else word += c;
      continue;
    }
    if (c === '\n') {
      endCommand();
      i = skipHeredocs(i);
    } else if (c === ' ' || c === '\t') endWord();
    else if (c === '#' && word === undefined) {
      const end = line.indexOf('\n', i);
      i = (end < 0 ? line.length : end) - 1;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      word = (word ?? '') + line.slice(i + 1, end < 0 ? line.length : end);
      i = end < 0 ? line.length : end;
    } else if (c === '"') {
      dq = true;
      word = word ?? '';
    } else if (c === '\\' && next !== undefined) word = (word ?? '') + (line[++i] === '\n' ? '' : line[i]!);
    else if (c === '$' && next === '(') {
      i++;
      open('paren');
    } else if (c === '(') {
      endCommand();
      open('paren');
    } else if (c === ')') {
      if (top() === 'paren') close();
      else endCommand();
    } else if (c === '`') {
      if (top() === 'tick') close();
      else open('tick');
    } else if (c === '&' && next === '>') {
      endWord();
      word = '&';
    } else if (c === '&' && word !== undefined && /[<>]$/.test(word)) word += c;
    else if (c === ';' || c === '&' || c === '|') {
      if (c === '|' && word !== undefined && word.endsWith('>')) word += c;
      else endCommand();
    } else if (c === '<' || c === '>') {
      // a redirection is a word of its own, save the descriptor it follows
      if (word !== undefined && !/^(?:\d+|&)?[<>]*$/.test(word)) endWord();
      word = (word ?? '') + c;
    } else word = (word ?? '') + c;
  }
  while (stack.length > 0) close();
  endCommand();
  return out;
}
