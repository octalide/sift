import type { Pack } from './types.ts';

// the reference packs. a repo overrides any of them with .sift/packs/<name>.json in the same shape
export const BUILTIN_PACKS: Record<string, Pack> = {
  issue: {
    name: 'issue',
    subject: 'issue',
    description: 'Is this issue well formed, correctly typed, scoped to this repo, and ready to work on?',
    checks: ['issue.labels', 'issue.milestone', 'issue.template', 'issue.parent'],
    questions: {
      substantive: {
        type: 'noul',
        instructions: 'The body describes a concrete problem or change with enough detail that someone could start work without asking what is meant.',
        criteria: {
          true: 'The body states what is wrong or wanted, where, and what done looks like.',
          false: 'The body is placeholder text, the title restated, or a single sentence with no context.',
        },
        severity: 'warn',
      },
      implementable: {
        type: 'noul',
        instructions: 'A competent engineer could implement this from the body without making a decision the body does not make.',
        criteria: {
          true: 'Every choice the work turns on is settled in the body: one design, named interfaces, stated behaviour on the edges it raises.',
          false: 'The body leaves a decision open: two valid designs it does not choose between, an interface it needs but does not name, or an edge case whose behaviour it does not state.',
        },
        severity: 'fail',
      },
      scope_clear: {
        type: 'noul',
        instructions: 'The body states what is in and out of scope, so a reviewer could reject an unrelated change to the PR that implements it.',
        criteria: {
          true: 'The body bounds the change: what it touches, what it leaves alone, or what done looks like, clearly enough that a change outside it is recognisable.',
          false: 'The body names a goal with no bounds, so any change in its area could be argued to belong.',
        },
        severity: 'warn',
      },
      type: {
        type: 'choice',
        instructions: 'Which kind of issue is this, judged from the title and body alone?',
        options: 'type_labels',
        severity: 'info',
      },
      single_repo: {
        type: 'noul',
        instructions: 'The requested change can be completed entirely within this repository.',
        criteria: {
          true: 'Everything the issue asks for lives in this repository.',
          false: 'The issue requires a change in another named repository or an upstream dependency first.',
        },
        severity: 'warn',
      },
      needs_parent: {
        type: 'noul',
        instructions: 'This issue reads as one part of a larger effort that should be tracked by a parent issue.',
        severity: 'info',
      },
      duplicate_of: {
        type: 'choice',
        instructions: 'Which open issue, if any, asks for the same change as this one?',
        options: 'open_issues',
        when: 'has_others',
        severity: 'warn',
        hi: 0.7,
      },
      blocked_by: {
        type: 'choice',
        instructions: 'Which open issue, if any, must be resolved before work on this one can start? Only when the title or body says it depends on that issue, or the same code must change there first. Otherwise none.',
        options: 'open_issues',
        when: 'has_others',
        severity: 'info',
      },
      readiness: {
        type: 'score',
        instructions: 'How ready is this issue to be worked on?',
        criteria: [
          'needs author input: the request cannot be understood or has contradictory requirements',
          'needs triage: understandable but missing scope, acceptance criteria, or a decision',
          'ready: clear enough to start implementing now',
        ],
        severity: 'info',
      },
    },
  },
  pr: {
    name: 'pr',
    subject: 'pr',
    description: 'Does this PR do what its issue asks, nothing more, without workarounds, and is it safe to merge?',
    checks: ['pr.linked', 'pr.target', 'pr.branch', 'pr.ci', 'pr.template', 'pr.commits', 'pr.drift'],
    questions: {
      addresses_issue: {
        type: 'noul',
        instructions: 'The diff implements what the linked issue asks for.',
        criteria: {
          true: 'The diff does what the issue asks, or explains what it leaves out.',
          false: 'The diff solves a different problem, or only part of the issue with no explanation.',
        },
        when: 'has_issue',
        severity: 'fail',
      },
      scope_creep: {
        type: 'noul',
        instructions: 'The diff changes files or behaviour unrelated to the stated purpose of the PR.',
        criteria: {
          true: 'The diff carries unrelated refactors, formatting sweeps, or drive-by fixes in other subsystems.',
          false: 'Every change serves the stated purpose, including small changes needed to make the main change compile.',
        },
        inverted: true,
        severity: 'warn',
      },
      workaround: {
        type: 'noul',
        instructions: 'The diff patches a symptom rather than its cause: a defensive fallback, a swallowed error, a special case added where a general fix was needed, or a TODO left in place of the fix.',
        inverted: true,
        severity: 'warn',
      },
      contract_change: {
        type: 'noul',
        instructions: 'The diff changes a public interface, file format, CLI surface, or protocol that code outside this repository could depend on.',
        inverted: true,
        severity: 'info',
      },
      tests_cover: {
        type: 'noul',
        instructions: 'The behaviour the diff adds or changes is exercised by tests in the same diff or by existing tests it visibly updates.',
        when: 'has_diff',
        severity: 'info',
      },
      risk: {
        type: 'score',
        instructions: 'How likely is this PR to break something that works today?',
        criteria: [
          'low: additive or isolated, easy to revert',
          'medium: touches shared code paths or state',
          'high: changes core logic, data formats, or concurrency, or is very large',
        ],
        severity: 'info',
      },
    },
    // each file the base also changed since the branch point, the two patches side by side
    rank: [
      {
        from: 'drift',
        label: 'path',
        list: 'each',
        questions: {
          drift_collides: {
            type: 'noul',
            instructions: 'The pull request\'s patch to {path} and the base branch\'s patch to it conflict in meaning: merging both would leave the file wrong even where the lines do not overlap.',
            criteria: {
              true: 'One side changes what the other relies on: a renamed or removed symbol the other still uses, the same behaviour changed two ways, a contract one side extends and the other rewrites.',
              false: 'The two patches touch independent parts of the file, or make the same change, and both stand after a merge.',
            },
            inverted: true,
            severity: 'warn',
          },
        },
      },
    ],
  },
  hunks: {
    name: 'hunks',
    subject: 'pr',
    description: 'Which hunk of this PR is wrong: unrelated to its stated purpose, a workaround, or a behaviour change no test covers?',
    checks: [],
    questions: {},
    // one request per hunk, so no hunk colours another: the hunk is read against the stated purpose and the map of the whole change
    rank: [
      {
        from: 'hunks',
        mode: 'isolated',
        list: 'violated',
        label: '{file} {header}',
        context: ['title', 'body', 'linked_issue', 'commits', 'changes'],
        questions: {
          unrelated: {
            type: 'noul',
            instructions: 'The hunk {header} of {file} does not serve the stated purpose of the pull request.',
            criteria: {
              true: 'The hunk is an unrelated refactor, a formatting sweep, or a drive-by fix in another subsystem that the title, body, linked issue and commits do not call for.',
              false: 'The hunk does part of what the pull request says it does, or is the small change needed to make that compile, build or read right.',
            },
            inverted: true,
            severity: 'warn',
          },
          workaround: {
            type: 'noul',
            instructions: 'The hunk {header} of {file} patches a symptom rather than its cause: a defensive fallback, a swallowed error, a special case added where a general fix was needed, or a TODO left in place of the fix.',
            inverted: true,
            severity: 'warn',
          },
          untested: {
            type: 'noul',
            instructions: 'The hunk {header} of {file} changes behaviour and no hunk of the diff adds or changes a test for it.',
            criteria: {
              true: 'The hunk changes what the code does and none of the hunks listed under changes, judged by their file and header, touches a test of that behaviour.',
              false: 'The hunk changes no behaviour (a comment, a type, a rename, documentation, a test itself), or a hunk under changes visibly tests what it changes.',
            },
            inverted: true,
            severity: 'warn',
          },
        },
      },
    ],
  },
  commit: {
    name: 'commit',
    subject: 'commit',
    description: 'Do these commit messages follow the repository\'s commit format and describe their diffs honestly?',
    checks: ['commit.format'],
    questions: {
      type_matches: {
        type: 'choice',
        instructions: 'Which type from the repository\'s commit format does the diff actually warrant?',
        options: 'commit_types',
        when: 'has_diff',
        severity: 'info',
      },
      describes_change: {
        type: 'noul',
        instructions: 'The commit subject line accurately describes what the diff does.',
        criteria: {
          true: 'The subject names the change the diff makes, at the scale the diff makes it.',
          false: 'The subject names a different change, is vague (update, fix stuff, wip), or claims more than the diff does.',
        },
        when: 'has_diff',
        severity: 'warn',
      },
      breaking_missed: {
        type: 'noul',
        instructions: 'The diff removes or changes a public interface in a way that breaks existing callers, yet the message does not mark it as breaking.',
        when: 'has_diff',
        inverted: true,
        severity: 'fail',
      },
    },
  },
  release: {
    name: 'release',
    subject: 'release',
    description: 'Are the commits since the last release safe to ship as described, and when a version scheme and changelog are configured, do they agree?',
    checks: ['release.commits', 'release.bump', 'release.changelog'],
    questions: {
      hidden_breaking: {
        type: 'noul',
        instructions: 'At least one commit since the last tag describes a change that breaks existing users but is not marked as breaking.',
        when: 'has_commits',
        inverted: true,
        severity: 'fail',
      },
      changelog_complete: {
        type: 'noul',
        instructions: 'The text added to the changelog since the last tag describes every user-visible change among the commits.',
        when: 'changelog_changed',
        severity: 'warn',
      },
    },
  },
  rules: {
    name: 'rules',
    subject: 'rules',
    description: 'Does the subject comply with each rule stated in the repository rule documents?',
    checks: ['rules.present'],
    questions: {},
    // the rule goes out once, in the question; the state item is its index alone
    rank: [
      {
        from: 'rules',
        fields: [],
        questions: {
          rules: {
            type: 'noul',
            instructions: '{subject} complies with this rule: {text}',
            criteria: {
              true: 'The subject follows the rule, or the rule does not apply to it at all (answer near 0.5 then): a rule written for another kind of artifact, such as a pull request rule read against an issue body or a comment, does not apply.',
              false: 'The subject does something the rule forbids or omits something it requires.',
            },
            severity: 'warn',
            lo: 0.3,
            hi: 0.6,
          },
        },
      },
    ],
  },
  locate: {
    name: 'locate',
    subject: 'tree',
    description: 'Which files must be read or changed to implement this?',
    checks: ['tree.indexed'],
    questions: {},
    // directories first, then the files of the directories not ruled out, so each rank reads only what could matter
    rank: [
      {
        from: 'dirs',
        label: 'path',
        list: 'top',
        questions: {
          holds: {
            type: 'noul',
            instructions: 'Files needed to implement this are in the directory {path}.',
            criteria: {
              true: 'Implementing the text means reading or changing at least one file that lives directly in this directory, judged from its name and the files it holds.',
              false: 'Nothing in this directory bears on the text: unrelated code, assets, generated output, or tooling the change does not touch.',
            },
            severity: 'info',
            lo: 0.25,
            hi: 0.6,
          },
        },
      },
      {
        from: 'files',
        within: { field: 'dir', of: 'path' },
        label: 'path',
        list: 'top',
        questions: {
          needed: {
            type: 'noul',
            instructions: 'The file {path} must be read or changed to implement this.',
            criteria: {
              true: 'The change lands in this file, or the file defines what the change builds on and must be read first.',
              false: 'The file is unrelated to the text, or a general dependency anyone would already know.',
            },
            severity: 'info',
          },
        },
      },
    ],
  },
  plan: {
    name: 'plan',
    subject: 'plan',
    description: 'Does this plan cover what its issue asks for, nothing more, without deciding anything the issue leaves open?',
    checks: [],
    questions: {
      covers: {
        type: 'noul',
        instructions: 'The plan addresses every point the issue asks for.',
        criteria: {
          true: 'Each thing the issue asks for is met by a step of the plan, or the plan says why it is left out.',
          false: 'The issue asks for something no step of the plan meets and the plan does not say why.',
        },
        severity: 'fail',
      },
      adds_nothing: {
        type: 'noul',
        instructions: 'The plan includes work the issue does not ask for.',
        criteria: {
          true: 'A step of the plan changes something the issue does not mention and the change is not needed to do what it asks: a refactor, a rename, a drive-by fix, a feature the issue leaves for later.',
          false: 'Every step serves a point of the issue, or is the small change needed to make one land.',
        },
        inverted: true,
        severity: 'warn',
      },
      decides_unasked: {
        type: 'noul',
        instructions: 'The plan rests on a decision the issue does not make.',
        criteria: {
          true: 'A step settles something the issue leaves open that others will depend on: a new or changed public interface, a stored format, behaviour a caller outside the change depends on, a choice between two architectures the issue leaves open.',
          false: 'The choices the plan makes are the ordinary ones of implementing what the issue states, whether or not the plan lists them: normalising an input, a collision or ordering rule inside one module, the wording of a message or note, a test\'s shape.',
        },
        inverted: true,
        severity: 'warn',
      },
    },
  },
  ci: {
    name: 'ci',
    subject: 'log',
    description: 'Why did this job fail, was it the change under test, the environment, and is the fix in this repository?',
    checks: ['log.trimmed'],
    // the lines that explain the failure are found first and fed to the questions as lines, beside the pull request's files
    rank: [
      {
        from: 'lines',
        label: '{n}: {text}',
        list: 'top',
        top: 40,
        order: 'input',
        feed: 'lines',
        questions: {
          explains: {
            type: 'noul',
            instructions: 'Line {n} helps explain why the job failed: {text}',
            criteria: {
              true: 'The line names an error, a failing test or assertion, a failing command, a missing file or dependency, a refused connection, or the exit status.',
              false: 'Setup, download, progress, or cleanup output that would read the same in a passing run.',
            },
            severity: 'info',
          },
        },
      },
    ],
    questions: {
      own_fault: {
        type: 'noul',
        instructions: 'The failure is caused by the change under test: judged from the kept lines beside the files the pull request touches.',
        criteria: {
          true: 'The failing test, file, module or command is one the pull request changes or directly depends on.',
          false: 'The failure sits in code, tooling or infrastructure the pull request does not touch.',
        },
        when: 'has_pull',
        severity: 'info',
      },
      environment: {
        type: 'noul',
        instructions: 'The failure is a flake, a network or runner problem, or an external service, not the code under test.',
        criteria: {
          true: 'A timeout, a reset or refused connection, a rate limit, a registry or download error, a runner out of disk or memory, or a test that fails by timing alone.',
          false: 'A compile error, a failing test or assertion, a lint or format finding, or a deterministic exit status from the project\'s own commands.',
        },
        severity: 'info',
      },
      fixable_here: {
        type: 'noul',
        instructions: 'The fix is inside this repository.',
        criteria: {
          true: 'A change to this repository\'s code, tests, configuration or workflow files would make the job pass.',
          false: 'The fix needs another repository, a hosted service, a release of an external dependency, or only a retry.',
        },
        severity: 'info',
      },
    },
  },
  triage: {
    name: 'triage',
    subject: 'event',
    description: 'Does this repository event need the session to act on it now?',
    checks: [],
    questions: {
      actionable: {
        type: 'noul',
        instructions: 'This event needs the repository maintainer to do something now: reply, triage, fix, review, or merge.',
        criteria: {
          true: 'A person or CI is waiting on the maintainer to reply, triage, fix, review, or merge.',
          false: 'Label churn, a bot status update, a thank-you comment, or a duplicate notification.',
        },
        severity: 'fail',
        lo: 0.3,
        hi: 0.6,
      },
      kind: {
        type: 'choice',
        instructions: 'What kind of event is this?',
        criteria: {
          question: 'a human asks the maintainer something and waits for an answer',
          bug_report: 'a defect is reported',
          feature_request: 'a new capability or change is requested',
          review_feedback: 'a review or comment asks for changes on a pull request',
          housekeeping: 'labels, milestones, titles or assignees changed with nothing to do',
          noise: 'automated or contentless activity',
          merge_or_close: 'something was merged or closed',
        },
        severity: 'info',
      },
      urgency: {
        type: 'score',
        instructions: 'How soon does this need attention?',
        criteria: ['later: can wait for the next scheduled look', 'soon: should be handled this session', 'now: blocks someone or something is broken'],
        severity: 'info',
      },
    },
  },
};
