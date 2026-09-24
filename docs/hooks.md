# Hooks

Three modules act inside the session without being asked.

| module | hook | what it does | default |
|---|---|---|---|
| `prune` | `tool.call` (post) | scores long Bash and Read output in chunks before the model reads it and drops the chunks that are not needed | on |
| `gateOutbound` | `tool.call` (pre) | refuses forge writes made from the shell in favour of `post`, and checks other text about to leave the session against the channel's length limit and the repository rule documents, denying a broken rule | off |
| `classify` | `model.classify` | answers the engine's own small classifications from the judge | off |

`shadow: true` makes every module log what it would have done without doing it. Use it to calibrate thresholds against your own traffic before trusting them.

## Prune

Output over `pruneFloorTokens` (estimated, 20000 by default, so only genuinely large output is judged) from the tools in `pruneTools` is split into chunks of `pruneChunkLines` lines and ranked, batched, against the calling loop's task: is this chunk needed for the current task. A chunk below `pruneKeepThreshold` is dropped. Nothing is kept on disk. In its place stands a one-line note with the omitted line range, how to get it back, and how to keep such output whole:

```
[sift: lines 51-75 (25 lines) omitted as not needed for the current task, re-read src/watch/watcher.ts with offset 51 limit 25, or call mcp__sift__prune off to read files whole]
[sift: lines 120-180 (61 lines) omitted as not needed for the current task, rerun the command for the full output, or end a command with # sift: full to keep its output whole]
```

Sizes are estimated without a tokenizer, with a rule calibrated against Jev's reported usage (from fast-jev-compaction, MIT).

For a Read the range is in file lines (the call's offset is applied), so the re-read named by the note lands on the omitted text. A judge failure passes the output through untouched.

A Read is pruned only at its tail. The engine numbers a Read's content consecutively from its one `startLine` and cannot show a gap, so a note in front of kept lines would shift every line after it off its file line. A Read keeps every chunk up to its last needed one, the single note goes last, and `numLines` is the number of lines returned. A Read whose low chunks all sit in front of a needed one passes whole, logged as `prune none` with `gap would misnumber lines`. Bash output has no line numbers and is pruned anywhere.

The task is the calling loop's own. In a subagent it is the prompt the subagent was spawned with, recorded by the `agent.spawn` hook under its agentId. In the main loop it is the newest prompt a person submitted (origin `composer`, `bridge` or `sdk`); a plugin's prompt such as a watch delivery, a task notification, a peer session's message and `/sift` itself leave it as it was. A loop with no recorded task (a subagent spawned before the plugin loaded) is not pruned.

Before any judge call, prune backs off mechanically, at no cost, and passes the output untouched when:

1. a Read has `offset` or `limit`: the read is targeted,
2. a Read of a path, or a Bash command, had output dropped earlier in this loop's task: a re-read means the prune was wrong for this task, so it stays whole for the rest of the task,
3. a Read is of a path the loop's task names, whole or as a path's tail (`hooks/sift.ts`, `README.md`, a `:line` suffix ignored).

Each back-off is logged as `prune none` with its reason, so `/sift log` shows why. To keep output whole on purpose, a Bash command that carries the marker `# sift: full` is not pruned, and the `prune` tool turns pruning `off` for the calling loop alone, until its next task (for a subagent, the rest of its run) or, with `calls`, for that many outputs over the floor, and `on` again. `/sift prune off [n]` and `/sift prune on` do the same for the main loop from the prompt.

## Outbound text

Text for a forge goes through the `post` tool, which names its destination: `repo` (owner/name) and `kind`, one per forge write (`issue-create`, `issue-comment`, `issue-edit`, `pr-create`, `pr-comment`, `pr-edit`, `pr-review`, `pr-merge`, `release-create`, `release-edit`), with the fields that write takes (`number`, `tag`, `title`, `body`, `base`, `head`, `draft`, `verdict`, `method`, `target`, `prerelease`). The text (title and body) is judged against the rule documents of the repository named, read from the forge at its default branch, under that repository's `.sift/config.json` and its `outbound.channels`, whatever directory the caller runs in, then written there through `gh api repos/<repo>/...` and the url returned. A broken rule or a channel's limit refuses the write, and nothing is written. A write with no text (a merge that keeps the default message, an approval with no body) is made without a judge call. The rules pack is the caller's, as for a `grade`. `post` judges whether or not `gateOutbound` is on, and `shadow` logs what it would have refused and writes.

Every character written is judged. Text longer than a rules subject's room holds (15,000 tokens for jev, see [the room a subject has](packs.md#the-room-a-subject-has)) is judged in parts, each within that room, which concatenate back to the exact text: split at its markdown headings (outside code fences), a section over the limit at its paragraphs, a paragraph over it at its lines, and adjacent pieces packed together while they fit. The opening part, where a post's title is, is judged against every rule, so a rule about the whole text (links its issue, states its impact) is judged once, there. Every later part is asked whether it breaks each rule, with a rule about the whole text judged on the opening and not broken by a part that lacks it. A rule broken in any part refuses the write, quoted and named by the part: `breaks: No em dashes. (in part 3 of 3 ("Fixes" to "Docs"))`. The channel's length limit is checked on the whole text first, without a judge call.

With `gateOutbound: true` a Bash command that writes forge text itself is refused, with the `post` call to make instead. On GitHub that is `gh pr|issue create|comment` (and `new`), `gh pr|issue edit`, `gh pr review` and `gh pr merge` with a body, body file, title or subject flag, `gh release create`, `gh release edit` with notes or a title, and `gh api` calls that make the same writes: a REST path under `repos/<owner>/<repo>/` for issues, issue and review comments, pulls, reviews, merge and releases by method (an edit, review or merge only with a `body`, `title`, `name`, `commit_title` or `commit_message` field, or `--input`), and a graphql query whose `mutation` names one (`createIssue`, `addComment`, `createPullRequest`, `addPullRequestReview`, `mergePullRequest` and the like). The command line is read the way the shell splits it, so a write after `cd x &&`, inside `$( )` or backticks is found, and a heredoc body or a quoted string that only mentions one is not. Reads, and writes with no text (labels, closing, a merge with the default message), pass. A graphql query read from a file, and a command run through `bash -c` or `eval`, are not looked into. The destination of a shell write is whatever `-R`, `GH_REPO`, the working directory or a fork's upstream make it, which is why it is refused rather than judged.

A subagent keeps the tool list it was spawned with, so one spawned before sift registered `post` (a subagent from before a reload that added it, or before the plugin loaded) cannot call it, and refusing its shell write would leave it no way through. The `agent.spawn` hook records the tools each subagent was offered, kept in the plugin store under the session so a reload keeps them, and a loop whose record lacks `post` (or that has no record) has its shell write judged on its text instead. The text is read by the forge's shell channels (`github-shell-pr-comment` and the rest, one per write, `tool: ^Bash$`, the command form below) and judged against the rules of the checkout the gate reads, as for any other tool, and the refusal of a broken rule says it was judged in place of `post`. A write whose text no shell channel reads (a `gh api` call's fields) is refused with the command form that can be read, and a body on stdin with no heredoc is denied as on any shell channel. The main loop always sees `post`, so its shell writes are always refused.

