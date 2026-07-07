import { describe, expect, it } from 'vitest';

import { buildBranchPickerModel } from './launch-branches';
import type { RelayRepo } from './server/relay-api';

const REPO: RelayRepo = {
  id: 1,
  fullName: 'me/telecode',
  name: 'telecode',
  owner: 'me',
  private: false,
  defaultBranch: 'main',
  cloneUrl: 'https://example.com/me/telecode.git',
};

const IDLE = { state: 'idle', branches: [] } as const;

describe('buildBranchPickerModel', () => {
  it('a selected GitHub repo: loading while the fetch runs, ready with ITS default once loaded', () => {
    expect(buildBranchPickerModel({ repo: REPO, github: IDLE, local: undefined })).toEqual({
      status: 'loading',
    });
    expect(
      buildBranchPickerModel({
        repo: REPO,
        github: { state: 'loaded', branches: ['main', 'develop'] },
        local: undefined,
      }),
    ).toEqual({ status: 'ready', branches: ['main', 'develop'], defaultBranch: 'main' });
  });

  it('a failed GitHub fetch shows the error state (recoverable, never a silent empty)', () => {
    expect(
      buildBranchPickerModel({
        repo: REPO,
        github: { state: 'error', branches: [] },
        local: undefined,
      }),
    ).toEqual({ status: 'error' });
  });

  it('no repo: ready from the sealed local reply with the checked-out default', () => {
    expect(
      buildBranchPickerModel({
        repo: null,
        github: IDLE,
        local: { available: true, branches: ['main', 'fix/x'], defaultBranch: 'main' },
      }),
    ).toEqual({ status: 'ready', branches: ['main', 'fix/x'], defaultBranch: 'main' });
  });

  it('no repo: hidden while no reply, when unavailable, or when the repo has no branches', () => {
    expect(buildBranchPickerModel({ repo: null, github: IDLE, local: undefined })).toEqual({
      status: 'hidden',
    });
    expect(
      buildBranchPickerModel({
        repo: null,
        github: IDLE,
        local: { available: false, branches: [] },
      }),
    ).toEqual({ status: 'hidden' });
    expect(
      buildBranchPickerModel({
        repo: null,
        github: IDLE,
        local: { available: true, branches: [] },
      }),
    ).toEqual({ status: 'hidden' });
  });

  it('a default beyond the listed page yields null — never a pre-selection with no option', () => {
    expect(
      buildBranchPickerModel({
        repo: { ...REPO, defaultBranch: 'trunk-not-on-page-1' },
        github: { state: 'loaded', branches: ['main', 'develop'] },
        local: undefined,
      }),
    ).toEqual({ status: 'ready', branches: ['main', 'develop'], defaultBranch: null });
  });

  it('a detached local default yields null (the picker just pre-selects nothing)', () => {
    expect(
      buildBranchPickerModel({
        repo: null,
        github: IDLE,
        local: { available: true, branches: ['main'] },
      }),
    ).toEqual({ status: 'ready', branches: ['main'], defaultBranch: null });
  });
});
