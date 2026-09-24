import { describe, expect, it } from 'vitest';
import { configLayers, globalConfigPath, readConfig, resolveConfig } from '../src/repo/config.ts';

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

describe('outbound channels in config', () => {
  it('reads the channel list and rejects a bad regex by name', () => {
    const slack = { name: 'slack', tool: '^mcp__slack__post_message$', text: { fields: ['text'] }, limit: 40000, kind: 'a Slack message' };
    expect(resolveConfig({ outbound: { channels: [slack] } }).outbound.channels).toEqual([slack]);
    expect(resolveConfig({}).outbound.channels).toEqual([]);
    const read = (layer: unknown) => () => readConfig(JSON.stringify(layer), 'c.json');
    expect(read({ outbound: { channels: [{ ...slack, tool: '(' }] } })).toThrow(/^sift config c\.json: outbound\.channels\[slack\]\.tool is not a valid regex/);
    expect(read({ outbound: { channels: [{ name: 'glab', tool: '^Bash$', text: { command: '[', body: ['-m'] } }] } })).toThrow(/^sift config c\.json: outbound\.channels\[glab\]\.text\.command is not a valid regex/);
    // the kind of text a channel carries decides the rules that govern it, so an unknown one is refused at load
    expect(read({ outbound: { channels: [{ ...slack, textKind: 'message' }] } })()).toMatchObject({ outbound: { channels: [{ textKind: 'message' }] } });
    expect(read({ outbound: { channels: [{ ...slack, textKind: 'chat' }] } })).toThrow('sift config c.json: outbound.channels[slack].textKind is "chat", not one of issue, pr, comment, commit, release, message');
  });
});

describe('reading a config file', () => {
  it('compiles every regex field, naming the file, the field and the engine\'s error', () => {
    const read = (layer: unknown) => () => readConfig(JSON.stringify(layer), '/r/.sift/config.json');
    expect(read({ branches: { pattern: '^(feat|fix)/(\\d+$' } })).toThrow('sift config /r/.sift/config.json: branches.pattern is not a valid regex: Invalid regular expression: /^(feat|fix)/(\\d+$/: Unterminated group');
    expect(read({ commits: { format: '[' } })).toThrow('sift config /r/.sift/config.json: commits.format is not a valid regex');
    expect(read({ commits: { scopePattern: '(' } })).toThrow('commits.scopePattern is not a valid regex');
    expect(read({ prs: { targets: '(' } })).toThrow('prs.targets is not a valid regex');
    expect(read({ release: { versionPattern: '(' } })).toThrow('release.versionPattern is not a valid regex');
    expect(read({ release: { tagPattern: '(' } })).toThrow('release.tagPattern is not a valid regex');
    expect(read({ release: { manifests: [{ path: 'mach.toml', keys: ['^version$', '^deps\\.('], bump: 'minor' }] } })).toThrow('release.manifests[mach.toml].keys[1] is not a valid regex');
    expect(read({ release: { manifests: [{ path: 'Cargo.toml', pattern: 'x)', bump: 'patch' }] } })).toThrow('release.manifests[Cargo.toml].pattern is not a valid regex');
    expect(() => readConfig('{', 'g.json')).toThrow(/^sift config g\.json: /);
  });

  it('loads a valid config unchanged', () => {
    const own = { commits: { convention: 'conventional', scope: 'issue', forbidTrailers: ['Co-Authored-By'] }, branches: { protected: ['main', 'dev'], pattern: '^(feat|fix|chore|hotfix)/\\d+$' }, prs: { targets: '^(dev|main)$' }, release: { manifests: [{ path: 'mach.toml', keys: ['^version$', '^deps\\.'], pattern: 'abi = \\d+', bump: 'minor' }] } };
    const text = JSON.stringify(own);
    expect(readConfig(text, 'c.json')).toEqual(own);
    expect(resolveConfig(readConfig(text, 'c.json'))).toEqual(resolveConfig(JSON.parse(text)));
  });
});
