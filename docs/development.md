# Development

```sh
npm install
npm run typecheck      # src and tests, then hooks against types/claude-code.d.ts
npm test               # vitest, pure logic only
npm run validate       # claude plugin validate
npm run smoke          # loads the hooks module in a headless session, fails on any engine refusal
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

CI runs the same four commands on every pull request and reports them through a `gate` check, which the rulesets on `dev` and `main` require. The smoke run needs no credentials: the engine loads the plugin and runs `session.start` before it asks for auth, so the session fails to log in after the load has been checked and no model is called.

`types/claude-code.d.ts` is the engine's generated declaration. Regenerate it with `/plugin-types` after a Claude Code upgrade and rerun the typecheck. The function-hook surface is early access and changes between releases.

## Changes and releases

Every user-visible change adds its entry under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md), in the same pull request. A release is one `chore(release): <version>` commit, landed on `dev` by pull request, that renames `[Unreleased]` to `[<version>] - <date>`, opens a new empty `[Unreleased]` above it, and sets the version in `package.json`, `package-lock.json` and `.claude-plugin/plugin.json`. `dev` is then merged into `main` by pull request, and that merge is tagged `v<version>`. `.sift/config.json` names the changelog, so `grade(pack: "release", subject: "v<version>")` checks that it moved.

## Forge

Nothing above the code host layer names a host. Every read and write of a repository goes through the `Forge` interface in `src/forge/forge.ts`: the checkout's repository and default branch, the login, issues and their parents (an issue read by number says whether the number names a pull request), comment threads with each commenter's standing and whether that standing maintains the repository, pull requests with their diffs, commits, closing issues, reviews and checks, runs and jobs and a job's log by step, tags and compares, file trees and contents at a ref, templates, the writes `post` makes on a named repository (each answering the url of what it made), and which shell commands write text through its own cli or api, so the outbound gate can refuse them. A repository is the forge's own path for it, opaque above this layer, and a forge names its artifacts in its own words (`GitHub issue`, `merge request`) for the judge.

GitHub, over `gh`, is the one member today. The shapes are held to what a second member (GitLab, with merge requests, pipelines and project paths with slashes) can also answer, so adding one is a new class behind the interface, not a change to the packs, the watch or the gate.
