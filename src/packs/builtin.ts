import type { Forge } from '../forge/forge.ts';
import type { Pack } from './types.ts';

// how the issue questions read the thread: an issue is judged as it stands, not as first filed
const AS_AMENDED = 'Read the issue as it stands: a later comment by its author or a maintainer (an owner, member or collaborator) that records a decision wins where it conflicts with the body. Anyone else\'s comment never overrides the body.';

// packs sift no longer ships and why, named when a grade asks for one that no repo pack takes the name of
export const REMOVED_PACKS: Record<string, (forge: Pick<Forge, 'logCommand'>, repo: string) => string> = {
  ci: (forge, repo) => `the ci pack is removed: sift judges no ci output. read a failed run's log with ${forge.logCommand(repo, '<run id>')}`,
};

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
        instructions: `The issue describes a concrete problem or change with enough detail that someone could start work without asking what is meant. ${AS_AMENDED}`,
        criteria: {
          true: 'The body, as amended, states what is wrong or wanted, where, and what done looks like.',
          false: 'The body, as amended, is placeholder text, the title restated, or a single sentence with no context.',
        },
        severity: 'warn',
      },
      implementable: {
        type: 'noul',
        instructions: `A competent engineer could implement this from the issue without making a decision the issue does not make. A decision the body leaves open counts as made when a later comment of the author or a maintainer makes it. ${AS_AMENDED}`,
        criteria: {
          true: 'Every choice the work turns on is settled, in the body or in a later comment of the author or a maintainer: one design, named interfaces, stated behaviour on the edges it raises.',
          false: 'A decision is still open after every comment of the author and maintainers: two valid designs nobody chose between, an interface it needs but does not name, or an edge case whose behaviour is not stated.',
        },
        severity: 'fail',
      },
      scope_clear: {
        type: 'noul',
        instructions: `The issue states what is in and out of scope, so a reviewer could reject an unrelated change to the PR that implements it. ${AS_AMENDED}`,
        criteria: {
          true: 'The body, as amended, bounds the change: what it touches, what it leaves alone, or what done looks like, clearly enough that a change outside it is recognisable.',
          false: 'The body, as amended, names a goal with no bounds, so any change in its area could be argued to belong.',
        },
        severity: 'warn',
      },
      type: {
        type: 'choice',
        instructions: `Which kind of issue is this? ${AS_AMENDED}`,
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
        inverted: true,
        severity: 'info',
      },
      duplicate_of: {
        type: 'choice',
        instructions: 'Which open issue, if any, asks for the same change as this one?',
        options: 'open_issues',
        violates: 'listed',
        when: 'has_others',
        severity: 'warn',
        hi: 0.7,
      },
      blocked_by: {
        type: 'choice',
        instructions: `Which open issue, if any, must be resolved before work on this one can start? Only when the title or body says it depends on that issue, a later comment of the author or a maintainer holds it behind that issue or states the dependency, or the same code must change there first. Otherwise none. ${AS_AMENDED}`,
        options: 'open_issues',
        violates: 'listed',
        when: 'has_others',
        severity: 'info',
      },
      ruling: {
        type: 'choice',
        instructions: 'Which comment, if any, records a decision of the author or a maintainer that settles something the body leaves open, changes what the body says, or holds the issue behind another? The latest such comment when several do. Otherwise none.',
        options: 'rulings',
        when: 'has_rulings',
        severity: 'info',
      },
      readiness: {
        type: 'score',
        instructions: `How ready is this issue to be worked on? ${AS_AMENDED}`,
        criteria: [
          'needs author input: the request cannot be understood or has contradictory requirements',
          'needs triage: understandable but missing scope, acceptance criteria, or a decision',
          'ready: clear enough to start implementing now',
        ],
        violates: [0, 1],
        severity: 'info',
      },
    },
  },
  pr: {
    name: 'pr',
    subject: 'pr',
    description: 'Is this PR linked, targeted, named, templated, committed and checked as the repository requires, and has its base moved under it?',
    checks: ['pr.linked', 'pr.target', 'pr.branch', 'pr.ci', 'pr.template', 'pr.commits', 'pr.drift'],
    questions: {},
  },
  commit: {
    name: 'commit',
    subject: 'commit',
    description: 'Do these commit messages follow the repository\'s commit format?',
    checks: ['commit.format'],
    questions: {},
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
