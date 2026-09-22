import { describe, expect, it } from 'vitest';
import type { Job } from '../src/forge/forge.ts';
import { fillNeeds, workflowJobs } from '../src/forge/workflow.ts';

const job = (id: string, name: string): Job => ({ id, name, run: '1', sha: 'abc', url: `u${id}`, done: true, conclusion: 'success', ok: true });

describe('workflow needs', () => {
  it('reads each job key with its name and needs in every shape a workflow writes them', () => {
    const text = [
      'name: CI',
      'on: [push]',
      'jobs:  # the jobs',
      '  lint:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: not a job name',
      '        run: echo',
      '  "build":',
      "    name: 'build ${{ matrix.target }}'",
      '    needs: lint # waits',
      '  test:',
      '    needs: [lint, "build"]',
      '    env:',
      '      needs: nested, not read',
      '  wide:',
      '    needs: [lint,',
      '      build]',
      '',
      '  # a comment between jobs',
      '  gate:',
      '    name: gate',
      '    needs:',
      '      - test',
      '',
      '      - wide',
      '    if: always()',
      'env:',
      '  x: 1',
    ].join('\n');
    expect(workflowJobs(text)).toEqual([
      { key: 'lint', needs: [] },
      { key: 'build', name: 'build ${{ matrix.target }}', needs: ['lint'] },
      { key: 'test', needs: ['lint', 'build'] },
      { key: 'wide', needs: ['lint', 'build'] },
      { key: 'gate', name: 'gate', needs: ['test', 'wide'] },
    ]);
    expect(workflowJobs('name: x\non: push\n')).toBeUndefined();
  });

  it('maps jobs by exact name, by a matrix suffix on an unnamed key, and by a template\'s literal parts', () => {
    const workflow = [
      { key: 'lint', needs: [] },
      { key: 'build', name: 'build ${{ matrix.target }} (release)', needs: ['lint'] },
      { key: 'build-docs', name: 'build docs', needs: [] },
      { key: 'test', needs: ['build'] },
      { key: 'gate', name: 'gate', needs: ['build-docs', 'test'] },
    ];
    const jobs = [
      job('1', 'lint'),
      job('2', 'build x86 (release)'),
      job('3', 'build ${{ matrix.target }} (release)'),
      job('4', 'build docs'),
      job('5', 'test (x86, ubuntu)'),
      job('6', 'gate'),
    ];
    expect(Object.fromEntries(fillNeeds(jobs, workflow).map((j) => [j.name, j.needs]))).toEqual({
      lint: [],
      'build x86 (release)': ['1'],
      'build ${{ matrix.target }} (release)': ['1'],
      'build docs': [],
      'test (x86, ubuntu)': ['2', '3'],
      gate: ['4', '5'],
    });
  });

  it('leaves needs unset for a job it cannot map, or one that needs a key no job maps to', () => {
    const workflow = [
      { key: 'matrix', name: '${{ matrix.name }}', needs: [] },
      { key: 'docs', needs: ['matrix'] },
      { key: 'gate', needs: ['docs'] },
    ];
    const out = fillNeeds([job('1', 'anything'), job('2', 'docs'), job('3', 'gate'), job('4', 'caller / callee')], workflow);
    expect(out.map((j) => j.needs)).toEqual([undefined, undefined, ['2'], undefined]);
  });
});
