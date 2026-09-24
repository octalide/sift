import { estimateTokensOf, truncate } from '../tokens.ts';
import { CONTEXT_ROOM, fitTexts, STATE_ROOM, textTokens, type Cut, type Text } from '../judge/room.ts';
import type { Subject } from '../packs/types.ts';
import { refusal, type Asked } from '../packs/subject.ts';
import type { Check, Comment, Forge } from '../forge/forge.ts';
import type { Git } from '../forge/git.ts';
import { LOG_FORMAT, maxBump, parseCommit, parseLog, requiredBump, splitLog, type Bump, type ParsedCommit } from './commits.ts';
import { compareVersions, parseTag, SEMVER_PATTERN, type Version } from './version.ts';
import { manifestChanges, manifestFormat, type ManifestChange } from './manifest.ts';
import { driftOf, lineDiff } from './diff.ts';
import type { GitSource } from './source.ts';
import { tagPatternFor, type RepoConfig } from './config.ts';
import { governs, type Discoveries, type Discovery, type Rule, type RuleSource, type RuleTarget } from '../rules/discover.ts';
import { partName, partsOf } from './parts.ts';



export function sectionsOf(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current = '';
  for (const line of markdown.split('\n')) {
    const h = /^#{1,4}\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = h[1]!.trim();
      sections[current] = '';
    } else if (current) {
      sections[current] += `${line}\n`;
    }
  }
  return sections;
}

export function linkedIssues(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) out.add(Number(m[1]));
  return [...out];
}

// the issue a work branch is named after: the issue group of the branch pattern when it has one,
// otherwise the number segment of feat/52, fix/52-short-title, 52-title
export function branchIssue(branch: string, pattern?: string): number | undefined {
  const named = pattern ? new RegExp(pattern).exec(branch)?.groups?.['issue'] : undefined;
  if (named !== undefined) return Number(named);
  const m = /(?:^|\/)(\d+)(?:[-_]|$)/.exec(branch);
  return m ? Number(m[1]) : undefined;
}

// the forge's own relation first, then closing keywords in the body, then an issue number in the branch name
export function linkedOf(relation: number[], body: string, branch: string, pattern?: string): number[] {
  if (relation.length > 0) return relation;
  const keywords = linkedIssues(body);
  if (keywords.length > 0) return keywords;
  const fromBranch = branchIssue(branch, pattern);
  return fromBranch === undefined ? [] : [fromBranch];
}

// one comment as the judge reads it: who, their standing in the forge's words, when, and what they said
export type ThreadComment = { by: string; association: string | null; at: string; text: string };

// the comments that can amend an issue or pull request: its author's and its maintainers'
export function amends(forge: Pick<Forge, 'maintains'>, author: string, by: string, association: string | undefined): boolean {
  return by === author || forge.maintains(association);
}

// a thread as texts that take room after the rest of its subject: the author's and maintainers' comments first, newest first,
// then the newest of the rest, each its own tier from tier on, so a comment is cut only once every comment before it is whole.
// of builds the thread from the fitted texts, oldest first so a later ruling reads as later, a comment left no room dropped
export type Thread = { texts: Text[]; of: (fitted: string[]) => ThreadComment[] };

export function threadTexts(forge: Pick<Forge, 'maintains'>, author: string, comments: Comment[], tier = 1): Thread {
  const order = comments.map((c, i) => ({ c, i })).reverse();
  const standing = ({ c }: { c: Comment }) => amends(forge, author, c.author.login, c.association);
  const ranked = [...order.filter(standing), ...order.filter((x) => !standing(x))];
  return {
    texts: ranked.map(({ c }, r) => ({ name: `the comment by ${c.author.login} at ${c.createdAt}`, text: c.body, tier: tier + r })),
    of: (fitted) =>
      ranked
        .map(({ c, i }, r) => ({ i, text: fitted[r]!, dropped: fitted[r] === '' && c.body !== '', c }))
        .filter((x) => !x.dropped)
        .sort((a, b) => a.i - b.i)
        .map(({ c, text }) => ({ by: c.author.login, association: c.association ?? null, at: c.createdAt, text })),
  };
}

