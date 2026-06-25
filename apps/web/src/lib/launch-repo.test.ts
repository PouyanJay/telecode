import { describe, expect, it } from 'vitest';

import { launchRepo, type RepoOption } from './launch-repo';

const REPOS: RepoOption[] = [
  {
    id: 1,
    fullName: 'octocat/hello',
    owner: 'octocat',
    name: 'hello',
    cloneUrl: 'https://github.com/octocat/hello.git',
  },
  {
    id: 2,
    fullName: 'octocat/world',
    owner: 'octocat',
    name: 'world',
    cloneUrl: 'https://github.com/octocat/world.git',
  },
];

describe('launchRepo: map the picker selection to the launch payload repo', () => {
  it('returns the selected repo as { owner, name, cloneUrl }', () => {
    expect(launchRepo(REPOS, '2')).toEqual({
      owner: 'octocat',
      name: 'world',
      cloneUrl: 'https://github.com/octocat/world.git',
    });
  });

  it('returns undefined when no repo is selected (run in the daemon default cwd)', () => {
    expect(launchRepo(REPOS, '')).toBeUndefined();
  });

  it('returns undefined when the selected id is not in the list', () => {
    expect(launchRepo(REPOS, '999')).toBeUndefined();
  });
});
