import { describe, expect, it } from 'vitest';
import { partName, partsOf } from '../src/repo/parts.ts';

const joined = (text: string, cap: number) => partsOf(text, cap).map((p) => p.text).join('');

describe('text parts', () => {
  it('keeps a text under the cap whole', () => {
    expect(partsOf('# A\n\nshort\n', 100)).toEqual([{ text: '# A\n\nshort\n', headings: ['A'] }]);
    expect(partsOf('', 100)).toEqual([{ text: '', headings: [] }]);
  });

  it('splits at headings, packing adjacent blocks while they fit', () => {
    const text = `intro\n\n# One\n\n${'a'.repeat(30)}\n\n## Two\n\n${'b'.repeat(30)}\n\n## Three\n\n${'c'.repeat(30)}\n`;
    const parts = partsOf(text, 60);
    expect(parts.map((p) => p.text).join('')).toBe(text);
    expect(parts.every((p) => p.text.length <= 60)).toBe(true);
    expect(parts.map((p) => p.headings)).toEqual([['One'], ['Two'], ['Three']]);
    expect(parts[0]!.text.startsWith('intro\n\n# One')).toBe(true);
    expect(parts[1]!.text.startsWith('## Two')).toBe(true);
  });

  it('splits a block over the cap at paragraphs, then lines, then the cap itself', () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `${i}${'p'.repeat(20)}`).join('\n\n');
    const text = `# Long\n\n${paragraphs}\n`;
    const parts = partsOf(text, 50);
    expect(parts.map((p) => p.text).join('')).toBe(text);
    expect(parts.every((p) => p.text.length <= 50)).toBe(true);
    // every part after the first starts a paragraph and continues the block under its heading
    for (const p of parts.slice(1)) expect(p.text).toMatch(/^\dp/);
    expect(parts.every((p) => p.headings[0] === 'Long')).toBe(true);
    const line = 'x'.repeat(125);
    expect(partsOf(line, 50).map((p) => p.text.length)).toEqual([50, 50, 25]);
    expect(joined(`${'l'.repeat(40)}\n${'m'.repeat(40)}\n`, 50)).toBe(`${'l'.repeat(40)}\n${'m'.repeat(40)}\n`);
  });

  it('does not split at a heading inside a code fence', () => {
    const text = `# Real\n\n${'a'.repeat(30)}\n\n\`\`\`sh\n# not a heading\necho hi\n\`\`\`\n\n# After\n\n${'b'.repeat(30)}\n`;
    const parts = partsOf(text, 70);
    expect(parts.map((p) => p.text).join('')).toBe(text);
    expect([...new Set(parts.flatMap((p) => p.headings))]).toEqual(['Real', 'After']);
    expect(partsOf(text, 1000)[0]!.headings).toEqual(['Real', 'After']);
  });

  it('names a part by its place and headings', () => {
    expect(partName({ text: '', headings: [] }, 0, 3)).toBe('part 1 of 3');
    expect(partName({ text: '', headings: ['Fixes'] }, 1, 3)).toBe('part 2 of 3 ("Fixes")');
    expect(partName({ text: '', headings: ['Fixes', 'Docs', 'Tests'] }, 2, 3)).toBe('part 3 of 3 ("Fixes" to "Tests")');
  });
});