// the thread alone in a room, the tokens of the state it may take
export function threadOf(forge: Pick<Forge, 'maintains'>, author: string, comments: Comment[], room = STATE_ROOM): ThreadComment[] {
  const thread = threadTexts(forge, author, comments);
  return fitTexts(thread.texts, thread.of, room).state;
}

// the author's and maintainers' comments a judge can name as the one that settles something, keyed by who and when
export function rulingsOf(forge: Pick<Forge, 'maintains'>, author: string, thread: ThreadComment[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of thread) {
    if (!amends(forge, author, c.by, c.association ?? undefined)) continue;
    out[`${c.by} at ${c.at}`] = truncate(c.text.replace(/\s+/g, ' ').trim(), 160);
  }
  return out;
}

// an issue as its subjects read it: the state built from its body and thread, the texts those take room as, and what the checks read
async function readIssue(forge: Forge, repo: string, n: number, config: RepoConfig, asked: Asked<'issue' | 'rules'>) {
  const issue = await forge.issue(repo, n);
  if (issue.pr) throw refusal(asked, `#${n}`, `subject is ${repo}#${n}, a pull request, not an issue`, forge);
  const [all, open, parent] = await Promise.all([forge.comments(repo, 'issue', n), forge.openIssues(repo), forge.parent(repo, n)]);
  const sections = sectionsOf(issue.body);
  const labels = issue.labels;
  const others = open.filter((i) => i.number !== n);
  const thread = threadTexts(forge, issue.author.login, all);
  const state = (body: string, comments: ThreadComment[]) => ({
    repo,
    number: n,
    title: issue.title,
    body,
    labels,
    milestone: issue.milestone ?? null,
    author: issue.author.login,
    association: issue.association ?? null,
    sections: Object.keys(sections),
    comments,
    conventions: {
      template_sections: config.issues.templateSections,
      required_label_groups: config.issues.requiredLabelGroups,
    },
  });
  const subject = (built: Record<string, unknown>, comments: ThreadComment[], cuts: Cut[]): Subject => {
    const rulings = rulingsOf(forge, issue.author.login, comments);
    return {
      kind: 'issue',
      ref: `${repo}#${n}`,
      state: built,
      facts: {
        labels,
        milestone: issue.milestone,
        sections,
        parent,
        is_new: all.length === 0,
        has_others: others.length > 0,
        has_rulings: Object.keys(rulings).length > 0,
      },
      options: {
        rulings,
        open_issues: Object.fromEntries(others.slice(0, 200).map((i) => [`#${i.number}`, truncate(i.title, 120)])),
        type_labels: Object.fromEntries((config.issues.requiredLabelGroups[0] ?? []).map((l) => [l, `the ${l} label`])),
      },
      ...(cuts.length > 0 ? { cuts } : {}),
    };
  };
  return { issue, thread, state, subject };
}

// an issue graded for the pack that was asked; a number that names a pull request is refused with the pack and the forms of its kind named.
// the body and thread fit the state: the body takes room first, the thread what it leaves
export async function issueSubject(forge: Forge, repo: string, n: number, config: RepoConfig, asked: Asked<'issue' | 'rules'>): Promise<Subject> {
  const { issue, thread, state, subject } = await readIssue(forge, repo, n, config, asked);
  const fit = fitTexts([{ name: 'the body', text: issue.body, tier: 0 }, ...thread.texts], ([body, ...rest]) => state(body!, thread.of(rest)));
  return subject(fit.state, fit.state.comments, fit.cuts);
}