A reload starts a new plugin environment, and until its `session.start` has bound the session (the checkout, the forge, the judge) its hooks have nothing to judge with. In that window a shell write from a loop, `grade`, `judge`, `rank` and `watch` are refused with a line saying sift is starting or reloading, where before a shell write passed ungated and the tools failed without an answer. Run the call again in a moment.

With `gateOutbound: true` the text any other tool call is about to send is checked before the call runs. Where text leaves the session is a table of channels, one entry per place: a `name` a config entry replaces it by, a `tool` regex over the tool name, where the `text` is in the call, an optional hard `limit` in characters, and `kind`, what the text is in the words the rules question names it by. The text is either `{ "fields": [...], "when": {...} }`, the named fields of the tool input joined in order on a call whose input holds every value `when` names, or for a shell command `{ "command": <regex>, "body": [flags], "file": [flags] }`: the value after a body flag, a quoted word or a `$(cat <<'EOF' ... EOF)` heredoc, else the file named by a file flag, read before the command runs, or when that file is `-` the `<<'EOF' ... EOF` heredoc on the command's stdin. A body from stdin with no heredoc in the command, or from an unreadable file, is denied without a judge call. The first channel whose tool and text match decides.

The default table ships four Discord channels at 2000 characters each: `discord-message` (the `content` of `send_message`, `edit_message` and `send_webhook_message`), `discord-dm` (`send_dm`), `discord-forum-post` (`create_forum_post`) and `discord-embed` (the description and title of `send_embed` and `send_dm_embed`). It also ships one entry per `post` kind, named `github-pr-comment`, `github-release-create` and so on, with the text in `title` and `body` when `kind` is that write, and its `kind` (`a comment on a pull request`, `a review on a pull request`, `a merge commit message`, `the title and notes of a new GitHub release`). A repository's config sets a limit on its own posts by replacing one of these by name. `outbound.channels` in the config adds entries to the table, or replaces a default entry of the same name:

```json
"outbound": {
  "channels": [
    { "name": "slack", "tool": "^mcp__slack__post_message$", "text": { "fields": ["text"] }, "limit": 40000, "kind": "a Slack message" },
    { "name": "gitlab-mr-note", "tool": "^Bash$", "text": { "command": "^glab\\s+mr\\s+note\\b", "body": ["--message", "-m"] }, "kind": "a note on a merge request" },
    { "name": "discord-message", "tool": "^mcp__discord__send_message$", "text": { "fields": ["content"] }, "limit": 1000, "kind": "a Discord message" }
  ]
}
```

For every tool but `post`, the gate reads one checkout, the one a `grade` with no `cwd` reads: the directory the calling subagent was spawned in, else the session's repository. Its `outbound.channels`, its `rules` pack and its rule documents apply, so a subagent spawned in a worktree of another repository is gated by that repository's rules, and the main loop and a subagent spawned without a `cwd` by the session's. A directory in no repository has no config or rule documents of its own, so a subagent spawned there is gated by the defaults and the global config alone. A `cd` inside a Bash command does not move the binding.

The channel's limit is mechanical and denies without a judge call. The rules pack then runs over the text with the same rule documents as `grade rules`, each question naming the channel's `kind`, so a pull request rule read against an issue body is answered as not applying rather than broken: a violated rule denies with the rule quoted, an unclear one logs a warning, and the judge being unavailable allows. `shadow` logs what would have been denied.

The gate keeps every verdict it judged in full, for `post` and every other channel alike, in the plugin store every session shares (the last 500). It is keyed by everything the verdict read: the text, the channel and its kind, every part the text was judged in with the rules it was judged against, the rules pack's questions and the judge. A judge's answer near a band's edge varies between asks, so the same text sent again to the same repository under the same rules meets the verdict it met before without a judge call, and a changed text, rule document or pack is judged afresh. A verdict the judge could not give (an outage, or rule discovery still running) is never kept.

## Classify

With `classify: true` the engine's own `model.classify` calls (a text and a list of labels) are answered by one choice question to the judge. A judge failure, or an answer that is not a choice, falls through to the engine's own model.
