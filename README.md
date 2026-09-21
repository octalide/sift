# sift

A Claude Code function-hook plugin that makes typed judgement calls where a session would otherwise spend a model turn, or spend context it does not need.

It asks one of two backends a set of typed questions about some state and gets back probabilities, never prose:

- **Jev** (TypeSafe's System One model) when `TYPESAFE_API_KEY` is set. Sub-second, cheap, calibrated.
- **the session's small model** (`haiku` by default) otherwise, through the engine's own client. Slower and less calibrated, but it needs no extra account.

Everything sift does is built on that one call. Every module is a toggle, every module logs what it decided, and every module falls back to the engine's normal behaviour when the judge is unavailable. Correctness never depends on the judge.

## Modules

| module | hook | what it does | default |
|---|---|---|---|
| `compact` | `session.compact` | replaces the compaction summary with the transcript minus the tool calls and results the judge marks stale. User and assistant text is never touched. A session with a ledger file compacts to the ledger instead, see [Compaction](#compaction) | on |
| `prune` | `tool.call` (post) | scores long Bash and Read output in chunks before the model reads it, drops the chunks that are not needed and leaves a one-line note in their place with the omitted line range and how to get it back (re-read the file by range for Read, rerun the command for Bash). Nothing is kept on disk | on |
| `grade` | registered tools | `mcp__sift__grade` runs a pack (issue, pr, commit, release, rules, or a repo-defined one) and `mcp__sift__judge` answers raw typed questions | on |
| `watch` | `clock` + `prompt.submit` | polls a GitHub repo for issues, PRs, comments, edits, labels and CI, settles what it can by rules, asks the judge about the rest, and delivers actionable events as prompts | off |
| `message` | `session.receive` | judges every message from another session before it is queued: nothing actionable is held into a digest line that rides with the next delivery or prompt, the rest arrives with its scores on the first line | off |
| `gateOutbound` | `tool.call` (pre) | checks text about to leave the session (a Discord message, a `gh pr`, `gh issue` or `gh release` create, comment or edit body) against the channel's length limit and the repository rule documents, and denies a broken rule | off |
| `classify` | `model.classify` | answers the engine's own small classifications from the judge | off |

`shadow: true` makes every module log what it would have done without doing it. Use it to calibrate thresholds against your own traffic before trusting them.

## Install

Function hooks are early access and must be switched on:

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
export TYPESAFE_API_KEY=...        # optional, the model backend is used without it

git clone https://github.com/octalide/sift
claude --plugin-dir ./sift
```

Or as a marketplace install:

```sh
claude plugin marketplace add octalide/sift
claude plugin install sift@sift
```

Options live in `/config` under the plugin, or in `settings.json` under `pluginConfigs.sift.options` (`pluginConfigs["sift@inline"]` for a `--plugin-dir` load). Every option is described in `.claude-plugin/plugin.json`. To give one kind of session different options (a watcher session, say), pass a settings file at launch:

```sh
claude --plugin-dir ./sift --settings '{"pluginConfigs":{"sift@inline":{"options":{"watch":true}}}}'
```

`/sift` prints status and per-module decision counts (the same text is available to the model as the `mcp__sift__status` tool), with this session's decisions and failures separate from the ring shared by every session running the plugin, and a cost line: judge tokens in and out (the backend's own count when it reports one, an estimate otherwise) against context tokens removed by compaction and pruning, per session and per module. A module that fell back to the built-in behaviour since the last prompt says so once as context beside the next prompt, so a failing backend is visible while it fails and not as a count afterwards. `/sift log [n]` the recent decisions with their scores, `/sift watch status|start|poll|pause|resume|reset|deferred` controls the watcher (also the `mcp__sift__watch` tool). The `watch` option starts it at boot; `start` arms it in a session that came up without it.

## Compaction

Without a ledger, `compact` keeps every user and assistant text and asks the judge, call by call, whether a tool call and its full output still matter for the last three prompts. That suits a conversation, whose narrative is the state. It does not suit a long-lived agent session: text accumulates across rounds because nothing ever removes it, so each compaction starts from the residue of the last and the interval between compactions shrinks until the session spends its time compacting.

An agent whose durable state lives outside the conversation (a ledger file, issues, git) has no narrative worth keeping. For such a session the policy changes. It applies while the ledger file exists: the `ledgerPath` option, or by default `~/.local/state/fleet/<owner>_<name>/ledger.md` for the session's repository, checked at each compaction.

1. No prior compaction summary is carried. Every built-in summary message and every ledger message an earlier round inserted is dropped before anything is judged, so the residue is bounded by the ledger, not by history.
2. The kept set is the ledger's current contents, re-read from disk and inserted as the first message so the model sees the live state, the last user prompt, the pinned recent messages (`compactPinRecent`), and the tool calls and results the judge marks as the working set of the item in flight, judged against the prompt and the ledger. Everything else drops, text included. A kept call is rebuilt without the narration around it.
3. One question over the ledger alone decides whether anything is mid-item. When nothing is (every item finished, unstarted, or waiting on an outside event), the judge is not asked about the transcript at all and only the ledger, the last prompt and the pinned messages remain. That is a restart without a process restart.
4. Each compaction records one line in the decision log (`/sift log`): `ledger: tokens <before> -> <after>, residue <n>, summaries dropped <n>, in flight yes|no, kept <messages>, <calls>, <requests>`. `residue` is what survived outside the ledger, the prompt and the pinned messages, the part that could grow. Whether it does is one grep.

A call stays when its `keep_` probability reaches `compactKeepThreshold`, default 0.35. Jev's keep signal is low and narrow: replayed over a long agent session, the calls of the item in flight score 0.35 to 0.45 and stale ones about 0.2, so a threshold of 0.5 keeps nothing and every compaction becomes a full restart. Calibrate against your own traffic with `shadow` before moving it.

`compactMinReduction` does not apply under a ledger: the built-in summary is never a better outcome for such a session. A judge failure still falls back to it, and the next ledger compaction drops that summary again.

## Grading

The tools are registered as `mcp__sift__grade` and `mcp__sift__judge`.

```
grade(pack: "pr", subject: "42")
grade(pack: "issue", subject: "17")
grade(pack: "commit", subject: "main..HEAD")
grade(pack: "release", subject: "v1.4.0")      # or "release" for the required bump alone
grade(pack: "release", subject: "v1.4.0", repo: "o/r", ref: "dev")  # any repo, no checkout needed
grade(pack: "rules", subject: "42")            # a PR against the repo's rule documents
grade(pack: "rules", subject: "x", text: "...") # free text against the rules
```

A report has three parts: mechanical findings (labels, milestone, template sections, linked issue, target branch, CI, conventional commit format, required semver bump, changelog), judged findings (each with its probability and a band: satisfied, unclear, violated), and a verdict (pass, warn, fail, or unknown when the judge was unavailable).

`judge(state, questions)` is the raw call for anything a pack does not cover:

```json
{
  "state": { "message": "deploy failed twice, customers see 500s" },
  "questions": {
    "urgent": { "type": "noul", "instructions": "This needs attention right now." },
    "owner": { "type": "choice", "instructions": "Who should handle it?", "criteria": { "infra": "...", "app": "..." } },
    "severity": { "type": "score", "instructions": "How bad is it?", "criteria": ["cosmetic", "degraded", "down"] }
  }
}
```

Other plugins can call the same thing through `$.sift.judge` and `$.sift.grade` (typed in `types/sift.d.ts`).

## Repo configuration

Conventions are read from `.sift/config.json` in the repository. The defaults are neutral: no commit format, label, template, version or changelog check runs until it is configured. Out of the box sift reads CONTRIBUTING.md, CLAUDE.md, AGENTS.md and the PR template as rule documents, treats the default branch as protected, and otherwise relies on the judged questions, which hold for any project. Every mechanical check is opt-in, so there is nothing to switch off.

To apply one set of conventions across many repos, set the `config` option to a path or inline JSON of the same shape. It sits under each repo's own file, field by field. A strict setup for a conventional-commits, semver-tagged, `dev` into `main` workflow looks like this:

```json
{
  "commits": { "convention": "conventional", "scope": "issue", "forbidTrailers": ["Co-Authored-By"] },
  "branches": { "protected": ["main", "dev"], "pattern": "^(feat|fix|chore|hotfix)/\\d+$" },
  "issues": { "requiredLabelGroups": [["bug", "feat", "docs", "chore"]], "milestone": true, "templateSections": ["Summary", "Acceptance"], "childLabels": ["task"] },
  "prs": { "linkIssue": true, "target": "dev", "templateSections": ["Summary", "Testing"] },
  "rules": { "docs": ["CONTRIBUTING.md", "CLAUDE.md", "briar-systems/mach-std:MIGRATION.md@v6.0.0"], "maxRules": 200 },
  "release": {
    "scheme": "semver",
    "changelog": "CHANGELOG.md",
    "tagPrefix": "v",
    "zeroVerBreaking": "minor",
    "manifests": [{ "path": "mach.toml", "keys": ["^project\\.mach$", "^dep\\.[^.]+\\.(git|ref)$"], "bump": "minor" }]
  }
}
```

A release grade reads the checkout when the session is inside the repo being graded (`ref` defaults to `HEAD`, and the working tree stands in for it so an uncommitted changelog promotion is graded before the commit). For any other repo, or from a directory that is no checkout, it reads GitHub: tags, the compare between the last tag and `ref`, and the manifest and changelog contents at each end. `ref` then defaults to the configured `prs.target` and otherwise to the default branch.

`issues.requiredLabelGroups` lists label groups, one label from each required (`[["bug", "enhancement", "documentation"]]` asks for a type label). `issues.templateSections` names the second-level headings the body must carry with content under each. `issues.childLabels` marks labels whose issues must be a native sub-issue of a parent (the `issues/N/parent` link, not a body mention). `issues.milestone` requires one. These run in `grade issue` and, when the watch is on, on every new issue as it is filed, the watching session's own included: an issue that fails any of them is delivered with a `filing:` line naming the findings, whoever filed it. A family that files with the default GitHub labels and a two-section template would set:

```json
"issues": { "requiredLabelGroups": [["bug", "enhancement", "documentation"]], "templateSections": ["Problem", "Fix"], "childLabels": ["task"], "milestone": false }
```

`release.scheme` turns on version checking (`semver` is the only scheme today). `release.changelog` names the file whose top section must cover the commits. Leave either out and the release pack only judges the commits since the last tag.

`release.zeroVerBreaking` is what a breaking change requires while the version is below 1.0.0 (`minor` by default, `major` to cut 1.0.0 on the first one). `release.manifests` lists files whose changes are release-worthy on their own, commit types aside: each entry names a TOML file, regexes over its dotted keys (`project.mach`, `dep.std.ref`) and the bump a change to one of them requires. The manifest at the last tag is compared with the one at `HEAD`, so a version line that the release itself moves is not matched unless a key pattern names it. The required bump is the higher of the commit bump and the manifest bump, and `release.bump` says which keys moved.

## Outbound text

With `gateOutbound: true` the text a tool call is about to send is checked before the call runs: Discord `send_message`, `send_dm`, `edit_message`, `send_webhook_message`, `create_forum_post` content and embed text, and the body of `gh pr|issue|release create|comment|edit` in a Bash command: the `--body`/`-b` value, quoted or in a `$(cat <<'EOF' ... EOF)` heredoc, or the file named by `--body-file`/`-F`, read before the command runs. A body from stdin (`--body-file -`) or an unreadable file is denied without a judge call. The channel's hard limit is mechanical (2000 characters for Discord) and denies without a judge call. The rules pack then runs over the text with the same rule documents as `grade rules`, each question naming what the text is (`The subject (the body of a new GitHub issue) complies with this rule: ...`) so a rule written for another artifact, a pull request rule against an issue body, is answered as not applying rather than broken: a violated rule denies with the rule quoted, an unclear one logs a warning, and the judge being unavailable allows. `shadow` logs what would have been denied.

## Messages

With `message: true` every peer delivery (another session's `SendMessage`) goes through the `message` pack before it is queued. The pack asks `actionable`, `kind` (question, task, result, blocked, status, noise) and `urgency`, and when the text references a pull request or issue (`https://github.com/o/r/pull/18`, `o/r#18`, or `#18` against the session's repo) sift fetches the item (body, checks, diff excerpt) and asks two more: `measured`, whether the claims are backed by something run or observed, and `evidenced`, whether the item itself carries that evidence. A message in the violated `actionable` band is consumed and held; the next delivered message or prompt carries `held meanwhile (n): <from>: <first line> [scores]`. Everything else arrives as sent with `[sift message from <name>] actionable 0.91, kind result, urgency soon, measured 0.40, evidenced 0.20` above it. The judge being unavailable delivers untouched, and `shadow` delivers with `(shadow: would hold)`.

The same pack is available by hand: `grade(pack: "message", subject: "x", text: "<message>")`.

## Packs

A pack is data: a subject kind, a list of mechanical checks, and typed questions with thresholds. The built-in packs are in `src/packs/builtin.ts`. A repo overrides or adds one with `.sift/packs/<name>.json` in the same shape:

```json
{
  "subject": "pr",
  "description": "House rules for pull requests",
  "checks": ["pr.linked", "pr.target", "pr.commits"],
  "questions": {
    "workaround": {
      "type": "noul",
      "instructions": "The diff patches a symptom rather than its cause.",
      "inverted": true,
      "severity": "fail",
      "lo": 0.3,
      "hi": 0.6
    }
  }
}
```

`rules.docs` entries are paths in the checkout or `owner/repo:path[@ref]` read from GitHub, so a consumer PR can be graded against another repo's migration guide at a tag. Each paragraph or list item is one rule, and each row of a markdown table is one rule with its cells named by the header (`5.x: sort.sort[T](data, len, cmp); 6.0.0: sort.sort[T](data, len)`). Rules past `rules.maxRules` are dropped and `rules.present` says so. A pack with more questions than one request holds goes out in several, the subject repeated in each.

A noul's optional `criteria` is Jev's shape, `{ "true": "...", "false": "..." }`, saying what a yes and a no mean. A choice's `criteria` maps keys to descriptions, a score's is an ordered list of legends.

Question fields beyond Jev's own: `lo` and `hi` set the band thresholds (default 0.35 and 0.65), `severity` says what a violated band means for the verdict (`fail`, `warn`, `info`), `inverted` marks a noul whose high probability is the bad outcome, `when` names a subject fact that must be truthy for the question to be asked, and `options` names a runtime option set for a choice (`open_issues`, `type_labels`, `commit_types`). A pack may also carry `expand` to generate one question per entry of a subject list, which is how the rules pack turns every paragraph of CONTRIBUTING.md into a proposition.

Subject kinds and the checks they support:

| subject | checks |
|---|---|
| `issue` | `issue.labels`, `issue.milestone`, `issue.template`, `issue.parent` |
| `pr` | `pr.linked`, `pr.target`, `pr.branch`, `pr.ci`, `pr.template`, `pr.commits` |
| `commit` | `commit.format` |
| `release` | `release.commits`, `release.bump`, `release.changelog` |
| `rules` | `rules.present` |
| `event`, `text`, `command`, `message` | none |

## Watch

With `watch: true` the plugin polls the session's repository (or `watchRepo`) with conditional requests, so idle polls are free, and adapts the interval between `watchMinInterval` and `watchMaxInterval`. Every change is one event. Rules settle what needs no judgement: a PR whose checks have all finished delivers once as `ci settled <conclusion>` (pass or fail, even when you pushed the commit), runs on other branches deliver on failure when the branch is protected or matches the work branch pattern and defer on success, bot activity drops, your own writes defer (`watchIgnoreSelf`, keyed on the `gh` login), new PRs deliver, a new issue is checked against the issue pack and delivers with its findings when it fails one (own writes otherwise defer under `watchIgnoreSelf`), label churn defers. Everything else goes through the `triage` pack, and an event whose `actionable` lands in the violated band is deferred.

A delivery is one prompt:

```
[sift watch octalide/sift]
issue #41 comments 2->3: watcher misses review comments
  by alice · https://github.com/octalide/sift/issues/41 · actionable 0.93, kind question, urgency now
deferred meanwhile: 2 housekeeping, 1 ci success
```

A settled PR is one line with the aggregate verdict, so a steward waiting to grade, mark ready and merge needs no `gh pr checks` loop of its own:

```
[sift watch octalide/sift]
ci settled success: pr #14 feat/14 @3f2a9c1: Watch delivers a settled CI verdict (3 checks)
  by octalide · https://github.com/octalide/sift/pull/14 · ci settled on pr
```

The verdict counts every check run and commit status on the PR's head, so it waits for external checks too. Until the last one finishes the individual runs are held in the digest, named by PR, and a head that never settles ages out with them.

Deferred events ride along as a digest on the next delivery, and any deferred event older than `watchDeferMaxAgeHours` is delivered on its own. `watchDelivery: "log"` writes transcript lines instead of prompts. The cursor, item cache and deferred list live in the plugin store, so a restart picks up where it left off.

## Calibration

Nothing here is measured on your traffic until you measure it. Turn on `shadow`, run for a while, then `/sift log 200` shows every decision with the probabilities behind it. Adjust `lo`, `hi` and the keep thresholds from what you see, then turn shadow off. The Jev backend is the one worth calibrating: its uncertainty band is real, and the modules treat `unclear` as "do the safe thing" (deliver, keep, deny) on purpose.

## Development

```sh
npm install
npm run typecheck      # src and hooks, hooks against types/claude-code.d.ts
npm test               # vitest, pure logic only
npm run validate       # claude plugin validate
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

`types/claude-code.d.ts` is the engine's generated declaration. Regenerate it with `/plugin-types` after a Claude Code upgrade and rerun the typecheck. The function-hook surface is early access and changes between releases.

## Caveats

- Jev is in early access. Join the waitlist at typesafe.ai. Without a key the model backend works but is slower, costs model tokens, and its probabilities are stated, not calibrated.
- The prune and compact modules estimate tokens without a tokenizer, with a rule calibrated against Jev's reported usage (from fast-jev-compaction, MIT). Compact fits the whole history into Jev's 32k state limit by shrinking old messages in stages, every call staying visible; a session past roughly 1200 tool calls falls back to the built-in summary. A size rejection from Jev triggers one retry at half the budget.