export async function prSubject(forge: Forge, repo: string, n: number, config: RepoConfig): Promise<Subject> {
  const pr = await forge.pull(repo, n);
  const body = pr.body;
  const [diff, all, checks, log, relation, baseDiff] = await Promise.all([
    forge.diff(repo, n).catch(() => ''),
    forge.comments(repo, 'pr', n),
    forge.checks(repo, pr.head.sha).catch(() => [] as Check[]),
    forge.pullCommits(repo, n).catch(() => []),
    forge.closingIssues(repo, n).catch(() => [] as number[]),
    forge.compareDiff(repo, pr.head.sha, pr.base).catch(() => ''),
  ]);
  const linked = linkedOf(relation, body, pr.head.branch, config.branches.pattern);
  const issue = linked[0] ? await forge.issue(repo, linked[0]).catch(() => undefined) : undefined;
  // merge commits (a branch updated from its base) are history, not work the convention judges
  const commits = log.filter((c) => !c.merge).map((c) => ({ sha: c.sha, message: c.message }));
  const failed = checks.filter((c) => c.done && !c.ok);
  const pending = checks.filter((c) => !c.done);
  const drift = driftOf(diff, baseDiff);
  // the body and the linked issue's take room first, the thread what they leave
  const thread = threadTexts(forge, pr.author.login, all, 1);
  const fit = fitTexts(
    [{ name: 'the body', text: body, tier: 0 }, ...(issue ? [{ name: `the body of #${issue.number}`, text: issue.body, tier: 0 }] : []), ...thread.texts],
    (texts) => {
      const [fitted, ...rest] = texts;
      const linkedBody = issue ? rest.shift()! : '';
      return {
        repo,
        number: n,
        title: pr.title,
        body: fitted!,
        author: pr.author.login,
        base: pr.base,
        head: pr.head.branch,
        draft: pr.draft,
        stats: pr.stats,
        linked_issue: issue ? { number: issue.number, title: issue.title, body: linkedBody } : null,
        commits: commits.map((c) => c.message.split('\n')[0]),
        checks: { failed: failed.map((c) => c.name), pending: pending.map((c) => c.name), total: checks.length },
        comments: thread.of(rest),
        drift,
      };
    },
  );
  return withCuts(
    {
      kind: 'pr',
      ref: `${repo}#${n}`,
      state: fit.state,
      facts: {
        linked,
        base: pr.base,
        head: pr.head.branch,
        sections: sectionsOf(body),
        checks_failed: failed.map((c) => c.name),
        checks_pending: pending.map((c) => c.name),
        commits,
        drift,
        has_issue: issue !== undefined,
        has_drift: drift.length > 0,
      },
      options: {},
    },
    fit.cuts,
  );
}

// where a range subject reads its issue from, when the checkout has a forge behind it
export type IssueSource = { forge: Forge; repo: string };

// a pull request that does not exist yet: base..head in the checkout, graded as the pr it would open.
// the forge facts a pr carries (its relation, target, checks, template body) are left out, so the checks
// that read them skip; the issue comes from the head branch name
export async function prRangeSubject(git: Git, range: string, config: RepoConfig, issues?: IssueSource): Promise<Subject> {
  const sep = range.indexOf('..');
  const base = range.slice(0, sep);
  const head = range.slice(sep + 2) || 'HEAD';
  if (!base) throw new Error(`pr range ${range}: no base, expected base..head`);
  const [diff, baseDiff, raw, branch] = await Promise.all([
    git(['diff', `${base}...${head}`]),
    git(['diff', `${head}...${base}`]),
    git(['log', LOG_FORMAT, '--no-merges', `${base}..${head}`]),
    git(['rev-parse', '--abbrev-ref', head]).then((s) => s.trim()),
  ]);
  const commits = splitLog(raw);
  const number = branchIssue(branch, config.branches.pattern);
  const issue = number !== undefined && issues ? await issues.forge.issue(issues.repo, number).catch(() => undefined) : undefined;
  const drift = driftOf(diff, baseDiff);
  const fit = fitTexts(issue ? [{ name: `the body of #${issue.number}`, text: issue.body }] : [], ([linkedBody]) => ({
    range,
    base,
    head: branch,
    linked_issue: issue ? { number: issue.number, title: issue.title, body: linkedBody! } : null,
    commits: commits.map((c) => c.message.split('\n')[0]),
    drift,
  }));
  return withCuts(
    {
      kind: 'pr',
      ref: range,
      state: fit.state,
      facts: {
        head: branch,
        commits,
        drift,
        has_issue: issue !== undefined,
        has_drift: drift.length > 0,
      },
      options: {},
    },
    fit.cuts,
  );
}

// the commits' subjects and bodies as primary texts: sharing the room evenly, a subject line stays whole
function commitTexts(commits: ParsedCommit[]): Text[] {
  return [
    ...commits.map((c) => ({ name: `the subject of ${c.sha.slice(0, 7)}`, text: c.subject })),
    ...commits.map((c) => ({ name: `the body of ${c.sha.slice(0, 7)}`, text: c.body })),
  ];
}

