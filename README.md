# sift

A Claude Code function-hook plugin that makes typed judgement calls where a session would otherwise spend a model turn, or spend context it does not need.

It asks one of two backends a set of typed questions about some state and gets back probabilities, never prose:

- **Jev** (TypeSafe's System One model) when `TYPESAFE_API_KEY` is set. Sub-second, cheap, calibrated.
- **the session's small model** (`haiku` by default) otherwise, through the engine's own client. Slower and less calibrated, but it needs no extra account.

Two primitives sit on that call: `judge`, typed questions over one state, and `rank`, the same questions over many items. Everything else is data over them. A pack is questions and checks over a repository subject (an issue, a pull request, a release, a job log, the file tree). The hooks that act inside a session (prune, the outbound gate, classify) and the repository watch are packs and ranks with a policy attached. Every module is a toggle, every module logs what it decided, and every module falls back to the engine's normal behaviour when the judge is unavailable. Correctness never depends on the judge.

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

Options live in `/config` under the plugin, or in `settings.json` under `pluginConfigs`, keyed by the full plugin id: `pluginConfigs["sift@sift"].options` for a marketplace install, `pluginConfigs["sift@inline"].options` for a `--plugin-dir` load. A key that names no installed plugin is read by nothing and reports no error, so `/sift` listing fewer modules than you set means the key is wrong. To give one kind of session different options (a watcher session, say), pass a settings file at launch:

```sh
claude --plugin-dir ./sift --settings '{"pluginConfigs":{"sift@inline":{"options":{"watch":true}}}}'
```

The full option list is under [Options](#options).

## Primitives

`judge(state, questions)` asks typed questions about one state. A question is a `noul` (a probability that a proposition holds), a `choice` (one key of a criteria map, with a probability per key) or a `score` (a position on an ordered list of legends). The answer is numbers, never text.

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

A noul's optional `criteria` is Jev's shape, `{ "true": "...", "false": "..." }`, saying what a yes and a no mean. A choice's `criteria` maps keys to descriptions, a score's is an ordered list of legends.

`rank(items, questions, mode)` asks the same questions of every item in a list and returns the items in input order with their answers, plus a view sorted by one question (`by`, the first question when absent, a choice question by its `choice` key's probability). Items are strings or objects. In a question, `{k}` stands for the item's index, `{text}` for a string item and `{field}` for a field of an object item. `context` is state every item is read against. `fields` names the item fields the state carries beside `k` (every field when absent). The others still fill the questions, so a text the question already quotes is not sent twice.

```json
{
  "items": ["progress 12%", "Error: boom at line 120", "progress 13%"],
  "questions": { "needed": { "type": "noul", "instructions": "Line {k} ({text}) is needed to answer the user." } },
  "mode": "batched",
  "context": { "task": "why did the build fail?" }
}
```

Two modes, both Jev shapes. `batched` fills each request with as many items as fit under the 32k state and 64k request limits and asks one question set per item, so items can see each other and a list costs as few requests as possible. `isolated` sends one request per item, run concurrently, so no item colours another. Prune is `rank` over output chunks, the rules pack is `rank` over the rule documents, locate is `rank` over the file tree, so any pack or session that needs the relevant N of M is data over the same primitive.

Other plugins reach the same calls through `$.sift.judge`, `$.sift.rank` and `$.sift.grade`, typed in `types/sift.d.ts`.

## Packs

A pack is data: a subject kind, a list of mechanical checks, typed questions with thresholds, and optionally rank steps. `grade(pack, subject)` builds the subject, runs the checks, ranks, asks the questions and returns a report. The built-in packs:

| pack | subject | what it answers |
|---|---|---|
| `issue` | an issue number or URL | is the issue well formed, correctly typed, scoped to this repo, implementable without a decision it does not make, and ready to work on |
| `pr` | a PR number or URL, or a `base..head` range | is the PR linked, targeted, named, templated, committed and checked as the repository requires, and has the base moved under it. Mechanical only, no judge call |
| `plan` | an issue number, the plan in `text` | does the plan cover the issue, add nothing beyond it, and decide nothing the issue leaves open; a warn means the plan lists its decisions in the PR body |
| `commit` | a ref or range | do the commit messages follow the repository's commit format. Mechanical only, no judge call |
| `ci` | a job id, a run id, or a log in `text` | why the job failed: the lines that explain it, then whether the change under test caused it, whether it is the environment, and whether the fix is in this repository |
| `rules` | an issue number or URL, or free text | does the subject comply with each rule the repository's rule documents state |
| `release` | a proposed version, or `release` | are the commits since the last tag safe to ship as described, and do the version bump and changelog agree with them |
| `triage` | a repository event | does this event need the session to act on it now, what kind is it, how urgent |
| `locate` | an issue number or URL, or free text in `text` | which files of the checkout must be read or changed to implement it |

```
grade(pack: "pr", subject: "42")               # or "#42", or the PR's URL
grade(pack: "pr", subject: "dev..HEAD")        # the PR this branch would open, graded before it exists
grade(pack: "issue", subject: "17")            # or "#17", or an issue URL, which may name another repo
grade(pack: "plan", subject: "17", text: "...")   # a plan for issue 17
grade(pack: "commit", subject: "main..HEAD")
grade(pack: "ci", subject: "job:106195824649")  # a failed job by id
grade(pack: "ci", subject: "35554549814")       # a run id (or run:<id>) reads its first failed job
grade(pack: "ci", subject: "x", text: "...")    # a log pasted as text
grade(pack: "rules", subject: "17")            # issue 17 against the repo's rule documents
grade(pack: "rules", subject: "x", text: "...") # free text against the rules, a commit message or PR body before it is written
grade(pack: "release", subject: "v1.4.0")      # or "release" for the required bump alone
grade(pack: "release", subject: "v1.4.0", repo: "o/r", ref: "dev")  # any repo, no checkout needed
grade(pack: "locate", subject: "17")           # the files to read or change for issue 17, top 20 per level
grade(pack: "locate", subject: "x", text: "...", top: 10)  # the same for free text
grade(pack: "commit", subject: "HEAD", cwd: "/src/other-42")  # HEAD of another checkout, under its conventions
```

The subject is parsed before anything is fetched: `issue` and `pr` take a number as `N` or `#N`, or an issue or pull request URL in the code host's own shape (the repo in the URL is the one read, so a URL of another repo needs no `repo`), `pr` also a range (`dev..HEAD`), `commit` takes a ref or range, `release` takes a tag or `release`. `locate` takes the same reference forms, a bare number naming an issue, or free text in `text`. `rules` takes an issue number or URL, or free text in `text`, and refuses a pull request or a commit with the forms it takes named: sift judges no diff. `ci` takes `job:<id>`, `run:<id>`, a bare run id, or the log in `text`. A missing subject, a title or body pasted as one, or a URL of the wrong kind is refused with the expected form named.

Every grade reads one checkout: `cwd` when the call passes it (an absolute path), otherwise the directory the calling subagent was spawned in when its Agent call set one (or its parent's), otherwise the session's repository. The checkout is the git toplevel of that directory, so a worktree grades its own HEAD and working tree, and it brings its repository, its `.sift/config.json` and its `.sift/packs`: the packs a grade can name and the conventions it checks against are that checkout's. `commit`, a `pr` range, `locate`, and `release` and `rules` when they read the checkout refuse a `repo` that is not the checkout's, naming both, rather than mix one repository's commits with another's name; pass the `cwd` of a checkout of that repository instead. Without `cwd`, a `release` or `rules` grade of another repository reads it from the forge as before. A subject read from the forge (an issue, a PR by number, a plan, a ci log, or a `release` or `rules` grade of another repository) is checked against the conventions of the repository it is in: the checkout's own when it is that repository, otherwise that repository's `.sift/config.json` at its default branch, read through the forge over the global layer. The repository a checkout names on the forge is looked up once per checkout, and its conventions and packs are reread when anything under `.sift/` changes.

A report has three parts: mechanical findings (labels, milestone, template sections, linked issue, target branch, CI, commit format and scope, drift, required version bump, changelog), judged findings (each with its probability and a band: satisfied, unclear, violated), and a verdict (pass, warn, fail, or unknown when the judge was unavailable). A pack with rank steps adds one list per step. A question the judge left unanswered is reported in the unclear band without an answer, and an answer under an id no question asked for is dropped and counted.

### pr

The `pr` pack is mechanical: it runs its checks and asks the judge nothing. The diff is read only to find drift and never reaches a judge. `pr.drift` warns with the files the PR touches that also changed on the base since the branch point (the merge base to the base head). It reports that the base moved, not whether the two patches collide. A `base..head` subject grades the same way from the checkout before the PR exists: the commits and drift come from `git`, the issue from the head branch name (a `(?<issue>)` group in `branches.pattern` names it, otherwise the number segment of `feat/52` or `52-title`), and the checks only a forge can answer (`pr.linked`, `pr.target`, `pr.ci`, `pr.template`) skip rather than fail.

### issue

The `issue` pack asks whether the body is substantive, which type label fits, whether the change stays in this repository, whether it needs a parent, which open issue it duplicates, whether it is `implementable` (a competent engineer could build it without making a decision the body does not make: two valid designs, an unnamed interface, an unstated edge behaviour all fail it), whether its scope is clear enough to reject an unrelated change, which open issue it is `blocked_by` (`none` unless the title or body says so, or the same code must change there first), and how ready it is. A violated `implementable` fails the report.

### plan

The `plan` pack reads an issue and a plan for it from `text` and asks three questions: `covers` (every point the issue asks for is met by a step, or the plan says why it is left out), `adds_nothing` (no step changes something the issue does not mention unless the change is needed to land one it does), and `decides_unasked` (no step settles something the issue leaves open that others will depend on: a new or changed public interface, a stored format, behaviour a caller outside the change depends on, a choice between two architectures; normalising an input, a collision or ordering rule inside one module, the wording of a message, or a test's shape are not decisions). A violated `covers` fails the report. A violated `adds_nothing` or `decides_unasked` warns: the plan goes ahead and lists its decisions in the PR body.

### ci

The `ci` pack reads a failing job's log: a job id (`job:<id>`), a run id (its first failed job) read through the forge, or the text itself. The log is trimmed in code to the step the forge marks failed (the tail of the whole log when none is), stripped of timestamps, colours and group marks, and bounded at 300 lines. One `top` rank step over the lines keeps the ones that explain the failure and feeds them to the questions, so the judge reads the failure rather than the log. The pull request whose head the job ran on, when one is open, stands beside it with the files its diff touches, and `own_fault` (the failure is caused by the change under test) is asked only then. `environment` asks whether it is a flake, a runner or network problem or an external service, and `fixable_here` whether a change to this repository would make the job pass. The watch attaches this report to every settled CI failure, see [Watch](#watch).

### rules

The `rules` pack is one rank step over the rule paragraphs of the repository's rule documents (found by discovery, see [Rule documents](#rule-documents)), each rule going out once in its question with the subject and an item index and nothing else in the state. Each question names what the subject is (`The subject (the body of a new GitHub issue) complies with this rule: ...`) so a rule written for another artifact is answered as not applying rather than broken. `rules.present` names the documents the rules came from.

### release

A release grade reads the checkout when the grade's checkout is the repo being graded (`ref` defaults to `HEAD`, and the working tree stands in for it so an uncommitted changelog promotion is graded before the commit). For any other repo, or from a directory that is no checkout, it reads the forge: tags, the compare between the last tag and `ref`, and the manifest and changelog contents at each end. `ref` then defaults to the first configured `prs.targets` entry and otherwise to the default branch. `release.commits` lists the commits since the last tag, `release.bump` the bump they and the manifests call for against the proposed version, and `release.changelog` whether the changelog moved. The judge is asked whether any commit hides a breaking change and whether the changelog text added since the last tag describes every user-visible change. What is checked depends on the conventions under [Releases](#releases): with none configured the pack only judges the commits.

### triage

The `triage` pack is what the watch asks of an event the rules do not settle: `actionable` (a person or CI is waiting on the maintainer), `kind` (question, bug report, feature request, review feedback, housekeeping, noise, merge or close) and `urgency` (later, soon, now). An event whose `actionable` lands in the violated band is deferred.

### locate

The `locate` pack ranks an index of the checkout against a text (an issue's title and body, or free text). The index is built in code from `git ls-files`: every directory with its file count and a sample of names, every file with its first non-empty lines and the exported or top-level symbol names a per-extension regex finds. `node_modules` and similar trees, lockfiles, binaries by extension, files with nul bytes and files over 200 kB never enter it. Two `top` steps run, directories first, then the files within the directories not ruled out, so each rank reads only what could matter. `top` on the grade call sets how many paths each level lists, 20 by default.

### Repo-defined packs

The built-in packs are in `src/packs/builtin.ts`. A repo overrides or adds one with `.sift/packs/<name>.json` in the same shape, and it is then available to `grade` by name:

```json
{
  "subject": "pr",
  "description": "House rules for pull requests",
  "checks": ["pr.linked", "pr.target", "pr.commits"],
  "questions": {
    "unexplained": {
      "type": "noul",
      "instructions": "The body does not say why the change is needed.",
      "inverted": true,
      "severity": "fail",
      "lo": 0.3,
      "hi": 0.6
    }
  }
}
```

Question fields beyond Jev's own: `lo` and `hi` set the band thresholds (default 0.35 and 0.65), `severity` says what a violated band means for the verdict (`fail`, `warn`, `info`), `inverted` marks a noul whose high probability is the bad outcome, `when` names a subject fact that must be truthy for the question to be asked, and `options` names a runtime option set for a choice (`open_issues`, `type_labels`, `commit_types`). A pack with more questions than one request holds goes out in several, the subject repeated in each.

A pack may also carry `rank`, a list of steps run in order before the questions, each one `rank` over a subject list with the state so far as context. A step names the list (`from`, a subject fact), the `questions` asked of every item (`{field}` takes the item's field, `{subject}` the subject's label), `mode` (`batched` unless said), `by` (the question whose value orders and bands the items, the first unless said), `label` (the item field the report names it by, or a template over its fields), `list` (`each` prints every item in order with every question of the step, `top` the best `top` by value, 20 unless said or overridden by the grade call's `top`, `violated` only the items ruled out with the questions that ruled them out), `order` (`input` shows a top list in input order instead of by value), `fields` (the item fields the state carries beside its index, every field unless said. The rest only fill the questions, so a text that is already in the question is not sent twice), `context` (the state fields the items are read against, the whole state unless said. An isolated step repeats them in every request, so a step over many items names the few it needs), `within`: `{ "field": "dir", "of": "path" }` keeps only the items whose `dir` equals the `path` of an item the previous step did not rule out, which makes steps hierarchical, and `feed`, the state field the items the step did not rule out are placed under for the steps and questions after it. Every question of a step is judged for every item, and `by` only orders. A step rules out an item that any of its questions bands violated, and a `top` step everything below the top it shows. The rules pack is one `each` step over the rule paragraphs, locate two `top` steps, ci one `top` step over a log's lines feeding `lines` to its questions.

Subject kinds and the checks they support:

| subject | checks |
|---|---|
| `issue` | `issue.labels`, `issue.milestone`, `issue.template`, `issue.parent` |
| `pr` | `pr.linked`, `pr.target`, `pr.branch`, `pr.ci`, `pr.template`, `pr.commits`, `pr.drift` |
| `commit` | `commit.format` |
| `release` | `release.commits`, `release.bump`, `release.changelog` |
| `rules` | `rules.present` |
| `tree` | `tree.indexed` |
| `log` | `log.trimmed` |
| `plan`, `event`, `text` | none |

## Conventions

Nothing about a repository is assumed. Out of the box sift discovers the rule documents by judgement, reads the forge's own issue and pull request templates from their documented locations, treats the default branch as protected, and otherwise relies on the judged questions, which hold for any project. Every mechanical check is opt-in: no commit format, label, template, version or changelog check runs until it is configured, so there is nothing to switch off.

Three layers apply in order, each field by field over the last: the defaults, a global file, then the repository's `.sift/config.json`. The global file is `$XDG_CONFIG_HOME/sift/config.json` (`~/.config/sift/config.json` when `XDG_CONFIG_HOME` is unset) and is read when it exists. The `config` option, set to a path relative to the repo root or inline JSON of the same shape, takes the global file's place: when it is set the file is not read. Nothing below assumes a particular format: the presets are examples, and any commit or version convention is a regex. A strict setup for a conventional-commits, semver-tagged, `dev` into `main` workflow looks like this:

```json
{
  "commits": { "convention": "conventional", "scope": "issue", "forbidTrailers": ["Co-Authored-By"] },
  "branches": { "protected": ["main", "dev"], "pattern": "^(feat|fix|chore|hotfix)/\\d+$" },
  "issues": { "requiredLabelGroups": [["bug", "feat", "docs", "chore"]], "milestone": true, "templateSections": ["Summary", "Acceptance"], "childLabels": ["task"] },
  "prs": { "linkIssue": true, "targets": ["dev"], "templateSections": ["Summary", "Testing"] },
  "rules": { "docs": ["briar-systems/mach-std:MIGRATION.md@v6.0.0"], "exclude": ["docs/adr/**"], "maxRules": 200 },
  "release": {
    "scheme": "semver",
    "changelog": "CHANGELOG.md",
    "tagPrefix": "v",
    "zeroVerBreaking": "minor",
    "manifests": [{ "path": "mach.toml", "keys": ["^project\\.mach$", "^dep\\.[^.]+\\.(git|ref)$"], "bump": "minor" }]
  }
}
```

### Issues and pull requests

`issues.requiredLabelGroups` lists label groups, one label from each required (`[["bug", "enhancement", "documentation"]]` asks for a type label). `issues.templateSections` names the second-level headings the body must carry with content under each. `issues.childLabels` marks labels whose issues must be a native sub-issue of a parent (the `issues/N/parent` link, not a body mention). `issues.milestone` requires one. These run in `grade issue` and, when the watch is on, on every new issue as it is filed, the watching session's own included: an issue that fails any of them is delivered with a `filing:` line naming the findings, whoever filed it. A family that files with the default GitHub labels and a two-section template would set:

```json
"issues": { "requiredLabelGroups": [["bug", "enhancement", "documentation"]], "templateSections": ["Problem", "Fix"], "childLabels": ["task"], "milestone": false }
```

`prs.linkIssue` requires a pull request to name its issue. The issue is found from the code host's own relation first (the issues a pull request closes), then from a closing keyword in the body (`Closes #N`), then from an issue number in the branch name (`feat/52`), and the first found is the linked issue. `prs.templateSections` works as `issues.templateSections` does. `branches.pattern` is matched against a work branch name. `prs.targets` is either a list of branch names a PR may target or a regex the base branch must match. `prs.target: "dev"` from older configs reads as `targets: ["dev"]`. `branches.protected` lists the branches whose CI runs the watch delivers on failure, the default branch when unset.

### Conventions as regexes

Every convention is a regex string with named groups. A preset stands for one of them: it expands to its regex when the config resolves, and an explicit pattern beside a preset wins. An invalid regex in any of these fields fails config resolution with the field named.

`commits.format` is matched against the subject line and names the groups `type`, `scope`, `breaking` (any match marks the commit breaking, as a `BREAKING CHANGE:` footer does) and `description`. The preset `commits.convention: "conventional"` is `^(?<type>\w+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s+(?<description>.+)$`. `none`, the default, runs no format check unless `format` is set. `commits.types` lists the values the `type` group may take, and a format without a `type` group skips that check. The same list is the `commit_types` option set a repo pack's choice question can name. `commits.forbidTrailers` lists trailers a commit message may not carry.

`commits.bumps` maps a type to the release bump it calls for, `major`, `minor`, `patch` or `none`: a type not in the map calls for none, and a breaking commit calls for the breaking bump whatever its type. Left unset, the `conventional` preset fills it with `{ "feat": "minor", "fix": "patch", "perf": "patch" }`, as does a config with no `format` at all, since its commits parse with the conventional header. A custom `format` starts from an empty map, so only breaking changes and manifests call for a release until the map names its types.

`commits.scopePattern` is matched against the header's `type(scope)`, or the bare type when the commit has no scope, so a scope rule can except a type. The presets under `commits.scope` are `issue`, `^(chore\(.*\)|[^(]+(\(#\d+\))?)$` (a scope is optional, must be `#<n>` when present, and `chore` may carry any scope, as `chore(release): 1.2.0` does), `none`, `^[^(]*$` (no scope allowed), and `any`, the default, which runs no scope check.

`release.versionPattern` is matched against a version. Its numeric named groups, in order, order versions (which tag is the latest, whether a proposed version is newer), and the groups `major`, `minor` and `patch`, when named, are what a bump moves: the bumped group goes up, the lower ones go to zero, and anything after the last of them (a prerelease) is dropped. The presets under `release.scheme` are `semver`, `^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+(?<build>[0-9A-Za-z.-]+))?$`, and `calver`, `^(?<year>\d{4})\.(?<month>\d{1,2})(?:\.(?<micro>\d+))?$`. A calendar version has no `major`, so `release.bump` reports the bump the commits call for and requires a proposed version to be newer than the last tag rather than a particular step. A calendar layout shaped differently (`YY.MM`, `YYYY.MM.DD`) sets `versionPattern` outright.

`release.tagPattern` is matched against a tag and names the `version` group the version pattern then reads (the whole tag when it names none). It defaults to `release.tagPrefix` followed by the version, `^v(?<version>.+)$` out of the box.

### Releases

With no version pattern configured, no version is computed or checked. The tags are still ordered as semver to find the last release the pack reads commits from. `release.changelog` names the changelog file. No format is parsed: the file at the last tag is line-diffed against the file at the ref, `release.changelog` warns when nothing changed, and the judge is asked whether the added text describes the commits since the last tag. Leave either out and the release pack only judges the commits since the last tag.

`release.zeroVerBreaking` is what a breaking change requires while the version is below 1.0.0 (`minor` by default, `major` to cut 1.0.0 on the first one). `release.manifests` lists files whose changes are release-worthy on their own, commit types aside: each entry names a file, the bump a change to it requires, and what counts as a change: `keys`, regexes over the file's dotted paths when it is TOML, JSON or YAML by extension (`project.mach`, `dep.std.ref`, `dependencies.0.name` with arrays indexed numerically), or `pattern`, a regex over the file's text in any format whose matched text must not change (`"^ABI_VERSION\\s*=\\s*\\S+"` in a Makefile). Both can be given on one entry. The manifest at the last tag is compared with the one at `HEAD`, so a version line that the release itself moves is not matched unless a key or pattern names it. The required bump is the higher of the commit bump and the manifest bump, and `release.bump` says which keys moved.

### Rule documents

No filename is special. The rules pack and the outbound gate read the repository's rule documents by discovery: every prose file (`.md`, `.mdx`, `.markdown`, `.txt`, `.rst`, `.org`) at the repository root and under `docs/` or `.github/` at any depth, plus the forge's issue and pull request templates from the locations the forge documents, is a candidate. In a checkout the candidates come from `git ls-files` and the working tree. A grade of another repository, or one from a directory that is no checkout, reads the forge's file tree at its default branch. One batched `rank` over the candidates (path and a bounded excerpt) against "this document states rules contributors must follow" keeps the satisfied band. Every kept document is split into paragraphs, list items and table rows (a row's cells named by the header: `5.x: sort.sort[T](data, len, cmp); 6.0.0: sort.sort[T](data, len)`), and a second batched `rank` against "this paragraph is a rule a contribution can break, not narrative or instruction" keeps the satisfied band as the rules.

`rules.docs`, empty by default, adds documents the judge does not have to recognise: paths in the checkout, or `owner/repo:path[@ref]` read from the forge, so a consumer PR can be graded against another repo's migration guide at a tag. Their paragraphs are filtered like any other document's. `rules.exclude` lists paths or globs (`*` within a segment, `**` across) that are never candidates. Rules past `rules.maxRules` (200 by default) are dropped and `rules.present` says so.

Discovery is cached in the plugin store per checkout (or per repository and ref), keyed by a digest of every file it read and of the config, so the judge is asked again only when a document, a listed doc or the config changes. Every rules report names the documents its rules came from in `rules.present` (`14 rules from CONTRIBUTING.md, docs/style.md (cached)`), and a judge failure during discovery makes the verdict unknown rather than passing an empty rule set.

## Forge

Nothing above the code host layer names a host. Every read and write of a repository goes through the `Forge` interface in `src/forge/forge.ts`: the checkout's repository and default branch, the login, issues and their parents, pull requests with their diffs, commits, closing issues, reviews and checks, runs and jobs and a job's log by step, tags and compares, file trees and contents at a ref, templates, and the writes its cli makes (which command carries a body, in which flags) so the outbound gate can find text on its way out. A repository is the forge's own path for it, opaque above this layer, and a forge names its artifacts in its own words (`GitHub issue`, `merge request`) for the judge.

GitHub, over `gh`, is the one member today. The shapes are held to what a second member (GitLab, with merge requests, pipelines and project paths with slashes) can also answer, so adding one is a new class behind the interface, not a change to the packs, the watch or the gate.

## Hooks

Three modules act inside the session without being asked.

| module | hook | what it does | default |
|---|---|---|---|
| `prune` | `tool.call` (post) | scores long Bash and Read output in chunks before the model reads it and drops the chunks that are not needed | on |
| `gateOutbound` | `tool.call` (pre) | checks text about to leave the session against the channel's length limit and the repository rule documents, and denies a broken rule | off |
| `classify` | `model.classify` | answers the engine's own small classifications from the judge | off |

`shadow: true` makes every module log what it would have done without doing it. Use it to calibrate thresholds against your own traffic before trusting them.

### Prune

Output over `pruneFloorTokens` (estimated) from the tools in `pruneTools` is split into chunks of `pruneChunkLines` lines and ranked, batched, against the last user prompt: is this chunk needed for the current task. A chunk below `pruneKeepThreshold` is dropped. Nothing is kept on disk. In its place stands a one-line note with the omitted line range and how to get it back:

```
[sift: lines 51-75 (25 lines) omitted as not needed for the current task, re-read src/watch/watcher.ts with offset 51 limit 25]
[sift: lines 120-180 (61 lines) omitted as not needed for the current task, rerun the command for the full output]
```

For a Read the range is in file lines (the call's offset is applied), so the re-read named by the note lands on the omitted text. A judge failure passes the output through untouched.

### Outbound text

With `gateOutbound: true` the text a tool call is about to send is checked before the call runs. Where text leaves the session is a table of channels, one entry per place: a `name` a config entry replaces it by, a `tool` regex over the tool name, where the `text` is in the call, an optional hard `limit` in characters, and `kind`, what the text is in the words the rules question names it by. The text is either `{ "fields": [...] }`, the named fields of the tool input joined in order, or for a shell command `{ "command": <regex>, "body": [flags], "file": [flags] }`: the value after a body flag, a quoted word or a `$(cat <<'EOF' ... EOF)` heredoc, else the file named by a file flag, read before the command runs, or when that file is `-` the `<<'EOF' ... EOF` heredoc on the command's stdin. A body from stdin with no heredoc in the command, or from an unreadable file, is denied without a judge call. The first channel whose tool and text match decides.

The default table ships Discord (`send_message`, `edit_message`, `send_webhook_message` and `send_dm` content, `create_forum_post` content and embed text, 2000 characters each) and one entry per write the forge's cli makes: `gh pr|issue create|comment|edit` and `gh pr review|merge` by `--body`/`-b` or `--body-file`/`-F` and `gh release create|edit` by `--notes`/`-n` or `--notes-file`/`-F`, named `github-pr-comment`, `github-release-create` and so on, each with its `kind` (`a comment on a pull request`, `a review on a pull request`, `a merge commit message`, `the notes of a new GitHub release`). `outbound.channels` in the config adds entries to the table, or replaces a default entry of the same name:

```json
"outbound": {
  "channels": [
    { "name": "slack", "tool": "^mcp__slack__post_message$", "text": { "fields": ["text"] }, "limit": 40000, "kind": "a Slack message" },
    { "name": "gitlab-mr-note", "tool": "^Bash$", "text": { "command": "^glab\\s+mr\\s+note\\b", "body": ["--message", "-m"] }, "kind": "a note on a merge request" },
    { "name": "discord-message", "tool": "^mcp__discord__send_message$", "text": { "fields": ["content"] }, "limit": 1000, "kind": "a Discord message" }
  ]
}
```

The channel's limit is mechanical and denies without a judge call. The rules pack then runs over the text with the same rule documents as `grade rules`, each question naming the channel's `kind`, so a pull request rule read against an issue body is answered as not applying rather than broken: a violated rule denies with the rule quoted, an unclear one logs a warning, and the judge being unavailable allows. `shadow` logs what would have been denied.

### Classify

With `classify: true` the engine's own `model.classify` calls (a text and a list of labels) are answered by one choice question to the judge. A judge failure, or an answer that is not a choice, falls through to the engine's own model.

## Watch

The watch is a set of subscriptions, added and removed at runtime with the `watch` tool, any number at once and across repositories. Each one names a repository and a scope, carries its own filter, and may name the agent it belongs to and when it ends:

```
{ id, repo, scope, filter, for?, until? }
scope  = repo | pr <n> | branch <name> | run <id> | tag <glob>
filter = { items, ci: settled | failures | all | none, stall }
for    = the agent it belongs to, by the name SendMessage reaches it by, set when a subagent subscribes
until  = settled | merged | closed | <iso time>
```

`repo` covers the whole repository, `pr <n>` one pull request across every head it moves to (its item events, the runs on its heads and its verdicts), `branch <name>` the runs of one branch, `run <id>` one run, and `tag <glob>` the runs on tags matching the glob (`*` any run of characters, `?` one). `items` (default on) takes issue and pull request events in scope, `stall` (default on) takes `ci stalled`, and `ci` defaults to `watchCi`. A subscription with `until` is removed on its own: `settled` once its verdict (a completed run, outside a `pr` scope) is delivered, `merged` or `closed` once its pull request is, a time once it passes. A subscription made from a subagent belongs to it and is removed once the session's agent list reports that agent finished (or no longer lists it), so a dead agent's subscriptions stop polling. The subscriptions live in the plugin store under the session, so a resumed session gets them back.

There is one poller per repository, started with its first subscription and stopped with its last. It polls through the forge with conditional requests, so idle polls are free, and adapts the interval between `watchMinInterval` and `watchMaxInterval`. N repositories cost N probe sets per interval, and the rate floor is per token: once any poller reads the remaining calls below it, every poller waits for the window to refill. Every change is one event, and each event is matched against the repository's subscriptions, scope first, then filter. An event no subscription takes is dropped, one several take is delivered once, naming each. A `run` subscription reads its run by id each poll until it completes, so a run that pages out of the newest runs on a busy repository still delivers, and a run already complete when it is subscribed to delivers on the next poll.

With `watch: true` each repository in `watchRepos` (the session's own when empty) is subscribed whole at boot with the configured filter. Rules settle what needs no judgement: a PR whose checks have all finished delivers once as `ci settled <conclusion>` (pass or fail, even when you pushed the commit), runs on other branches deliver on failure when the branch is protected or matches the work branch pattern and defer on success, bot activity drops (`watchIgnoreBots`), your own writes defer (`watchIgnoreSelf`, keyed on the forge login), new PRs deliver, a new issue is checked against the issue pack and delivers with its findings when it fails one (own writes otherwise defer under `watchIgnoreSelf`), label churn defers. Everything else goes through the `triage` pack (`watchTriage`), and an event whose `actionable` lands in the violated band is deferred.

A delivery is one prompt, each event ending with the subscriptions it matched:

```
[sift watch octalide/sift]
issue #41 comments 2->3: watcher misses review comments
  by alice · https://github.com/octalide/sift/issues/41 · actionable 0.93, kind question, urgency now · s1
deferred meanwhile: 2 housekeeping, 1 ci success
```

A settled PR is one line with the aggregate verdict, so a steward waiting to grade, mark ready and merge needs no `gh pr checks` loop of its own:

```
[sift watch octalide/sift]
ci settled success: pr #14 feat/14 @3f2a9c1: Watch delivers a settled CI verdict (3 checks) · now: open, head unchanged
  by octalide · https://github.com/octalide/sift/pull/14 · ci settled on pr · s1
```

A failure carries the `ci` pack's report on each failed check, one job per check, read from its log through the forge, so the session that pushed the commit reads why it failed without opening the log:

```
[sift watch octalide/sift]
ci settled failure: pr #14 feat/14 @3f2a9c1: Watch delivers a settled CI verdict (3 checks, failed: test) · now: open, head unchanged
  by octalide · https://github.com/octalide/sift/pull/14 · ci settled on pr · s1
  sift ci octalide/sift job 106195824649: PASS (judge: jev)
    [info] log.trimmed: 212 of 212 lines read from the failing step Run npm test
    lines: top 40 of 212, 40 not ruled out
      1. [satisfied] 118: FAIL tests/watch.test.ts > watcher > delivers one settled verdict = 0.91
      ...
    [satisfied] own_fault = 0.88: The failure is caused by the change under test: ...
    [violated] environment = 0.06: The failure is a flake, a network or runner problem, or an external service, ...
    [satisfied] fixable_here = 0.93: The fix is inside this repository.
```

The verdict counts every check run and commit status on the PR's head, so it waits for external checks too. Until the last one finishes the individual runs are held in the digest, named by PR. A head whose checks have not all finished within `watchStallHours` (default 1) is delivered once as `ci stalled`, in the same shape, naming the checks still pending, so no session waits on a check that never reports. Heads are tracked from the moment their PR is open, so a check that never starts stalls too. The head is not delivered as stalled again unless a new commit lands on it, and a stalled head that does finish later still delivers its `ci settled` line:

```
[sift watch octalide/sift]
ci stalled: pr #14 feat/14 @3f2a9c1: Watch delivers a settled CI verdict (1 of 3 checks pending: deploy-preview) · now: open, head unchanged
  by octalide · https://github.com/octalide/sift/pull/14 · ci stalled on pr · s1
```

CI news that a newer result has made old is dropped rather than delivered late. Each CI event reports on a subject, `pr:<n>` when it ran on a head of that PR (the current head or one it has since moved from) and `branch:<name>` otherwise, and a run is keyed by its subject and its workflow, so a docs run is superseded only by a newer docs run. When a run completes, every held or undelivered event of an older run with the same key is dropped, as is an earlier completion of the same run when it completes again, and a settled verdict on a PR head drops everything held for the PR's older heads and the runs held for that head. Each drop is logged as `drop: superseded by ...`. A run on a tag reports on `tag:<name>`: the forge says whether a run's ref is a tag (GitHub, whose runs name the ref alone, by one tag lookup per ref name, remembered for the session). An event that ages out is read again first: a run held on a PR head that has since moved is dropped, a head whose checks have all finished since delivers its `ci settled` line in place of the runs held for it (one checks read per head), and a run on a branch with a newer completed run of its workflow is dropped (one run listing per branch). Only what survives is delivered.

Every CI line ends with where its subject stands at delivery rather than at the event: `now: open, head unchanged`, `now: open, head @<sha> (moved)`, `now: merged`, `now: closed` (or `not open` when the watch never saw the PR's state) for a PR, and the newest completed run of the event's workflow for a branch, `now: dev @9f8e7d6, docs success`. It is read from the open PR heads and the item cache the poll already holds, so it costs no request:

```
[sift watch octalide/sift]
ci failure: docs on dev @1a2b3c4 (push) · now: dev @1a2b3c4, docs failure
  by octalide · https://github.com/octalide/sift/actions/runs/17 · ci failure on watched branch · s1
```

A subscription's `ci` sets what CI reaches it: `failures` (the default, from `watchCi`) delivers each open PR once when every check on its head has finished, pass or fail, and failed runs (on a `repo` subscription, only those on protected branches or branches matching the work pattern), `settled` delivers the verdicts and, on a `branch`, `tag` or `run` subscription, every completed run, `all` delivers every completed run as well, `none` delivers no CI. A `run` subscription takes its run's completion under any of them but `none`, and nothing newer supersedes it. Deferred events ride along as a digest on the next delivery, and any deferred event older than `watchDeferMaxAgeHours` that is not superseded is delivered on its own. `watchDelivery: "log"` writes transcript lines instead of prompts. The cursor, item cache, open PR heads and deferred list live in the plugin store, so a restart picks up where it left off.

## Tools and command

The tools are registered under the plugin's name, so the model sees `mcp__sift__grade`, `mcp__sift__judge`, `mcp__sift__rank`, `mcp__sift__watch` and `mcp__sift__status`.

| tool | takes | returns |
|---|---|---|
| `grade` | `pack`, `subject`, optional `repo`, `cwd`, `text`, `ref`, `top` | the pack's report as text |
| `judge` | `state`, `questions` | the answers |
| `rank` | `items`, `questions`, optional `mode`, `context`, `by`, `choice`, `fields` | the items with their answers, and the sorted view |
| `watch` | `action`: `subscribe`, `unsubscribe`, `list`, `start`, `status`, `poll`, `pause`, `resume`, `reset`, `deferred`; `repo`, `scope`, `items`, `ci`, `stall`, `until` on `subscribe`; `id` on `unsubscribe`; `for` on `start`; `repo` narrows `poll`, `pause`, `resume`, `reset` and `deferred` | the subscription made, the list, or the pollers' state |
| `status` | nothing | backend (for jev, where its key came from, the key's last four characters, a shadowed key and a rejected key), modules, whether the watch runs, decision counts |

`grade`, `judge` and `rank` are registered when the `grade` option is on, `watch` and `status` always. `watch subscribe` adds a subscription and returns its id (the same subscription again returns the one already there), `unsubscribe` removes one, and `list` and `status` show every subscription with its scope, filter, owner and until. `start` subscribes to the session's repository with the configured filter, or to one pull request when `for` names it (a number, `#` optional) or one branch (anything else). `poll` polls once now, `reset` forgets a repository's cursor and reseeds.

```
s1 octalide/sift repo · items, ci failures, stall
s2 briar-systems/mach run 17736210453 · items, ci settled, stall · for issue-131 · until settled
s3 briar-systems/mach-http tag v* · items, ci settled, stall
```

Deliveries are prompts to the session's main loop, whichever loop subscribed. A subscription made from a subagent records that agent, by the name SendMessage reaches it by, and the tool result says so (deliveries reach the agent only when the session relays them). Each delivered event names the agents whose subscriptions it matched (`for issue-113: ci settled success: pr #113 ...`), and the header names an agent when every subscription in the delivery is that agent's (`[sift watch o/r for issue-113]`), so the relay is one `SendMessage`. An event matching no agent's subscription names no agent. Nothing about agent names or branch conventions is inferred. A session that will act on repository events calls `status` at start to learn whether they will arrive as prompts.

`/sift` prints status and per-module decision counts (the same text as the `status` tool), a judge line naming the backend and, for jev, where its key came from and the key's last four characters (never the key), any other source holding a different key as set but shadowed, and whether jev has rejected the key, with this session's decisions and failures separate from the ring shared by every session running the plugin, and a cost line: judge tokens in and out (the backend's own count when it reports one, an estimate otherwise) against context tokens removed by pruning, per session and per module. A module that fell back to the built-in behaviour since the last prompt says so once as context beside the next prompt, so a failing backend is visible while it fails and not as a count afterwards. `/sift log [n]` prints the recent decisions with their scores, `/sift clear` clears them, and `/sift watch status|list|start|poll|pause|resume|reset|deferred [repo]`, `/sift watch subscribe <repo> [scope]` and `/sift watch unsubscribe <id>` control the watch as the tool does.

## Options

Every option, with its default. The same descriptions are in `.claude-plugin/plugin.json`, which is what `/config` reads.

| option | default | what it does |
|---|---|---|
| `backend` | `auto` | `auto` uses Jev when a key is present and the session's small model otherwise. `jev` and `model` force one. `off` disables every judged feature and leaves only mechanical checks |
| `apiKey` | unset | Jev key. Leave unset to read `TYPESAFE_API_KEY` from the environment or the settings `env` block. The option wins over both, and as a sensitive option it is stored in `~/.claude/.credentials.json`, not a settings file. When another source holds a different key, status and every key rejection name it by its last four characters as set but shadowed. A jev refusal with http 401 or 403 reads `jev rejected the key from <source> (ending XXXX); fix: <what to change for that source>`, and after it the jev judge fails every later call with the same text and sends no request until the session restarts, which is also when a new key is read. Status then reads `judge: jev, key rejected` |
| `jevModel` | `jev-latest` | TypeSafe model name sent with every Jev request |
| `jevBaseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint. Change it only for a proxy or a compatible local server |
| `fallbackModel` | `haiku` | model used by the model backend, an alias or a full id |
| `shadow` | `false` | every module logs what it would have done and does nothing |
| `prune` | `true` | score long tool outputs before the model reads them and drop the chunks the judge marks unneeded |
| `pruneFloorTokens` | `4000` | tool outputs under this estimated size pass through untouched |
| `pruneChunkLines` | `25` | lines per scored chunk |
| `pruneKeepThreshold` | `0.5` | minimum probability that a chunk is needed. Below it the chunk is replaced by an omission note |
| `pruneTools` | `Bash,Read` | comma separated tool names whose output is pruned. Bash and Read are supported |
| `watch` | `false` | subscribe to the repositories in `watchRepos` at boot: poll them for issues, PRs, comments, edits, labels and CI, and deliver actionable events as prompts |
| `watchRepos` | empty | comma separated `owner/name` list, each subscribed whole at boot. Empty subscribes the session's own repository |
| `watchMinInterval` | `60` | seconds between polls while the repository is changing |
| `watchMaxInterval` | `300` | seconds between polls once it is idle. Idle polls are conditional requests and cost no API quota |
| `watchDelivery` | `prompt` | `prompt` submits each actionable event as a user turn, `log` only writes transcript lines |
| `watchIgnoreSelf` | `true` | events authored by the login this session runs as are deferred, not delivered |
| `watchIgnoreBots` | `true` | events authored by bot accounts are dropped |
| `watchCi` | `failures` | the `ci` filter of a subscription that sets none: `settled` delivers each open PR once when every check on its head has finished and every completed run on a branch, tag or run subscription, `failures` the verdicts and failed runs (on a whole repository, those on protected or work pattern branches), `all` every completed run as well, `none` no CI |
| `watchTriage` | `true` | run the triage pack on issue and PR events. Off delivers everything the rules do not defer |
| `watchDeferMaxAgeHours` | `24` | a deferred event older than this is delivered on its own so nothing waits forever, unless a newer result has superseded it |
| `watchStallHours` | `1` | a PR head whose checks have not all finished within this many hours is delivered once as `ci stalled`, naming the pending checks |
| `grade` | `true` | register the `grade`, `judge` and `rank` tools |
| `config` | empty | conventions in the shape of `.sift/config.json`, as inline JSON or a path relative to the repo root, taking the global file's place |
| `gateOutbound` | `false` | check text on its way out of the session against the channel's limit and the repository rule documents, and deny a broken rule |
| `classify` | `false` | serve the engine's own `model.classify` calls from the judge |

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

CI runs the same three commands on every pull request and reports them through a `gate` check, which the rulesets on `dev` and `main` require.

`types/claude-code.d.ts` is the engine's generated declaration. Regenerate it with `/plugin-types` after a Claude Code upgrade and rerun the typecheck. The function-hook surface is early access and changes between releases.

## Caveats

- Jev is in early access. Join the waitlist at typesafe.ai. Without a key the model backend works but is slower, costs model tokens, and its probabilities are stated, not calibrated.
- The prune module estimates tokens without a tokenizer, with a rule calibrated against Jev's reported usage (from fast-jev-compaction, MIT).

## Changes in 0.11.0

This release drops judged review of diffs and is breaking. The judged diff questions caught nothing the repositories' own checks did not, raised false positives, and often could not run from another repository's worktree.

Removed: the `hunks` pack. The `pr` pack's judged questions (`addresses_issue`, `scope_creep`, `workaround`, `contract_change`, `tests_cover`, `risk`) and its `drift_collides` rank step: `pr` now runs its mechanical checks and asks the judge nothing, and `pr.drift` reports that the base moved under the PR without judging whether the patches collide. The `commit` pack's judged questions (`type_matches`, `describes_change`, `breaking_missed`): `commit` runs `commit.format` alone. Pull requests and commits as `rules` subjects: `rules` takes an issue or free text and refuses a pull request or a commit with the forms it takes named. A bare number now names an issue for `rules`, where it named a pull request. The `diff`, `changes` and `hunks` fields of a `pr` subject and the `diff` and `has_diff` fields of a `commit` subject, so a repo pack can no longer judge a diff either. `drift` on a `pr` subject is a list of paths.

Changed: the watch is a set of subscriptions, several repositories at once, each scoped to the whole repository, one PR, one branch, one run or tag pushes matching a glob, with its own filter (`items`, `ci`, `stall`) and an optional `until`, added and removed at runtime with `watch subscribe`, `unsubscribe` and `list`. One poller runs per repository, from its first subscription to its last, and the rate floor holds every poller on the token. A `run` subscription reads its run by id, so a run paged out of the newest 30 still delivers. A subscription made from a subagent belongs to it and goes when the agent finishes, and each delivered event names the subscriptions and agents it matched. `watch start` subscribes to the session's repository, or to one PR or branch when `for` names it. The `watchRepo` option is replaced by `watchRepos`, a list subscribed at boot, and `watchCi` gains `settled`. The armed name and the per-PR `{ agent, ref }` set are gone: ownership is the subscription's. A run on a tag keys as `tag:<name>`, not `branch:<tag>`. The `Forge` interface gains `run` (one run by id) and `Run.tag`. The stored watch state changes shape again, so the first poll after the upgrade reseeds.

Fixed: the watch drops superseded CI news. A newer completed run of the same workflow on the same PR or branch drops the older ones still held or about to be delivered, and a settled verdict on a PR head drops what was held for its older heads. An event that ages out is read again first (the PR's head and checks, or the branch's runs), so a failure since fixed or a run on a head that has since moved is no longer delivered hours late. Every CI delivery line ends with `now:`, the PR's state (open with its head unchanged or moved, merged, closed) or the branch's newest result of that workflow. The `Forge` interface gains `branchRuns`, the newest runs on one branch. The stored watch state changes shape, so the first poll after the upgrade reseeds and a backlog held by an older version is dropped.

Added: `grade` takes `cwd` and reads the checkout of that directory, or of the directory the calling subagent was spawned in, instead of always the session's main working tree: its HEAD, working tree, repository, conventions and packs. A `commit`, `pr` range or `locate` grade whose `repo` is not its checkout's repository is refused, where `commit` ignored `repo` and `locate` read the session's checkout. A grade of an issue, PR, plan or ci log in another repository applies that repository's conventions, where it applied the session's.

## Changes in 0.10.0

This release trims sift to the judgement core and is breaking.

Removed modules, with their options: `compact` (`compact`, `compactAtPercent`, `compactKeepThreshold`, `compactMinReduction`, `compactPinRecent`, `compactTruncateHead`, `ledgerPath`), `message` (`message`), `route` (`route`, `routeMinEffort`, `routeMaxEffort`) and `gate` (`gate`, `gateFailClosed`). A settings file that still sets one of these is read without it. The `message` pack is gone with its module.

Prune keeps nothing on disk: the archive under `~/.cache/sift/` and the recovery note that named it are replaced by a note carrying the omitted line range and the call that gets it back.

`Pack.expand` is replaced by `Pack.rank`, a list of steps. A repo pack that still carries `expand` is refused at load with the step shape named. `rules.docs` now defaults to empty: the rule documents are found by discovery, and the list only adds documents the judge does not have to recognise. `SiftJudged.answer` is optional: a question the judge left unanswered is reported in the unclear band without one. `rules.maxRules` and `rules.exclude` keep their meaning.

Added: the `rank` primitive and tool, the `hunks`, `plan`, `ci` and `locate` packs, `issue.implementable`, `scope_clear` and `blocked_by`, `pr.drift` and `base..head` range subjects, `ci stalled` with `watchStallHours`, the `ci` report attached to a settled failure, the `Forge` interface, regex conventions with presets, `commits.bumps`, a format-free changelog, TOML, JSON and YAML manifests, the global config file at `~/.config/sift/config.json`, outbound channels as data under `outbound.channels`, and `watch start`.
