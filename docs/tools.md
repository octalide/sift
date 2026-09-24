# Tools and options

## Primitives

sift asks one of two backends a set of typed questions about some state and gets back probabilities, never prose:

- **Jev** (TypeSafe's System One model) when `TYPESAFE_API_KEY` is set. Sub-second, cheap, calibrated.
- **a small model** otherwise, `fallbackModel` (`haiku` by default), through the engine's own client. Slower and less calibrated, but it needs no extra account.

Two primitives sit on that call: `judge`, typed questions over one state, and `rank`, the same questions over many items. Everything else is data over them. A pack is questions and checks over a repository subject (an issue, a pull request, a release, the file tree). The hooks that act inside a session (prune, the outbound gate, classify) and the repository watch are packs and ranks with a policy attached. Every module is a toggle, every module logs what it decided, and every module falls back to the engine's normal behaviour when the judge is unavailable. Correctness never depends on the judge.

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

`rank(items, questions, mode)` asks the same questions of every item in a list and returns the items in input order with their answers, plus a view sorted by one question (`by`, the first question when absent: a noul by its probability, a score by its expected level, a choice by the probability of the key `choice` names, or by the confidence of its pick when `choice` is absent). Items are strings or objects. In a question, `{k}` stands for the item's index, `{text}` for a string item and `{field}` for a field of an object item. `context` is state every item is read against. `fields` names the item fields the state carries beside `k` (every field when absent). The others still fill the questions, so a text the question already quotes is not sent twice.

```json
{
  "items": ["progress 12%", "Error: boom at line 120", "progress 13%"],
  "questions": { "needed": { "type": "noul", "instructions": "Line {k} ({text}) is needed to answer the user." } },
  "mode": "batched",
  "context": { "task": "why did the build fail?" }
}
```

Two modes, both Jev shapes. `batched` fills each request with as many items as fit under the 32k state and 64k request limits and asks one question set per item, so items can see each other and a list costs as few requests as possible. `isolated` sends one request per item, run concurrently, so no item colours another. Prune is `rank` over output chunks, the rules pack is `rank` over the rule documents, locate is `rank` over the file tree, so any pack or session that needs the relevant N of M is data over the same primitive.

Other plugins reach the same calls through `$.sift.judge`, `$.sift.rank` and `$.sift.grade`, typed in `types/sift.d.ts`. `npm run typecheck` holds each type declared there to the one in the code it declares, so a field the code adds or drops fails the typecheck until the declaration follows.

## Tools

The tools are registered under the plugin's name, so the model sees `mcp__sift__grade`, `mcp__sift__judge`, `mcp__sift__rank`, `mcp__sift__watch`, `mcp__sift__prune`, `mcp__sift__post` and `mcp__sift__status`.

| tool | takes | returns |
|---|---|---|
| `grade` | `pack`, `subject`, optional `repo`, `cwd`, `text`, `ref`, `top` | the pack's report as text |
| `judge` | `state`, `questions` | the answers |
| `rank` | `items`, `questions`, optional `mode`, `context`, `by`, `choice`, `fields` | the items with their answers, and the sorted view |
| `watch` | `action`: `subscribe`, `unsubscribe`, `list`, `start`, `status`, `poll`, `pause`, `resume`, `reset`, `deferred`; `repo`, `scope`, `items`, `ci`, `stall`, `until` on `subscribe`; `id` on `unsubscribe`; `for` on `start`; `repo` narrows `poll`, `pause`, `resume`, `reset` and `deferred` | the subscription made, the list, or the pollers' state |
| `prune` | `action`: `off` or `on`; `calls` on `off` | what now holds for the calling loop |
| `post` | `repo`, `kind`, and the fields the write takes: `number`, `tag`, `title`, `body`, `base`, `head`, `draft`, `verdict`, `method`, `target`, `prerelease`; `override`, the reason a write refused under `enforce` goes through | the url of what was written with the verdict under `advise` or an override, or the refusal naming each broken rule and quoting the lines that break it. While the repository's rules are still being found, the url with a note under `advise` and `held: ...` under `enforce`, the advice or the outcome following through the mailbox (see [Outbound text](hooks.md#outbound-text)) |
| `status` | nothing | backend (for jev, where its key came from, the key's last four characters, a shadowed key and a rejected key), modules and the outbound mode, whether the watch runs, decision counts, the outbound ones split into advised, denied and overridden |

`grade`, `judge` and `rank` are registered when the `grade` option is on, `prune` when the `prune` option is on, `watch`, `post` and `status` always. `prune off` keeps the calling loop's Bash and Read output whole until that loop's next task, or for `calls` outputs over the floor, and `on` turns pruning back on there; no other loop is touched (see [Prune](hooks.md#prune)). `watch subscribe` adds a subscription and returns its id (the same subscription again returns the one already there), `unsubscribe` removes one, and `list` shows every subscription with its scope, filter, owner and until, as the `status` tool does. `watch status` shows each poller's state with a count of its subscriptions. `start` subscribes to `repo`, else the caller's repository, with the configured filter, or to one pull request when `for` names it (a number, `#` optional) or one branch (anything else). From a subagent, a `start` with `for` lasts `until: settled` unless it says otherwise. The caller's repository, for `start` and for a `subscribe` that names none, is the one checked out in the directory the calling subagent was spawned in (as for `grade`), else the session's. `poll` polls once now, `reset` forgets a repository's cursor and reseeds.

```
s1 octalide/sift repo · items, ci failures, stall
s2 briar-systems/mach run 17736210453 · items, ci settled, stall · for a1122ff9d641774ba · until settled
s3 briar-systems/mach-http tag v* · items, ci settled, stall
```

## The /sift command

`/sift` prints status and per-module decision counts (the same text as the `status` tool), a judge line naming the backend and, for jev, where its key came from and the key's last four characters (never the key), any other source holding a different key as set but shadowed, and whether jev has rejected the key, with this session's decisions and failures, every one it made, separate from the ring of the last 500 shared by every session running the plugin (`/sift clear` empties both, and the outbound verdicts the gate kept, see [Outbound text](hooks.md#outbound-text)), and a cost line: judge tokens in and out (the backend's own count when it reports one, an estimate otherwise) against context tokens removed by pruning, per session and per module. A module that fell back to the built-in behaviour since the last prompt says so once as context beside the next prompt, so a failing backend is visible while it fails and not as a count afterwards. `/sift log [n]` prints the recent decisions with their scores, `/sift clear` clears them, `/sift prune off [n]` and `/sift prune on` turn pruning off and on for the main loop as the tool does for its caller, and `/sift watch status|list|poll|pause|resume|reset|deferred [repo]`, `/sift watch start [repo] [for <pr|branch>]` (the named repository, else the session's, whole or one pull request or branch), `/sift watch subscribe <repo> [scope]` and `/sift watch unsubscribe <id>` control the watch as the tool does.

## Options

Options live in `/config` under the plugin, or in `settings.json` under `pluginConfigs`, keyed by the full plugin id: `pluginConfigs["sift@sift"].options` for a marketplace install, `pluginConfigs["sift@inline"].options` for a `--plugin-dir` load. A key that names no installed plugin is read by nothing and reports no error, so `/sift` listing fewer modules than you set means the key is wrong. To give one kind of session different options (a watcher session, say), pass a settings file at launch:

```sh
claude --plugin-dir ./sift --settings '{"pluginConfigs":{"sift@inline":{"options":{"watch":true}}}}'
```

Every option, with its default. `/config` shows the shorter descriptions in `.claude-plugin/plugin.json`.

| option | default | what it does |
|---|---|---|
| `backend` | `auto` | `auto` uses Jev when a key is present and the `fallbackModel` otherwise. `jev` and `model` force one, and `jev` with no key judges nothing, as `off` does. `off` disables every judged feature and leaves only mechanical checks |
| `apiKey` | unset | Jev key. Leave unset to read `TYPESAFE_API_KEY` from the environment or the settings `env` block. The option wins over both, and as a sensitive option it is stored in the credentials file of the session's config dir, `$CLAUDE_CONFIG_DIR/.credentials.json` when that variable is set and `~/.claude/.credentials.json` otherwise, not a settings file. A rejection of the option's key names that file. When another source holds a different key, status and every key rejection name it by its last four characters as set but shadowed. A jev refusal with http 401 or 403 reads `jev rejected the key from <source> (ending XXXX); fix: <what to change for that source>`, and after it the jev judge fails every later call with the same text and sends no request until the session restarts, which is also when a new key is read. Status then reads `judge: jev, key rejected from <source> (ending XXXX); fix: ...` |
| `jevModel` | `jev-latest` | TypeSafe model name sent with every Jev request |
| `jevBaseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint. Change it only for a proxy or a compatible local server |
| `fallbackModel` | `haiku` | model used by the model backend, an alias or a full id |
| `shadow` | `false` | every module logs what it would have done and does nothing |
| `prune` | `true` | score long tool outputs against the calling loop's task before the model reads them and drop the chunks the judge marks unneeded. Targeted reads, repeats of pruned output and reads of paths the task names pass whole, and `# sift: full` or the `prune` tool keep output whole on purpose |
| `pruneFloorTokens` | `20000` | tool outputs under this estimated size pass through untouched |
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
| `outbound` | `advise` | how text leaving the session is held to the rules, the same way for `post`, forge writes from the shell and other outbound tool calls (see [Outbound text](hooks.md#outbound-text)). `off` judges nothing: `post` writes unjudged, since it still names its repository where `-R`, `GH_REPO` and a fork's upstream can misroute a shell write, and shell writes and other calls pass. `advise` judges the text against the channel's limit and the repository's rule documents, refuses nothing, and attaches the verdict to the result (`sift outbound (github-pr-create), note: this may break ...`), a shell write's text judged where the command is and the verdict reported beside its output. `enforce` refuses a broken rule or a channel's limit, and a forge write from the shell in favour of `post`, and a `post` carrying `override` with a reason goes through anyway and is logged as an override with the reason, the ruling and the text. Malformed `post` input, an unknown `kind` and a missing `repo` are refused in every mode. While the rules are still being found, `advise` lets a write run at once and its advice follows through the mailbox, and `enforce` holds a `post` until they are known, then writes or refuses it, but refuses a shell write or another tool call unjudged, since sift does not make that call itself and cannot hold it. The verdict that call would meet follows once the rules are known, for the caller to run it again then. `shadow` still turns every mode into logging alone |
| `classify` | `false` | serve the engine's own `model.classify` calls from the judge |