export async function commitSubject(git: Git, range: string, config: RepoConfig): Promise<Subject> {
  const raw = await git(range.includes('..') ? ['log', LOG_FORMAT, '--no-merges', range] : ['log', LOG_FORMAT, '-1', range]);
  const commits = parseLog(raw, config.commits.format);
  const k = commits.length;
  const fit = fitTexts(commitTexts(commits), (texts) => ({
    range,
    commits: commits.map((c, i) => ({ sha: c.sha.slice(0, 7), subject: texts[i]!, body: texts[k + i]! })),
    conventions: config.commits,
  }));
  return withCuts(
    {
      kind: 'commit',
      ref: range,
      state: fit.state,
      facts: { commits, single: commits.length === 1 },
      options: {
        commit_types: Object.fromEntries(config.commits.types.map((t) => [t, `a ${t} change`])),
      },
    },
    fit.cuts,
  );
}

// the highest release tag, not the nearest ancestor: release tags sit on main and are unreachable from dev
// without a version pattern the tags are still ordered as semver, so the release has a last tag to read commits from
export function lastReleaseTag(tags: string[], release: RepoConfig['release']): { tag: string; version: Version } | undefined {
  const patterns = { tagPattern: release.tagPattern ?? tagPatternFor(release.tagPrefix), versionPattern: release.versionPattern ?? SEMVER_PATTERN };
  let best: { tag: string; version: Version } | undefined;
  for (const tag of tags) {
    const version = parseTag(tag, patterns);
    if (!version) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { tag, version };
  }
  return best;
}

export async function releaseSubject(source: GitSource, config: RepoConfig): Promise<Subject> {
  const last = lastReleaseTag(await source.tags(), config.release);
  const lastTag = last?.tag;
  const range = lastTag ? `${lastTag}..${source.head}` : source.head;
  const commits = (await source.log(lastTag)).map((c) => parseCommit(c.sha, c.message, config.commits.format));
  const version = config.release.versionPattern ? last?.version : undefined;
  const commitBump = requiredBump(commits, config.commits.bumps ?? {}, version, config.release.zeroVerBreaking);
  const manifests: ManifestChange[] = [];
  const unparsed: string[] = [];
  for (const rule of config.release.manifests) {
    if ((rule.keys ?? []).length > 0 && !manifestFormat(rule.path)) unparsed.push(rule.path);
    manifests.push(...manifestChanges(rule, lastTag ? await source.show(lastTag, rule.path) : undefined, await source.show(source.head, rule.path)));
  }
  const manifestBump = manifests.reduce<Bump>((acc, m) => maxBump(acc, m.bump), 'none');
  const bump = maxBump(commitBump, manifestBump);
  const changelog = config.release.changelog ? await source.show(source.head, config.release.changelog) : undefined;
  const changelogPath = changelog !== undefined ? config.release.changelog : undefined;
  const changelogBefore = changelogPath && lastTag ? await source.show(lastTag, changelogPath) : undefined;
  const diff = lineDiff(changelogBefore ?? '', changelog ?? '');
  const changelogAdded = diff.added.join('\n');
  const k = commits.length;
  const fit = fitTexts([{ name: 'the changelog diff', text: diff.text, tier: 0 }, ...commitTexts(commits)], ([changelogDiff, ...texts]) => ({
    last_tag: lastTag ?? null,
    commits: commits.map((c, i) => ({ sha: c.sha.slice(0, 7), subject: texts[i]!, breaking: c.breaking, body: texts[k + i]! })),
    required_bump: bump,
    manifest_changes: manifests.map((m) => ({ path: m.path, key: m.key, from: m.from, to: m.to })),
    changelog_diff: changelogDiff!,
  }));
  return {
    kind: 'release',
    ref: range,
    ...(fit.cuts.length > 0 ? { cuts: fit.cuts } : {}),
    state: fit.state,
    facts: {
      lastTag,
      version,
      commits,
      bump,
      commitBump,
      manifestBump,
      manifests,
      manifestsUnparsed: unparsed,
      changelogPath,
      changelogAdded,
      changelog_changed: diff.text.length > 0,
      has_commits: commits.length > 0 || manifests.length > 0,
    },
    options: {},
  };
}

// the issue the rules are read against
export type RulesTarget = { number: number; pack: string };

// the checkout or repository the rules are read from, and the discoveries in flight that read them
export type RulesHost = { forge?: Forge; repo?: string; source: RuleSource; discoveries: Discoveries };

