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
    checks: ['pr.linked', 'pr.target', 'pr.branch', 'pr.ci', 'pr.template', 'pr.commits'],
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
  },
  commit: {
    name: 'commit',
    subject: 'commit',
    description: 'Do these commit messages follow the convention and describe their diffs honestly?',
    checks: ['commit.format'],
    questions: {
      type_matches: {
        type: 'choice',
        instructions: 'Which conventional commit type does the diff actually warrant?',
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
    rank: [
      {
        from: 'rules',
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
          true: 'A step picks between options the issue leaves open and the outcome differs by the pick: a public interface, a name or format others depend on, which of several approaches, what to do with a case the issue does not cover, whether something the issue leaves out is in scope.',
          false: 'Every choice the plan makes is one the issue states, or a routine one any implementer would make the same way.',
        },
        inverted: true,
        severity: 'fail',
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
