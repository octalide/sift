# Watch

## Subscriptions

The watch is a set of subscriptions, added and removed at runtime with the `watch` tool, any number at once and across repositories. Each one names a repository and a scope, carries its own filter, and may name the agent it belongs to and when it ends:

```
{ id, repo, scope, filter, for?, until? }
scope  = repo | pr <n> | branch <name> | run <id> | tag <glob>
filter = { items, ci: settled | failures | all | none, stall }
for    = the agent it belongs to, by the agentId SendMessage reaches it by, set when a subagent subscribes
until  = settled | merged | closed | <iso time>
```

`repo` covers the whole repository, `pr <n>` one pull request across every head it moves to (its item events, the runs on its heads and its verdicts), `branch <name>` the runs of one branch, `run <id>` one run, and `tag <glob>` the runs on tags matching the glob (`*` any run of characters, `?` one). `items` (default on) takes issue and pull request events in scope, `stall` (default on) takes `ci stalled`, and `ci` defaults to `watchCi`. A subscription with `until` is removed on its own: `settled` once its verdict (a completed run, outside a `pr` scope) is delivered, `merged` or `closed` once its pull request is, a time once it passes. A `run <id>` subscription is removed once its run's completion is delivered, `until` or not, since a run completes only once. A subscription made from a subagent belongs to it and outlives the agent's turn, since a delivery resumes the agent (below). It goes by its `until`, by `unsubscribe`, or once the engine refuses a SendMessage to its agent, which retires every subscription that agent owns. The subscriptions live in the plugin store under the session, so a plugin reload or `/clear` keeps them. When the session ends they are removed with the rest of its watch state, and a session that did not end cleanly (a crash, a killed process) is removed once it has gone unseen for 7 days: a running session marks itself seen every hour, and each session's start removes the others' that are older.

## Polling and rules

There is one poller per repository, started with its first subscription and stopped with its last. It polls through the forge with conditional requests, so idle polls are free, and adapts the interval between `watchMinInterval` and `watchMaxInterval`. N repositories cost N probe sets per interval, and the rate floor is per session: once any of a session's pollers reads the token's remaining calls below it, every poller of that session waits for the window to refill. Another session on the same token is not held by it, and reads the low count on its own next poll. Every change is one event, and each event is matched against the repository's subscriptions, scope first, then filter. An event no subscription takes is dropped, one several take is delivered once, naming each. A `run` subscription reads its run by id each poll until it completes, so a run that pages out of the newest runs on a busy repository still delivers, and a run already complete when it is subscribed to delivers on the next poll.