// an issue as the rules read it: its title and whole body through the parts free text takes, the rest of the issue beside the opening
export async function rulesSubjects(host: RulesHost, target: RulesTarget, config: RepoConfig): Promise<Subject[]> {
  const { forge, repo } = host;
  const ref = `#${target.number}`;
  // an issue carries its labels and milestone, so a rule about them is judged against it
  const carries: RuleTarget = { metadata: true };
  if (!forge || !repo) return [rulesOf(await rulesFound(host, config, carries), `issue:${ref}`, { kind: 'issue', ref }, 'The subject', {})];
  const { issue, thread, state } = await readIssue(forge, repo, target.number, config, { pack: target.pack, kind: 'rules' });
  const frame: Frame = {
    text: `${issue.title}\n${issue.body}`,
    whole: { texts: [{ name: 'the body', text: issue.body, tier: 0 }, ...thread.texts], build: ([body, ...rest]) => ({ kind: 'issue', ...state(body!, thread.of(rest)) }) },
    opening: {
      texts: thread.texts,
      build: (part, note, rest) => {
        const { title: _title, body: _body, ...others } = state('', thread.of(rest));
        return { kind: 'issue', ...others, note, text: part };
      },
    },
  };
  // the subject is read, and a pull request refused, before discovery spends judge calls
  return partSubjects(await rulesFound(host, config, carries), `issue:${ref}`, frame, `issue ${ref}`);
}

// text about to be written, as the rules read it: it sets no labels or milestone, so a rule about them is not judged
export async function textRulesSubjects(host: RulesHost, target: { text: string; about?: string }, config: RepoConfig): Promise<Subject[]> {
  const { text, about } = target;
  const context = { kind: 'text', ...(about ? { about } : {}) };
  const frame: Frame = {
    text,
    whole: { texts: [{ name: 'the text', text, tier: 0 }], build: ([whole]) => ({ ...context, text: whole! }) },
    opening: { texts: [], build: (part, note) => ({ ...context, note, text: part }) },
  };
  return partSubjects(await rulesFound(host, config, { metadata: false }), `text:${truncate(text, 40)}`, frame, about);
}

// a subject the rules read: the texts of its whole state, and the text split into parts when that state does not fit,
// the opening part judged beside the texts the rest of the subject carries (its thread), fit into what the part leaves
type Frame = {
  text: string;
  whole: { texts: Text[]; build: (texts: string[]) => Record<string, unknown> };
  opening: { texts: Text[]; build: (part: string, note: string, texts: string[]) => Record<string, unknown> };
};

// what a part's note and place may cost beyond its frame: its number, count and the headings it names
const NOTE_ROOM = 256;

// the rules judge a subject as the context of a batched rank, beside the rules as its items. one subject when the text
// fits that context, otherwise one per part, so every character is judged. the opening part (where a title is) carries the
// rest of the subject and is judged against every rule, a rule about the whole text among them; each later part against
// what a part can break, named by its place and headings. whatever is still cut to fit, a thread comment, is named
function partSubjects(found: Found, ref: string, frame: Frame, about: string | undefined): Subject[] {
  const named = about ? ` (${about})` : '';
  const whole = fitTexts(frame.whole.texts, frame.whole.build, CONTEXT_ROOM);
  const main = new Set(frame.whole.texts.filter((t) => (t.tier ?? 0) === 0).map((t) => t.name));
  if (!whole.cuts.some((c) => main.has(c.name))) return [withCuts(rulesOf(found, ref, whole.state, `The subject${named}`, {}), whole.cuts)];
  const empty = frame.opening.texts.map(() => '');
  const fixed = Math.max(estimateTokensOf(frame.opening.build('', '', empty)), estimateTokensOf({ kind: 'section', ...(about ? { about } : {}), note: '', text: '' }));
  const parts = partsOf(frame.text, CONTEXT_ROOM - fixed - NOTE_ROOM, textTokens);
  const of = `a ${frame.text.length}-character text in ${parts.length} parts`;
  return parts.map((part, i) => {
    const name = partName(part, i, parts.length);
    if (i === 0) {
      const note = `the opening of ${of}, judged against every rule, the rules about the whole text among them; the parts after it are judged on their own`;
      const opening = fitTexts([{ name: `the opening, ${name}`, text: part.text, tier: 0 }, ...frame.opening.texts], ([text, ...rest]) => frame.opening.build(text!, note, rest), CONTEXT_ROOM);
      return withCuts(rulesOf(found, ref, opening.state, `The opening, ${name}, of the subject${named}`, { part: `the opening, ${name}` }), opening.cuts);
    }
    const note = `${name} of ${of}, judged on its own; the opening is judged against the rules about the whole text`;
    const section = fitTexts([{ name, text: part.text }], ([text]) => ({ kind: 'section', ...(about ? { about } : {}), note, text: text! }), CONTEXT_ROOM);
    return withCuts(rulesOf(found, ref, section.state, `${name[0]!.toUpperCase()}${name.slice(1)} of the subject${named}`, { part: name, section: true }), section.cuts);
  });
}

