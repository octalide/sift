import { describe, expect, it } from 'vitest';
import { GitHubForge } from '../src/forge/github.ts';
import { expectedSubject, parseSubject } from '../src/packs/subject.ts';
import { fakeForge } from './fake-forge.ts';

const forge = fakeForge();
const refused = (kind: Parameters<typeof parseSubject>[0], ref: string | undefined, repo?: string) => {
  try {
    parseSubject(kind, ref, forge, repo);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`accepted ${JSON.stringify(ref)} for ${kind}`);
};

describe('grade subject', () => {
  it('accepts N, #N and a url for an issue or pull request', () => {
    expect(parseSubject('issue', '80', forge)).toEqual({ kind: 'issue', number: 80 });
    expect(parseSubject('issue', ' #80 ', forge)).toEqual({ kind: 'issue', number: 80 });
    expect(parseSubject('pr', '#7', forge)).toEqual({ kind: 'pr', number: 7 });
    expect(parseSubject('issue', 'https://fake/o/r/issue/80', forge)).toEqual({ kind: 'issue', number: 80, repo: 'o/r' });
    expect(parseSubject('pr', 'https://fake/other/repo/pr/3', forge, 'other/repo')).toEqual({ kind: 'pr', number: 3, repo: 'other/repo' });
    expect(parseSubject('pr', 'dev..HEAD', forge)).toEqual({ kind: 'pr', range: 'dev..HEAD' });
    expect(parseSubject('pr', 'origin/dev...feat/1', forge)).toEqual({ kind: 'pr', range: 'origin/dev...feat/1' });
    expect(() => parseSubject('issue', 'dev..HEAD', forge)).toThrow('not a number');
  });

  it('refuses a missing subject with the expected form named, before any request', () => {
    for (const kind of ['issue', 'pr', 'commit', 'release'] as const) {
      const message = refused(kind, undefined);
      expect(message).toContain(`${kind} pack: no subject`);
      expect(message).toContain(expectedSubject(kind, forge));
      expect(refused(kind, '   ')).toBe(message);
    }
    expect(expectedSubject('issue', forge)).toBe('an issue number (N or #N) or a Fake issue URL');
    expect(expectedSubject('pr', forge)).toBe('a pull request number (N or #N), a Fake pull request URL, or a range (dev..HEAD)');
  });

  it('refuses text, a url of the wrong kind, a url of another forge and a url that contradicts repo', () => {
    const body = 'grade tool: accept #N and URLs, name a missing subject\n\n## Problem\n\nThe tool turns the subject into NaN';
    const message = refused('issue', body);
    expect(message).toContain('reads as text, not a reference');
    expect(message).toContain(`(${JSON.stringify(`${body.slice(0, 57)}...`)})`);
    expect(message).toContain(expectedSubject('issue', forge));
    expect(refused('issue', 'NaN')).toContain('is not a number');
    expect(refused('issue', 'https://fake/o/r/pr/3')).toContain('is a pull request URL, not an issue');
    expect(refused('pr', 'https://fake/o/r/issue/3')).toContain('is an issue URL, not a pull request');
    expect(refused('issue', 'https://elsewhere.example/o/r/issues/3')).toContain('a URL Fake does not serve as an issue');
    expect(refused('issue', 'https://fake/o/r/issue/3', 'x/y')).toContain('names o/r but repo is x/y');
  });

  it('accepts a ref or range for a commit and refuses what cannot be one', () => {
    expect(parseSubject('commit', 'HEAD', forge)).toEqual({ kind: 'commit', ref: 'HEAD' });
    expect(parseSubject('commit', 'main..HEAD', forge)).toEqual({ kind: 'commit', ref: 'main..HEAD' });
    expect(parseSubject('commit', 'abc1234', forge)).toEqual({ kind: 'commit', ref: 'abc1234' });
    expect(parseSubject('commit', 'v1.2.0~3^2', forge)).toEqual({ kind: 'commit', ref: 'v1.2.0~3^2' });
    expect(refused('commit', '#12')).toContain('is an issue number, not a ref');
    expect(refused('commit', 'https://fake/o/r/pr/3')).toContain('is a URL');
    expect(refused('commit', 'fix: the thing')).toContain('reads as text');
    expect(refused('commit', '--all')).toContain('starts with a dash');
  });

  it('yields a reference, a commit or text for a mixed subject and refuses only what can be nothing', () => {
    expect(parseSubject('mixed', '42', forge)).toEqual({ kind: 'mixed', subject: { kind: 'issue', number: 42 } });
    expect(parseSubject('mixed', ' #42 ', forge)).toEqual({ kind: 'mixed', subject: { kind: 'issue', number: 42 } });
    expect(parseSubject('mixed', 'https://fake/o/r/issue/80', forge)).toEqual({ kind: 'mixed', subject: { kind: 'issue', number: 80, repo: 'o/r' } });
    expect(parseSubject('mixed', 'https://fake/o/r/pr/3', forge, 'o/r')).toEqual({ kind: 'mixed', subject: { kind: 'pr', number: 3, repo: 'o/r' } });
    expect(parseSubject('mixed', 'abc1234', forge)).toEqual({ kind: 'mixed', subject: { kind: 'commit', ref: 'abc1234' } });
    expect(parseSubject('mixed', 'main..HEAD', forge)).toEqual({ kind: 'mixed', subject: { kind: 'commit', ref: 'main..HEAD' } });
    expect(parseSubject('mixed', 'the watcher misses body edits', forge)).toEqual({ kind: 'mixed', subject: { kind: 'text', text: 'the watcher misses body edits' } });
    expect(parseSubject('mixed', 'NaN', forge)).toEqual({ kind: 'mixed', subject: { kind: 'text', text: 'NaN' } });
    expect(refused('mixed', undefined)).toContain('mixed pack: no subject');
    expect(refused('mixed', '  ')).toContain(expectedSubject('mixed', forge));
    expect(refused('mixed', 'https://elsewhere.example/o/r/issues/3')).toContain('a URL Fake does not serve as an issue or a pull request');
    expect(refused('mixed', 'https://fake/o/r/issue/3', 'x/y')).toContain('names o/r but repo is x/y');
    expect(expectedSubject('mixed', forge)).toBe('an issue or pull request number (N or #N), a Fake issue or pull request URL, a commit ref or range, or free text');
  });

  it('reads an issue or free text for the rules and refuses a pull request or a commit, naming what it takes', () => {
    expect(parseSubject('rules', '42', forge)).toEqual({ kind: 'rules', subject: { kind: 'issue', number: 42 } });
    expect(parseSubject('rules', ' #42 ', forge)).toEqual({ kind: 'rules', subject: { kind: 'issue', number: 42 } });
    expect(parseSubject('rules', 'https://fake/o/r/issue/80', forge)).toEqual({ kind: 'rules', subject: { kind: 'issue', number: 80, repo: 'o/r' } });
    expect(parseSubject('rules', 'the watcher misses body edits', forge)).toEqual({ kind: 'rules', subject: { kind: 'text', text: 'the watcher misses body edits' } });
    const takes = 'an issue number (N or #N), a Fake issue URL, or free text (in text)';
    expect(expectedSubject('rules', forge)).toBe(takes);
    for (const [ref, why] of [
      ['https://fake/o/r/pr/3', 'subject is a pull request URL, and a pull request is not read against the rules'],
      ['abc1234', 'subject is a commit ref or range, and a commit is not read against the rules'],
      ['main..HEAD', 'subject is a commit ref or range, and a commit is not read against the rules'],
      ['https://elsewhere.example/o/r/issues/3', 'subject is a URL Fake does not serve as an issue'],
    ] as const) {
      const message = refused('rules', ref);
      expect(message).toContain(`rules pack: ${why}`);
      expect(message).toContain(`expected ${takes}`);
    }
    expect(refused('rules', 'https://fake/o/r/issue/3', 'x/y')).toContain('names o/r but repo is x/y');
  });

  it('accepts a tag or "release" for a release and refuses what cannot be one', () => {
    expect(parseSubject('release', 'release', forge)).toEqual({ kind: 'release' });
    expect(parseSubject('release', 'v1.4.0', forge)).toEqual({ kind: 'release', proposed: 'v1.4.0' });
    expect(parseSubject('release', '2026.9', forge)).toEqual({ kind: 'release', proposed: '2026.9' });
    expect(refused('release', '#12')).toContain('is an issue number, not a version');
    expect(refused('release', 'https://fake/o/r/issue/3')).toContain('is a URL');
    expect(refused('release', 'the next release')).toContain('reads as text, not a tag');
  });

  it('parses the github url shapes of an issue or pull request', () => {
    const gh = new GitHubForge(async () => ({ exitCode: 1, stdout: '', stderr: '' }));
    expect(gh.parseUrl('https://github.com/octalide/sift/issues/80')).toEqual({ repo: 'octalide/sift', kind: 'issue', number: 80 });
    expect(gh.parseUrl('https://github.com/octalide/sift/pull/86/files')).toEqual({ repo: 'octalide/sift', kind: 'pr', number: 86 });
    expect(gh.parseUrl('https://github.com/octalide/sift/issues/80#issuecomment-1')).toEqual({ repo: 'octalide/sift', kind: 'issue', number: 80 });
    expect(gh.parseUrl('https://www.github.com/o/r/issues/1?x=y')).toEqual({ repo: 'o/r', kind: 'issue', number: 1 });
    expect(gh.parseUrl('https://api.github.com/repos/o/r/pulls/2')).toEqual({ repo: 'o/r', kind: 'pr', number: 2 });
    expect(gh.parseUrl('https://api.github.com/repos/o/r/issues/2')).toEqual({ repo: 'o/r', kind: 'issue', number: 2 });
    expect(gh.parseUrl('https://github.com/o/r')).toBeUndefined();
    expect(gh.parseUrl('https://github.com/o/r/commit/abc')).toBeUndefined();
    expect(gh.parseUrl('https://gitlab.com/o/r/-/issues/1')).toBeUndefined();
    expect(gh.parseUrl('80')).toBeUndefined();
    expect(parseSubject('issue', 'https://github.com/octalide/sift/issues/80', gh)).toEqual({ kind: 'issue', number: 80, repo: 'octalide/sift' });
  });
});
