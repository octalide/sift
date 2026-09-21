# sift

A Claude Code function-hook plugin that makes typed judgement calls where a session would otherwise spend a model turn, or spend context it does not need.

It asks one of two backends a set of typed questions about some state and gets back probabilities, never prose:

- **Jev** (TypeSafe's System One model) when `TYPESAFE_API_KEY` is set. Sub-second, cheap, calibrated.
- **the session's small model** (`haiku` by default) otherwise, through the engine's own client. Slower and less calibrated, but it needs no extra account.

Everything sift does is built on that one call, directly or through `rank`, which asks the same questions of many items at once. Every module is a toggle, every module logs what it decided, and every module falls back to the engine's normal behaviour when the judge is unavailable. Correctness never depends on the judge.

## Modules

| module | hook | what it does | default |
|---|---|---|---|
| `prune` | `tool.call` (post) | scores long Bash and Read output in chunks before the model reads it, drops the chunks that are not needed and leaves a one-line note in their place with the omitted line range and how to get it back (re-read the file by range for Read, rerun the command for Bash). Nothing is kept on disk | on |
| `grade` | registered tools | `mcp__sift__grade` runs a pack (issue, pr, commit, release, rules, locate, plan, or a repo-defined one), `mcp__sift__judge` answers raw typed questions and `mcp__sift__rank` asks the same questions of many items | on |
| `watch` | `clock` + `prompt.submit` | polls a GitHub repo for issues, PRs, comments, edits, labels and CI, settles what it can by rules, asks the judge about the rest, and delivers actionable events as prompts | off |
| `gateOutbound` | `tool.call` (pre) | checks text about to leave the session through a channel table (Discord messages and `gh pr|issue|release` bodies by default, more by config) against the channel's length limit and the repository rule documents, and denies a broken rule | off |
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

`/sift` prints status and per-module decision counts (the same text is available to the model as the `mcp__sift__status` tool), with this session's decisions and failures separate from the ring shared by every session running the plugin, and a cost line: judge tokens in and out (the backend's own count when it reports one, an estimate otherwise) against context tokens removed by pruning, per session and per module. A module that fell back to the built-in behaviour since the last prompt says so once as context beside the next prompt, so a failing backend is visible while it fails and not as a count afterwards. `/sift log [n]` the recent decisions with their scores, `/sift watch status|start|poll|pause|resume|reset|deferred` controls the watcher (also the `mcp__sift__watch` tool). The `watch` option starts it at boot; `start` arms it in a session that came up without it.

## Grading

The tools are registered as `mcp__sift__grade`, `mcp__sift__judge` and `mcp__sift__rank`.

```
grade(pack: "pr", subject: "42")               # or "#42", or the PR's URL
grade(pack: "issue", subject: "17")            # or "#17", or an issue URL, which may name another repo
grade(pack: "commit", subject: "main..HEAD")
grade(pack: "release", subject: "v1.4.0")      # or "release" for the required bump alone
grade(pack: "release", subject: "v1.4.0", repo: "o/r", ref: "dev")  # any repo, no checkout needed
grade(pack: "rules", subject: "42")            # a PR against the repo's rule documents
grade(pack: "rules", subject: "x", text: "...") # free text against the rules
grade(pack: "locate", subject: "17")           # the files to read or change for issue 17, top 20 per level
grade(pack: "locate", subject: "x", text: "...", top: 10)  # the same for free text
grade(pack: "plan", subject: "17", text: "...")   # a plan for issue 17: covers it, adds nothing, decides nothing it leaves open
```

The subject is parsed before anything is fetched: `issue` and `pr` take a number as `N` or `#N`, or an issue or pull request URL in the code host's own shape (the repo in the URL is the one read, so a URL of another repo needs no `repo`), `commit` takes a ref or range, `release` takes a tag or `release`. A missing subject, a title or body pasted as one, or a URL of the wrong kind is refused with the expected form named.

A report has three parts: mechanical findings (labels, milestone, template sections, linked issue, target branch, CI, commit format and scope, required version bump, changelog), judged findings (each with its probability and a band: satisfied, unclear, violated), and a verdict (pass, warn, fail, or unknown when the judge was unavailable).

The `issue` pack asks whether the body is substantive, which type label fits, whether the change stays in this repository, whether it needs a parent, which open issue it duplicates, whether it is `implementable` (a competent engineer could build it without making a decision the body does not make: two valid designs, an unnamed interface, an unstated edge behaviour all fail it), whether its scope is clear enough to reject an unrelated change, which open issue it is `blocked_by` (`none` unless the title or body says so, or the same code must change there first), and how ready it is. A violated `implementable` fails the report.

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

