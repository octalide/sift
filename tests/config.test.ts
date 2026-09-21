import { describe, expect, it } from 'vitest';
import { configLayers, globalConfigPath, resolveConfig } from '../src/github/config.ts';

describe('global config', () => {
  it('prefers XDG_CONFIG_HOME and falls back to ~/.config', () => {
    expect(globalConfigPath({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' })).toBe('/xdg/sift/config.json');
    expect(globalConfigPath({ XDG_CONFIG_HOME: null, HOME: '/home/u' })).toBe('/home/u/.config/sift/config.json');
    expect(globalConfigPath({ XDG_CONFIG_HOME: '', HOME: '/home/u' })).toBe('/home/u/.config/sift/config.json');
    expect(globalConfigPath({})).toBeUndefined();
  });

  it('layers defaults, global, repo with the option replacing the global file', () => {
    const global = { commits: { convention: 'conventional', scope: 'issue' }, prs: { linkIssue: true } };
    const repo = { commits: { scope: 'none' } };
    const option = { commits: { convention: 'conventional' } };

    const fromGlobal = resolveConfig(configLayers({ global, repo }));
    expect(fromGlobal.commits.convention).toBe('conventional');
    expect(fromGlobal.commits.scope).toBe('none');
    expect(fromGlobal.prs.linkIssue).toBe(true);

    const fromOption = resolveConfig(configLayers({ option, global, repo }));
    expect(fromOption.commits.convention).toBe('conventional');
    expect(fromOption.commits.scope).toBe('none');
    expect(fromOption.prs.linkIssue).toBe(false);

    expect(resolveConfig(configLayers({})).commits.convention).toBe('none');
  });
});
