import { describe, expect, it } from 'vitest';

import { parseGithubRemote } from './parse-github-remote';

describe('parseGithubRemote', () => {
  it('parses the three github.com remote forms, with or without .git', () => {
    expect(parseGithubRemote('git@github.com:acme/app.git')).toBe('acme/app');
    expect(parseGithubRemote('https://github.com/acme/app')).toBe('acme/app');
    expect(parseGithubRemote('https://github.com/acme/app.git')).toBe('acme/app');
    expect(parseGithubRemote('ssh://git@github.com/acme/app.git')).toBe('acme/app');
  });

  it('answers undefined for anything else — no PR link the browser cannot open', () => {
    expect(parseGithubRemote('/Users/dev/repos/app')).toBeUndefined();
    expect(parseGithubRemote('git@gitlab.example.com:acme/app.git')).toBeUndefined();
    expect(parseGithubRemote('https://github.com/acme')).toBeUndefined();
    expect(parseGithubRemote('https://github.com.evil.example/acme/app')).toBeUndefined();
  });
});