`rank(items, questions, mode)` asks the same questions of every item in a list and returns the items in input order with their answers, plus a view sorted by one question (`by`, the first question when absent, a choice question by its `choice` key's probability). Items are strings or objects. In a question, `{k}` stands for the item's index, `{text}` for a string item and `{field}` for a field of an object item. `context` is state every item is read against.

```json
{
  "items": ["progress 12%", "Error: boom at line 120", "progress 13%"],
  "questions": { "needed": { "type": "noul", "instructions": "Line {k} ({text}) is needed to answer the user." } },
  "mode": "batched",
  "context": { "task": "why did the build fail?" }
}
```

Two modes, both Jev shapes. `batched` fills each request with as many items as fit under the 32k state and 64k request limits and asks one question set per item, so items can see each other and a list costs as few requests as possible. `isolated` sends one request per item, run concurrently, so no item colours another. Prune is `rank` over output chunks and the rules pack is `rank` over the rule documents, so any pack or session that needs the relevant N of M is data over the same primitive.

Other plugins can call the same thing through `$.sift.judge`, `$.sift.rank` and `$.sift.grade` (typed in `types/sift.d.ts`).

## Repo configuration

Conventions are read from `.sift/config.json` in the repository. The defaults are neutral: no commit format, label, template, version or changelog check runs until it is configured. Out of the box sift reads CONTRIBUTING.md, CLAUDE.md, AGENTS.md and the PR template as rule documents, treats the default branch as protected, and otherwise relies on the judged questions, which hold for any project. Every mechanical check is opt-in, so there is nothing to switch off.

Three layers apply in order, each field by field over the last: the defaults, a global file, then the repository's `.sift/config.json`. The global file is `$XDG_CONFIG_HOME/sift/config.json` (`~/.config/sift/config.json` when `XDG_CONFIG_HOME` is unset) and is read when it exists. The `config` option, set to a path relative to the repo root or inline JSON of the same shape, takes the global file's place: when it is set the file is not read. Nothing below assumes a particular format: the presets are examples, and any commit or version convention is a regex. A strict setup for a conventional-commits, semver-tagged, `dev` into `main` workflow looks like this:

```json
{
  "commits": { "convention": "conventional", "scope": "issue", "forbidTrailers": ["Co-Authored-By"] },
  "branches": { "protected": ["main", "dev"], "pattern": "^(feat|fix|chore|hotfix)/\\d+$" },
  "issues": { "requiredLabelGroups": [["bug", "feat", "docs", "chore"]], "milestone": true, "templateSections": ["Summary", "Acceptance"], "childLabels": ["task"] },
  "prs": { "linkIssue": true, "targets": ["dev"], "templateSections": ["Summary", "Testing"] },
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

A release grade reads the checkout when the session is inside the repo being graded (`ref` defaults to `HEAD`, and the working tree stands in for it so an uncommitted changelog promotion is graded before the commit). For any other repo, or from a directory that is no checkout, it reads GitHub: tags, the compare between the last tag and `ref`, and the manifest and changelog contents at each end. `ref` then defaults to the first configured `prs.targets` entry and otherwise to the default branch.

`issues.requiredLabelGroups` lists label groups, one label from each required (`[["bug", "enhancement", "documentation"]]` asks for a type label). `issues.templateSections` names the second-level headings the body must carry with content under each. `issues.childLabels` marks labels whose issues must be a native sub-issue of a parent (the `issues/N/parent` link, not a body mention). `issues.milestone` requires one. These run in `grade issue` and, when the watch is on, on every new issue as it is filed, the watching session's own included: an issue that fails any of them is delivered with a `filing:` line naming the findings, whoever filed it. A family that files with the default GitHub labels and a two-section template would set:

```json
"issues": { "requiredLabelGroups": [["bug", "enhancement", "documentation"]], "templateSections": ["Problem", "Fix"], "childLabels": ["task"], "milestone": false }
```

`prs.linkIssue` requires a pull request to name its issue. The issue is found from the code host's own relation first (the issues a pull request closes), then from a closing keyword in the body (`Closes #N`), then from an issue number in the branch name (`feat/52`), and the first found is the one the judge reads the diff against. `prs.templateSections` works as `issues.templateSections` does.

### Conventions as regexes

Every convention is a regex string with named groups. A preset stands for one of them: it expands to its regex when the config resolves, and an explicit pattern beside a preset wins. Existing configs written with presets alone resolve exactly as before.

`commits.format` is matched against the subject line and names the groups `type`, `scope`, `breaking` (any match marks the commit breaking, as a `BREAKING CHANGE:` footer does) and `description`. The preset `commits.convention: "conventional"` is `^(?<type>\w+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s+(?<description>.+)$`. `none`, the default, runs no format check unless `format` is set. `commits.types` lists the values the `type` group may take, and a format without a `type` group skips that check. The same list is the choice set for the commit pack's `type_matches` question, so the judge names the type the diff warrants in the repository's own vocabulary.

`commits.scopePattern` is matched against the header's `type(scope)`, or the bare type when the commit has no scope, so a scope rule can except a type. The presets under `commits.scope` are `issue`, `^(chore\(.*\)|[^(]+(\(#\d+\))?)$` (a scope is optional, must be `#<n>` when present, and `chore` may carry any scope, as `chore(release): 1.2.0` does), `none`, `^[^(]*$` (no scope allowed), and `any`, the default, which runs no scope check.

`branches.pattern` is matched against a work branch name. `prs.targets` is either a list of branch names a PR may target or a regex the base branch must match; `prs.target: "dev"` from older configs reads as `targets: ["dev"]`.

`release.versionPattern` is matched against a version. Its numeric named groups, in order, order versions (which tag is the latest, whether a proposed version is newer), and the groups `major`, `minor` and `patch`, when named, are what a bump moves: the bumped group goes up, the lower ones go to zero, and anything after the last of them (a prerelease) is dropped. The presets under `release.scheme` are `semver`, `^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+(?<build>[0-9A-Za-z.-]+))?$`, and `calver`, `^(?<year>\d{4})\.(?<month>\d{1,2})(?:\.(?<micro>\d+))?$`. A calendar version has no `major`, so `release.bump` reports the bump the commits call for and requires a proposed version to be newer than the last tag rather than a particular step. A calendar layout shaped differently (`YY.MM`, `YYYY.MM.DD`) sets `versionPattern` outright.

`release.tagPattern` is matched against a tag and names the `version` group the version pattern then reads (the whole tag when it names none). It defaults to `release.tagPrefix` followed by the version, `^v(?<version>.+)$` out of the box. An invalid regex in any of these fields fails config resolution with the field named.

With no version pattern configured, no version is computed or checked. The tags are still ordered as semver to find the last release the pack reads commits from. `release.changelog` names the changelog file. No format is parsed: the file at the last tag is line-diffed against the file at the ref, `release.changelog` warns when nothing changed, and the judge is asked whether the added text describes the commits since the last tag. Leave either out and the release pack only judges the commits since the last tag.

`release.zeroVerBreaking` is what a breaking change requires while the version is below 1.0.0 (`minor` by default, `major` to cut 1.0.0 on the first one). `release.manifests` lists files whose changes are release-worthy on their own, commit types aside: each entry names a file, the bump a change to it requires, and what counts as a change: `keys`, regexes over the file's dotted paths when it is TOML, JSON or YAML by extension (`project.mach`, `dep.std.ref`, `dependencies.0.name` with arrays indexed numerically), or `pattern`, a regex over the file's text in any format whose matched text must not change (`"^ABI_VERSION\\s*=\\s*\\S+"` in a Makefile). Both can be given on one entry. The manifest at the last tag is compared with the one at `HEAD`, so a version line that the release itself moves is not matched unless a key or pattern names it. The required bump is the higher of the commit bump and the manifest bump, and `release.bump` says which keys moved.

## Outbound text

With `gateOutbound: true` the text a tool call is about to send is checked before the call runs. Where text leaves the session is a table of channels, one entry per place: a `name` a config entry replaces it by, a `tool` regex over the tool name, where the `text` is in the call, an optional hard `limit` in characters, and `kind`, what the text is in the words the rules question names it by. The text is either `{ "fields": [...] }`, the named fields of the tool input joined in order, or for a shell command `{ "command": <regex>, "body": [flags], "file": [flags] }`: the value after a body flag, a quoted word or a `$(cat <<'EOF' ... EOF)` heredoc, else the file named by a file flag, read before the command runs. A body from stdin (`--body-file -`) or an unreadable file is denied without a judge call. The first channel whose tool and text match decides.

The default table ships Discord (`send_message`, `edit_message`, `send_webhook_message` and `send_dm` content, `create_forum_post` content and embed text, 2000 characters each) and one entry per write the code host's cli makes: `gh pr|issue create|comment|edit` by `--body`/`-b` or `--body-file`/`-F` and `gh release create|edit` by `--notes`/`-n` or `--notes-file`/`-F`, named `github-pr-comment`, `github-release-create` and so on, each with its `kind` (`a comment on a pull request`, `the notes of a new GitHub release`). `outbound.channels` in the config adds entries to the table, or replaces a default entry of the same name:

```json
"outbound": {
  "channels": [
    { "name": "slack", "tool": "^mcp__slack__post_message$", "text": { "fields": ["text"] }, "limit": 40000, "kind": "a Slack message" },
    { "name": "gitlab-mr-note", "tool": "^Bash$", "text": { "command": "^glab\\s+mr\\s+note\\b", "body": ["--message", "-m"] }, "kind": "a note on a merge request" },
    { "name": "discord-message", "tool": "^mcp__discord__send_message$", "text": { "fields": ["content"] }, "limit": 1000, "kind": "a Discord message" }
  ]
}
```

The channel's limit is mechanical and denies without a judge call. The rules pack then runs over the text with the same rule documents as `grade rules`, each question naming the channel's `kind` (`The subject (the body of a new GitHub issue) complies with this rule: ...`) so a rule written for another artifact, a pull request rule against an issue body, is answered as not applying rather than broken: a violated rule denies with the rule quoted, an unclear one logs a warning, and the judge being unavailable allows. `shadow` logs what would have been denied.

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

Question fields beyond Jev's own: `lo` and `hi` set the band thresholds (default 0.35 and 0.65), `severity` says what a violated band means for the verdict (`fail`, `warn`, `info`), `inverted` marks a noul whose high probability is the bad outcome, `when` names a subject fact that must be truthy for the question to be asked, and `options` names a runtime option set for a choice (`open_issues`, `type_labels`, `commit_types`).

A pack may also carry `rank`, a list of steps run in order after the questions, each one `rank` over a subject list with the subject state as context. A step names the list (`from`, a subject fact), the `questions` asked of every item (`{field}` takes the item's field, `{subject}` the subject's label), `mode` (`batched` unless said), `by` (the question whose value orders and bands the items, the first unless said), `label` (the item field the report names it by), `list` (`each` prints every item in order, `top` the best `top` by value, 20 unless said or overridden by the grade call's `top`) and `within`: `{ "field": "dir", "of": "path" }` keeps only the items whose `dir` equals the `path` of an item the previous step did not rule out (a band other than violated), which makes steps hierarchical. The rules pack is one `each` step over the rule paragraphs; locate is two `top` steps, directories then the files within those not ruled out, so each rank reads only what could matter.

The `tree` subject is a text (an issue's title and body, or free text) over an index of the checkout built in code from `git ls-files`: every directory with its file count and a sample of names, every file with its first non-empty lines and the exported or top-level symbol names a per-extension regex finds. `node_modules` and similar trees, lockfiles, binaries by extension, files with nul bytes and files over 200 kB never enter it.

Subject kinds and the checks they support:

| subject | checks |
|---|---|
| `issue` | `issue.labels`, `issue.milestone`, `issue.template`, `issue.parent` |
| `pr` | `pr.linked`, `pr.target`, `pr.branch`, `pr.ci`, `pr.template`, `pr.commits` |
| `commit` | `commit.format` |
| `release` | `release.commits`, `release.bump`, `release.changelog` |
| `rules` | `rules.present` |
| `tree` | `tree.indexed` |
| `event`, `text`, `command` | none |

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

The verdict counts every check run and commit status on the PR's head, so it waits for external checks too. Until the last one finishes the individual runs are held in the digest, named by PR. A head whose checks have not all finished within `watchStallHours` (default 1) is delivered once as `ci stalled`, in the same shape, naming the checks still pending, so no session waits on a check that never reports. Heads are tracked from the moment their PR is open, so a check that never starts stalls too. The head is not delivered as stalled again unless a new commit lands on it, and a stalled head that does finish later still delivers its `ci settled` line:

```
[sift watch octalide/sift]
ci stalled: pr #14 feat/14 @3f2a9c1: Watch delivers a settled CI verdict (1 of 3 checks pending: deploy-preview)
  by octalide · https://github.com/octalide/sift/pull/14 · ci stalled on pr
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
- The prune module estimates tokens without a tokenizer, with a rule calibrated against Jev's reported usage (from fast-jev-compaction, MIT).
