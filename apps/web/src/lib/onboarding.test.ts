import { describe, expect, it } from 'vitest';

import { buildOnboardingSteps } from './onboarding';

/**
 * The first-run onboarding model (Phase 4 T14): the ordered path a new user walks — pair a machine, then
 * launch a first session — with exactly one `current` step at a time. Pure over observable state
 * (paired? has sessions?) so the stepper component stays a thin renderer and the status logic is tested
 * directly.
 */
const instructions = { command: 'make run', codeLocation: '.run-state/daemon.log' } as const;
const prodInstructions = { command: 'npx @telecode/cli', codeLocation: null } as const;

describe('buildOnboardingSteps', () => {
  it('starts on the pair step before a device is paired', () => {
    const steps = buildOnboardingSteps({ paired: false, hasSessions: false, instructions });
    expect(steps.map((s) => [s.key, s.status])).toEqual([
      ['pair', 'current'],
      ['launch', 'upcoming'],
    ]);
  });

  it('advances to the launch step once paired with no sessions yet', () => {
    const steps = buildOnboardingSteps({ paired: true, hasSessions: false, instructions });
    expect(steps.map((s) => [s.key, s.status])).toEqual([
      ['pair', 'done'],
      ['launch', 'current'],
    ]);
  });

  it('marks every step done once the first session exists', () => {
    const steps = buildOnboardingSteps({ paired: true, hasSessions: true, instructions });
    expect(steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('surfaces the environment-aware command and code location on the pair step', () => {
    const dev = buildOnboardingSteps({ paired: false, hasSessions: false, instructions })[0];
    expect(dev?.command).toBe('make run');
    expect(dev?.codeLocation).toBe('.run-state/daemon.log');

    const prod = buildOnboardingSteps({
      paired: false,
      hasSessions: false,
      instructions: prodInstructions,
    })[0];
    expect(prod?.command).toBe('npx @telecode/cli');
    expect(prod?.codeLocation).toBeNull();
  });

  it('gives every step a human title and body', () => {
    for (const step of buildOnboardingSteps({ paired: false, hasSessions: false, instructions })) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
    }
  });
});
