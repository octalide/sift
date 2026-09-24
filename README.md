# sift

A Claude Code plugin that makes typed judgement calls where a session would otherwise spend a model turn, or spend context it does not need.

sift asks a backend typed questions about some state and gets back probabilities, never prose. The backend is Jev (TypeSafe's System One model) when `TYPESAFE_API_KEY` is set, and a small model through the engine's client (`haiku` by default) otherwise. On that one call sit packs that grade issues, pull requests, plans, commits, releases and rules, a repository watch, tool output pruning and an outbound text gate. Every module can be switched off, logs what it decided, and falls back to the engine's normal behaviour when the judge is unavailable.

## Install

Function hooks are early access and must be switched on:

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
export TYPESAFE_API_KEY=...        # optional, the model backend is used without it

claude plugin marketplace add octalide/sift
claude plugin install sift@sift
```

Or clone it and load it directly:

```sh
git clone https://github.com/octalide/sift
claude --plugin-dir ./sift
```

Options are set in `/config` under the plugin. [Options](docs/tools.md#options) lists them all and shows how to set them in `settings.json`.

## Quick start

```
/sift                                     # backend, modules, watch and decision counts
grade(pack: "issue", subject: "17")       # is issue 17 ready to work on
grade(pack: "pr", subject: "dev..HEAD")   # the PR this branch would open, before it exists
```

The model calls these as `mcp__sift__grade` and the other tools below. To have repository events delivered as prompts, turn on the `watch` option or subscribe at runtime with the `watch` tool.

## Packs

| pack | answers |
|---|---|
| `issue` | is the issue well formed, typed, scoped to this repo, implementable and ready |
| `pr` | is the PR linked, targeted, named, templated, committed and checked as the repo requires (mechanical) |
| `plan` | does a plan cover its issue, add nothing and decide nothing the issue leaves open |
| `commit` | do the commit messages follow the repo's format (mechanical) |
| `rules` | does an issue or text comply with the repo's rule documents |
| `release` | are the commits since the last tag safe to ship, and do the bump and changelog agree |
| `triage` | does a watch event need acting on now |
| `locate` | which files to read or change for an issue or text |

A repository can override these or add its own under `.sift/packs/`. See [Packs](docs/packs.md).

## Tools

| tool | does |
|---|---|
| `grade` | runs a pack on a subject and returns its report |
| `judge` | asks typed questions about one state |
| `rank` | asks the same questions of every item in a list |
| `watch` | adds, removes and lists repository subscriptions |
| `post` | writes an issue, PR, comment, review, merge or release after judging its text against the target repo's rules |
| `prune` | turns output pruning off or on for the calling loop |
| `status` | backend, modules, watch and decision counts |

The `/sift` command offers the same controls. See [Tools and options](docs/tools.md).

## Hooks and watch

- **prune** (on) drops the chunks of long Bash and Read output that the current task does not need.
- **outbound** (advise) holds `post`, forge writes from the shell and other outgoing text to the repo's rules: `off` judges nothing, `advise` judges and attaches the verdict, `enforce` refuses a broken rule and points shell writes at `post`.
- **classify** (off) answers the engine's own small classifications from the judge.
- **watch** (off) polls repositories for issues, pull requests, comments and CI, and delivers what needs acting on as prompts, to the main loop or to the subagent that subscribed.

See [Hooks](docs/hooks.md) and [Watch](docs/watch.md).

## Documentation

- [Packs](docs/packs.md): the built-in packs, subjects, reports and repo-defined packs
- [Conventions](docs/conventions.md): `.sift/config.json`, commit, branch and release conventions, rule documents
- [Hooks](docs/hooks.md): prune, outbound text and the `post` tool, classify
- [Watch](docs/watch.md): subscriptions, polling, delivery and CI verdicts
- [Tools and options](docs/tools.md): the primitives, every tool, the `/sift` command and every option
- [Calibration](docs/calibration.md): tuning thresholds with `shadow`
- [Development](docs/development.md): building, testing, releasing and the forge layer
- [Changelog](CHANGELOG.md)

Jev is in early access, with a waitlist at typesafe.ai. Without a key the model backend works, but it is slower, costs model tokens, and its probabilities are stated rather than calibrated.

MIT licensed, see [LICENSE](LICENSE).