With `watch: true` each repository in `watchRepos` (the session's own when empty) is subscribed whole at boot with the configured filter. Rules settle what needs no judgement: a PR whose checks have all finished delivers once as `ci settled <conclusion>` (pass or fail, even when you pushed the commit), runs on other branches deliver on failure when the branch is protected or matches the work branch pattern and defer on success, bot activity drops (`watchIgnoreBots`), your own writes defer (`watchIgnoreSelf`, keyed on the forge login), new PRs deliver, a new issue is checked against the issue pack and delivers with its findings when it fails one (own writes otherwise defer under `watchIgnoreSelf`), a merge or a reopen delivers, a close defers. New issues, comments, body and title edits and other activity go through the `triage` pack (`watchTriage`), and an event whose `actionable` lands in the violated band is deferred. Anything else, label churn included, defers as housekeeping.

## Deliveries

A delivery is one prompt, each event ending with the subscriptions it matched:

```
[sift watch octalide/sift]
issue #41 comments 2->3: watcher misses review comments
  by alice · https://github.com/octalide/sift/issues/41 · actionable 0.93, kind question, urgency now · s1
deferred meanwhile: 2 housekeeping, 1 ci success
```

## CI verdicts

A settled PR is one line with the aggregate verdict, so a steward waiting to grade, mark ready and merge needs no `gh pr checks` loop of its own:

```
[sift watch octalide/sift]
ci settled success: pr #14 feat/14 @3f2a9c1: Watch delivers a settled CI verdict (3 checks) · now: open, head unchanged
  by octalide · https://github.com/octalide/sift/pull/14 · ci settled on pr · s1
```

A failure carries the `ci` pack's report on each failed check, one job per check, read from its log through the forge, so the session that pushed the commit reads why it failed without opening the log. A check that failed only because a job it needs failed is named in one line instead (`gate: failed because docs failed`), since that job has its own report:

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

CI news that a newer result has made old is dropped rather than delivered late. Each CI event reports on a subject, `pr:<n>` when it ran on a head of that PR (the current head or one it has since moved from) and `branch:<name>` otherwise, and a run is keyed by its subject and its workflow, so a docs run is superseded only by a newer docs run. When a run completes, every held or undelivered event of an older run with the same key is dropped, as is an earlier completion of the same run when it completes again, and a settled verdict on a PR head drops everything held for the PR's older heads and the runs held for that head. Each drop is recorded in the decision log as a `watch drop` with its reason (`superseded by run 17`), which `/sift log` shows. A run on a tag reports on `tag:<name>`: the forge says whether a run's ref is a tag (GitHub, whose runs name the ref alone, by one tag lookup per ref name, remembered for the session). An event that ages out is read again first: a run held on a PR head that has since moved is dropped, a head whose checks have all finished since delivers its `ci settled` line in place of the runs held for it (one checks read per head), and a run on a branch with a newer completed run of its workflow is dropped (one run listing per branch). Only what survives is delivered.

Every CI line ends with where its subject stands at delivery rather than at the event: `now: open, head unchanged`, `now: open, head @<sha> (moved)`, `now: merged`, `now: closed` (or `not open` when the watch never saw the PR's state) for a PR, and the newest completed run of the event's workflow for a branch, `now: dev @9f8e7d6, docs success`. It is read from the open PR heads and the item cache the poll already holds, so it costs no request:

```
[sift watch octalide/sift]
ci failure: docs on dev @1a2b3c4 (push) · now: dev @1a2b3c4, docs failure
  by octalide · https://github.com/octalide/sift/actions/runs/17 · ci failure on watched branch · s1
```

A subscription's `ci` sets what CI reaches it: `failures` (the default, from `watchCi`) delivers each open PR once when every check on its head has finished, pass or fail, and failed runs (on a `repo` subscription, only those on protected branches or branches matching the work pattern), `settled` delivers the verdicts and, on a `branch`, `tag` or `run` subscription, every completed run, `all` delivers every completed run as well, `none` delivers no CI. A `run` subscription takes its run's completion under any of them but `none`, and nothing newer supersedes it. Deferred events ride along as a digest on the next delivery, and any deferred event older than `watchDeferMaxAgeHours` that is not superseded is delivered on its own. `watchDelivery: "log"` writes transcript lines instead of prompts. The cursor, item cache, open PR heads and deferred list live in the plugin store under the session and repository, beside the session's subscriptions, so a plugin reload picks up where it left off, and two sessions watching one repository each keep their own and never move each other's cursor.

## Delivery to subagents

Each poll's deliveries are split by recipient. Events matched by subscriptions that no agent owns go to the session's main loop as one prompt. Events matched by an agent's subscriptions go to that agent, which is addressed by its agentId. An event that several recipients' subscriptions match goes to each of them. Each delivery lists only its recipient's subscription ids and the digest of that recipient's held events. The recipient is named by the channel alone, never in the text, so a delivery's header is always `[sift watch <repo>]`.

A subagent's delivery reaches it by one of three channels, in this order:

1. **Its next tool call.** The delivery is attached to the result of the next tool call the agent makes, whichever tool it is, as context the agent reads after that result. Taken this way, it goes nowhere else.
2. **A SendMessage.** If the agent makes no tool call within 60 s, or has already ended its turn (the engine lists it as completed, failed or killed, or not at all), the plugin raises a SendMessage to its agentId. The engine queues it for a running agent's next tool round, and resumes an agent that has finished. Deliveries that waited together go as one message.
3. **A relay.** Only when the engine refuses that SendMessage does the delivery go to the main loop, in a fixed block. The block names the recipient, says why the SendMessage was refused, and carries the delivery complete. The agent's subscriptions are then retired, since nothing can reach it:

```
[sift watch relay] to: a1122ff9d641774ba
SendMessage refused: <the engine's reason>
[sift watch briar-systems/mach]
ci settled success: pr #3770 feat/3770 @3f2a9c1: ... (4 checks) · now: open, head unchanged
  by octalide · https://github.com/briar-systems/mach/pull/3770 · ci settled on pr · s2
```

So a subagent that waits on CI subscribes (`watch start` with `for`, or `subscribe`), then carries on or ends its turn: the verdict resumes it. It never blocks or polls. A tool call cannot wait for it anyway, since the engine caps a hook at 10 s. The `watch` tool's answer to a subagent's subscribe says this. Deliveries still waiting for their agent are kept in the plugin store, so a reload loses none, and `status` lists them. Under `watchDelivery: log`, every delivery is written to the transcript instead, an agent's under a `sift watch to <agentId>:` line. Nothing about agent names or branch conventions is inferred. A session that will act on repository events calls `status` at start to learn whether they will arrive as prompts.