function withCuts(subject: Subject, cuts: Cut[]): Subject {
  return cuts.length > 0 ? { ...subject, cuts } : subject;
}

// outside: the rules found that do not govern the subject
type Found = { rules: Rule[]; total: number; outside: number; discovery: Discovery };

async function rulesFound(host: RulesHost, config: RepoConfig, target: RuleTarget): Promise<Found> {
  const discovery = await host.discoveries.discover(host.source, config.rules);
  const rules = discovery.rules.filter((r) => governs(r, target));
  const total = rules.length;
  rules.splice(config.rules.maxRules);
  return { rules, total, outside: discovery.rules.length - total, discovery };
}

function rulesOf(found: Found, ref: string, subject: Record<string, unknown>, label: string, facts: Record<string, unknown>): Subject {
  const { rules, total, outside, discovery } = found;
  return {
    kind: 'rules',
    ref,
    state: { subject },
    facts: {
      rules,
      has_rules: rules.length > 0,
      total_rules: total,
      outside_rules: outside,
      docs: discovery.docs,
      candidates: discovery.candidates,
      kept: discovery.kept,
      cached: discovery.cached,
      subject: label,
      ...facts,
    },
    options: {},
    ...(discovery.pending !== undefined ? { judgeError: discovery.pending, pending: discovery.pending, settled: settledOf(discovery) } : discovery.error !== undefined ? { judgeError: `rule discovery: ${discovery.error}` } : {}),
  };
}

// why a running discovery failed once it lands, undefined when it found the rules
function settledOf(discovery: Discovery): Promise<string | undefined> | undefined {
  return discovery.settled?.then(
    (d) => (d.error !== undefined ? `rule discovery: ${d.error}` : undefined),
    (error: unknown) => `rule discovery: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// a plan for an issue: the issue's title and body beside the plan text, so the judge reads the plan against what was asked.
// the body and plan share the state evenly when both do not fit. a number that names a pull request is refused with the
// pack that was asked and the forms of an issue named
export async function planSubject(forge: Forge, repo: string, n: number, plan: string, pack: string): Promise<Subject> {
  const issue = await forge.issue(repo, n);
  if (issue.pr) throw refusal({ pack, kind: 'issue' }, `#${n}`, `subject is ${repo}#${n}, a pull request, not an issue`, forge);
  const fit = fitTexts(
    [
      { name: 'the issue body', text: issue.body },
      { name: 'the plan', text: plan },
    ],
    ([body, fitted]) => ({ repo, number: n, issue: { title: issue.title, body: body! }, plan: fitted! }),
  );
  return withCuts({ kind: 'plan', ref: `${repo}#${n}`, state: fit.state, facts: { has_plan: plan.trim().length > 0 }, options: {} }, fit.cuts);
}

// text about to be written, and what it is written about: the text takes room first
export function textSubject(text: string, context?: string): Subject {
  const fit = fitTexts(
    [
      { name: 'the text', text, tier: 0 },
      { name: 'its context', text: context ?? '', tier: 1 },
    ],
    ([t, c]) => ({ text: t!, context: context ? c! : null }),
  );
  return withCuts({ kind: 'text', ref: truncate(text, 40), state: fit.state, facts: {}, options: {} }, fit.cuts);
}

export function commitsOf(subject: Subject): ParsedCommit[] {
  return (subject.facts['commits'] as ParsedCommit[] | undefined) ?? [];
}
