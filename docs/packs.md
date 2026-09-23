# Packs

A pack is data: a subject kind, a list of mechanical checks, typed questions with thresholds, and optionally rank steps. `grade(pack, subject)` builds the subject, runs the checks, ranks, asks the questions and returns a report. The built-in packs:

| pack | subject | what it answers |
|---|---|---|
| `issue` | an issue number or URL | is the issue well formed, correctly typed, scoped to this repo, implementable without a decision it does not make, and ready to work on |
| `pr` | a PR number or URL, or a `base..head` range | is the PR linked, targeted, named, templated, committed and checked as the repository requires, and has the base moved under it. Mechanical only, no judge call |
| `plan` | an issue number or URL, the plan in `text` | does the plan cover the issue, add nothing beyond it, and decide nothing the issue leaves open; a warn means the plan lists its decisions in the PR body |
| `commit` | a ref or range | do the commit messages follow the repository's commit format. Mechanical only, no judge call |
| `rules` | an issue number or URL, or free text | does the subject comply with each rule the repository's rule documents state |
| `release` | a proposed version, or `release` | are the commits since the last tag safe to ship as described, and do the version bump and changelog agree with them |
| `triage` | a repository event (through `grade`, its text) | does this event need the session to act on it now, what kind is it, how urgent |
| `locate` | an issue number, an issue or PR URL, or free text in `text` | which files of the checkout must be read or changed to implement it |

```
grade(pack: "pr", subject: "42")               # or "#42", or the PR's URL
grade(pack: "pr", subject: "dev..HEAD")        # the PR this branch would open, graded before it exists
grade(pack: "issue", subject: "17")            # or "#17", or an issue URL, which may name another repo
grade(pack: "plan", subject: "17", text: "...")   # a plan for issue 17
grade(pack: "commit", subject: "main..HEAD")
grade(pack: "rules", subject: "17")            # issue 17 against the repo's rule documents
grade(pack: "rules", subject: "x", text: "...") # free text against the rules, a commit message or PR body before it is written
grade(pack: "release", subject: "v1.4.0")      # or "release" for the required bump alone
grade(pack: "release", subject: "v1.4.0", repo: "o/r", ref: "dev")  # any repo, no checkout needed
grade(pack: "locate", subject: "17")           # the files to read or change for issue 17, top 20 per level
grade(pack: "locate", subject: "x", text: "...", top: 10)  # the same for free text
grade(pack: "commit", subject: "HEAD", cwd: "/src/other-42")  # HEAD of another checkout, under its conventions
```

The subject is parsed before anything is fetched: `issue` and `pr` take a number as `N` or `#N`, or an issue or pull request URL in the code host's own shape (the repo in the URL is the one read, so a URL of another repo needs no `repo`), `pr` also a range (`dev..HEAD`), `commit` takes a ref or range, `release` takes a tag or `release`. `locate` takes a bare number as an issue, an issue or pull request URL (read as its title and body), or free text in `text`, which wins over the subject when both are given. `rules` takes an issue number or URL, or free text in `text`, and refuses a pull request or a commit with the forms it takes named: sift judges no diff. `plan` takes an issue number or URL and refuses a call without `text`. A missing subject, a title or body pasted as one, or a URL of the wrong kind is refused with the expected form named, and so is a number given to `issue`, `rules`, `locate` or `plan` that names a pull request.

