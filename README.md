# sift

A Claude Code function-hook plugin that makes typed judgement calls where a session would otherwise spend a model turn, or spend context it does not need.

It asks one of two backends a set of typed questions about some state and gets back probabilities, never prose:

- **Jev** (TypeSafe's System One model) when `TYPESAFE_API_KEY` is set. Sub-second, cheap, calibrated.
- **the session's small model** (`haiku` by default) otherwise, through the engine's own client. Slower and less calibrated, but it needs no extra account.

Everything sift does is built on that one call. Every module is a toggle, every module logs what it decided, and every module falls back to the engine's normal behaviour when the judge is unavailable. Correctness never depends on the judge.

## Modules

| module | hook | what it does | default |
|---|---|---|---|
| `compact` | `session.compact` | replaces the compaction summary with the transcript minus the tool calls and results the judge marks stale. User and assistant text is never touched | on |
| `prune` | `tool.call` (post) | scores long Bash and Read output in chunks before the model reads it, drops the chunks that are not needed, archives the full output under `~/.cache/sift/<session>/` and leaves a recovery note in the stub | on |
| `grade` | registered tools | `mcp__sift__grade` runs a pack (issue, pr, commit, release, rules, or a repo-defined one) and `mcp__sift__judge` answers raw typed questions | on |
| `watch` | `clock` + `prompt.submit` | polls a GitHub repo for issues, PRs, comments, edits, labels and CI, settles what it can by rules, asks the judge about the rest, and delivers actionable events as prompts | off |
| `gate` | `tool.call` (pre) | judges Bash, Write and Edit calls against safety propositions and denies on a violated band | off |
| `classify` | `model.classify` | answers the engine's own small classifications from the judge | off |
| `route` | `turn.step` | lowers request effort for prompts the judge scores as routine | off |

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

`/sift` prints status and per-module decision counts (the same text is available to the model as the `mcp__sift__status` tool), `/sift log [n]` the recent decisions with their scores, `/sift watch status|start|poll|pause|resume|reset|deferred` controls the watcher (also the `mcp__sift__watch` tool). The `watch` option starts it at boot; `start` arms it in a session that came up without it.

## Grading

The tools are registered as `mcp__sift__grade` and `mcp__sift__judge`.

```
grade(pack: "pr", subject: "42")
grade(pack: "issue", subject: "17")
grade(pack: "commit", subject: "main..HEAD")
grade(pack: "release", subject: "v1.4.0")      # or "release" for the required bump alone
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

Conventions are read from `.sift/config.json` in the repository. Everything is optional. With no file, sift checks conventional commit format, reads CONTRIBUTING.md, CLAUDE.md, AGENTS.md and the PR template as rule documents, and treats the default branch as protected.

```json
{
  "commits": { "convention": "conventional", "scope": "issue", "forbidTrailers": ["Co-Authored-By"] },
  "branches": { "protected": ["main", "dev"], "pattern": "^(feat|fix|chore|hotfix)/\\d+$" },
  "issues": { "requiredLabelGroups": [["bug", "feat", "docs", "chore"]], "milestone": true, "templateSections": ["Summary", "Acceptance"], "childLabels": ["task"] },
  "prs": { "linkIssue": true, "target": "dev", "templateSections": ["Summary", "Testing"] },
  "rules": { "docs": ["CONTRIBUTING.md", "CLAUDE.md"] },
  "release": { "changelog": "CHANGELOG.md", "tagPrefix": "v" }
}
```

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
| `event`, `text`, `command` | none |

## Watch

With `watch: true` the plugin polls the session's repository (or `watchRepo`) with conditional requests, so idle polls are free, and adapts the interval between `watchMinInterval` and `watchMaxInterval`. Every change is one event. Rules settle what needs no judgement: CI failures on protected branches deliver, CI successes defer, bot activity drops, your own writes defer (`watchIgnoreSelf`, keyed on the `gh` login), new PRs deliver, label churn defers. Everything else goes through the `triage` pack, and an event whose `actionable` lands in the violated band is deferred.

A delivery is one prompt:

```
[sift watch octalide/sift]
issue #41 comments 2->3: watcher misses review comments
  by alice · https://github.com/octalide/sift/issues/41 · actionable 0.93, kind question, urgency now
deferred meanwhile: 2 housekeeping, 1 ci success
```

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
- The prune and compact modules estimate tokens by character count.
- The gate never sends a command that mentions a credential to the judge, and it is off by default. It is a second opinion, not a sandbox.
- `route` is experimental and off by default.