Every grade reads one checkout: `cwd` when the call passes it (an absolute path), otherwise the directory the calling subagent was spawned in when its Agent call set one (or its parent's), otherwise the session's repository. The checkout is the git toplevel of that directory, so a worktree grades its own HEAD and working tree, and it brings its repository, its `.sift/config.json` and its `.sift/packs`: the packs a grade can name and the conventions it checks against are that checkout's. `commit`, a `pr` range, `locate`, and `release` and `rules` when they read the checkout refuse a `repo` that is not the checkout's, naming both, rather than mix one repository's commits with another's name; pass the `cwd` of a checkout of that repository instead. Without `cwd`, a `release` or `rules` grade of another repository reads it from the forge as before. A subject read from the forge (an issue, a PR by number, a plan, or a `release` or `rules` grade of another repository) is checked against the conventions of the repository it is in: the checkout's own when it is that repository, otherwise that repository's `.sift/config.json` at its default branch, read through the forge over the global layer. The repository a checkout names on the forge is looked up once per checkout, and its conventions and packs are reread when anything under `.sift/` changes.

A report has three parts: mechanical findings (labels, milestone, template sections, linked issue, target branch, CI, commit format and scope, drift, required version bump, changelog), judged findings (each with its probability and a band: satisfied, unclear, violated), and a verdict (pass, warn, fail, or unknown when the judge was unavailable). A pack with rank steps adds one list per step. A question the judge left unanswered is reported in the unclear band without an answer, and an answer under an id no question asked for is dropped and counted.

## pr

The `pr` pack is mechanical: it runs its checks and asks the judge nothing. The diff is read only to find drift and never reaches a judge. `pr.drift` warns with the files the PR touches that also changed on the base since the branch point (the merge base to the base head). It reports that the base moved, not whether the two patches collide. A `base..head` subject grades the same way from the checkout before the PR exists: the commits and drift come from `git`, the issue from the head branch name (a `(?<issue>)` group in `branches.pattern` names it, otherwise the number segment of `feat/52` or `52-title`), and the checks only a forge can answer (`pr.linked`, `pr.target`, `pr.ci`, `pr.template`) skip rather than fail.

## issue

The `issue` pack asks whether the body is substantive, which type label fits, whether the change stays in this repository, whether it needs a parent, which open issue it duplicates, whether it is `implementable` (a competent engineer could build it without making a decision the body does not make: two valid designs, an unnamed interface, an unstated edge behaviour all fail it), whether its scope is clear enough to reject an unrelated change, which open issue it is `blocked_by` (`none` unless the title or body says so, or the same code must change there first), and how ready it is. A violated `implementable` fails the report.

The issue is judged as it stands, not as first filed. The subject carries the whole comment thread, oldest first, each comment as `{ by, association, at, text }` with the commenter's standing in the forge's words (`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE` on GitHub). A long thread is cut to a character budget that keeps the comments of the author and of maintainers (owners, members, collaborators) first and then the newest of the rest, so a ruling followed by any amount of discussion stays in. A later comment by the author or a maintainer that records a decision supersedes the body where they conflict: a decision it makes counts for `implementable`, a hold or dependency it states counts for `blocked_by`, and `substantive`, `scope_clear`, `type` and `readiness` read the body as it amends it. A comment from anyone else is discussion and never overrides the body. When the author or a maintainer has commented, `ruling` names the comment the issue turns on (`octalide at 2026-09-22T20:29:33Z`), or `none`. A pull request's subject carries its thread in the same shape.

## plan

The `plan` pack reads an issue and a plan for it from `text` and asks three questions: `covers` (every point the issue asks for is met by a step, or the plan says why it is left out), `adds_nothing` (no step changes something the issue does not mention unless the change is needed to land one it does), and `decides_unasked` (no step settles something the issue leaves open that others will depend on: a new or changed public interface, a stored format, behaviour a caller outside the change depends on, a choice between two architectures; normalising an input, a collision or ordering rule inside one module, the wording of a message, or a test's shape are not decisions). A violated `covers` fails the report. A violated `adds_nothing` or `decides_unasked` warns: the plan goes ahead and lists its decisions in the PR body.

## rules

The `rules` pack is one rank step over the rule paragraphs of the repository's rule documents (found by discovery, see [Rule documents](conventions.md#rule-documents)), each rule going out once in its question with the subject and an item index and nothing else in the state. Each question names what the subject is (`The subject (the body of a new GitHub issue) complies with this rule: ...`) so a rule written for another artifact is answered as not applying rather than broken. `rules.present` names the documents the rules came from. Free text, and an issue's title and body, are read the way the outbound gate reads text (see [Outbound text](hooks.md#outbound-text)): text longer than one judge state holds is graded in parts, every character judged, and the parts' answers make one report. The report names the parts it was judged in, a rule takes its worst band across them, and each band names the parts it was found in: `[violated] rules_4.section = 0.10: ... (in part 3 of 3 ("Fixes" to "Docs"))`. The rest of an issue (its labels, milestone, sections and comments) is read beside the opening part. Short text, and an issue whose title and body fit one state, is one subject, graded as it always was.

## release

A release grade reads the checkout when the grade's checkout is the repo being graded (`ref` defaults to `HEAD`, and the working tree stands in for it so an uncommitted changelog promotion is graded before the commit). For any other repo, or from a directory that is no checkout, it reads the forge: tags, the compare between the last tag and `ref`, and the manifest and changelog contents at each end. `ref` then defaults to the first configured `prs.targets` entry and otherwise to the default branch. `release.commits` lists the commits since the last tag, `release.bump` the bump they and the manifests call for against the proposed version, and `release.changelog` whether the changelog moved. The judge is asked whether any commit hides a breaking change and whether the changelog text added since the last tag describes every user-visible change. What is checked depends on the conventions under [Releases](conventions.md#releases): with none configured the pack only judges the commits.

## triage

The `triage` pack is what the watch asks of an event the rules do not settle: `actionable` (a person or CI is waiting on the maintainer), `kind` (question, bug report, feature request, review feedback, housekeeping, noise, merge or close) and `urgency` (later, soon, now). An event whose `actionable` lands in the violated band is deferred.

## locate

The `locate` pack ranks an index of the checkout against a text (an issue's title and body, or free text). The index is built in code from `git ls-files`: every directory with its file count and a sample of names, every file with its first non-empty lines and the exported or top-level symbol names a per-extension regex finds. `node_modules` and similar trees, lockfiles, binaries by extension, files with nul bytes and files over 200 kB never enter it. Two `top` steps run, directories first, then the files within the directories not ruled out, so each rank reads only what could matter. `top` on the grade call sets how many paths each level lists, 20 by default. It overrides every `top` step of the pack graded.

## Repo-defined packs

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

Question fields beyond Jev's own: `lo` and `hi` set the band thresholds (default 0.35 and 0.65), `severity` says what a violated band means for the verdict (`fail`, `warn` by default, or `info`, which never moves it; an unclear band on a `fail` question warns), `inverted` marks a noul whose high probability is the bad outcome, `when` names a subject fact that must be truthy for the question to be asked and `unless` one that must not be, `options` names a runtime option set for a choice (`open_issues`, `type_labels`, `commit_types`, `rulings`), and `violates` names the picks of a choice or score that are a finding: for a choice a list of its criteria keys, or `"listed"` for every option of its `options` set but the added `none`, and for a score a list of level indices into its `criteria` (`[0, 1]` for its first two levels). A noul is banded on its probability. A choice or score is banded on what it picked: a pick at or above `hi` is violated when `violates` names it and satisfied otherwise, and a pick below `hi` is unclear. A low-confidence choice or score is never violated, and one without `violates` never is. The issue pack's `duplicate_of` and `blocked_by` mark every open issue as violating, so `none` is never a finding, and its `readiness` marks needs author input and needs triage as violating. A pack with more questions than one request holds goes out in several, the subject repeated in each.

A pack may also carry `rank`, a list of steps run in order before the questions, each one `rank` over a subject list with the state so far as context. A step names the list (`from`, a subject fact), the `questions` asked of every item (`{field}` takes the item's field, `{subject}` the subject's label), `mode` (`batched` unless said), `by` (the question whose value orders and bands the items, the first unless said), `label` (the item field the report names it by, or a template over its fields), `list` (`each`, the default, prints every item in order with every question of the step, `top` the best `top` by value, 20 unless said or overridden by the grade call's `top`, `violated` only the items ruled out with the questions that ruled them out), `order` (`input` shows a top list in input order, `value`, the default, by value), `fields` (the item fields the state carries beside its index, every field unless said. The rest only fill the questions, so a text that is already in the question is not sent twice), `context` (the state fields the items are read against, the whole state unless said. An isolated step repeats them in every request, so a step over many items names the few it needs), `within`: `{ "field": "dir", "of": "path" }` keeps only the items whose `dir` equals the `path` of an item the previous step did not rule out, which makes steps hierarchical, and `feed`, the state field the items the step did not rule out are placed under for the steps and questions after it. Every question of a step is judged for every item, and `by` only orders. A step rules out an item that any of its questions bands violated, and a `top` step everything below the top it shows. The rules pack is one `each` step over the rule paragraphs and locate two `top` steps.

Subject kinds and the checks that read them. Any pack may name any check, and a check whose facts its subject lacks finds nothing, while an unknown check name is reported as an info finding:

| subject | checks |
|---|---|
| `issue` | `issue.labels`, `issue.milestone`, `issue.template`, `issue.parent` |
| `pr` | `pr.linked`, `pr.target`, `pr.branch`, `pr.ci`, `pr.template`, `pr.commits`, `pr.drift` |
| `commit` | `commit.format` |
| `release` | `release.commits`, `release.bump`, `release.changelog` |
| `rules` | `rules.present` |
| `tree` | `tree.indexed` |
| `plan`, `event`, `text` | none |
