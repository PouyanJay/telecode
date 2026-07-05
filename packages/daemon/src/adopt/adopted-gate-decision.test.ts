import { describe, expect, it } from 'vitest';

import { adoptedGateDecision } from './adopted-gate-decision';

/**
 * An ADOPTED session runs in the mode the user chose in their own Claude Code, so telecode must MIRROR it,
 * never be stricter. These cases pin the three-way decision — including the failure-safe coercion of an
 * unknown/absent mode toward gating (never an optimistic defer that would surrender the local session's
 * own checks).
 */
describe('adoptedGateDecision', () => {
  it.each(['bypassPermissions', 'auto', 'dontAsk'])(
    'defers wholesale in %s mode (Claude Code never prompts, so telecode must not either)',
    (mode) => {
      expect(adoptedGateDecision('Bash', mode)).toBe('defer');
      expect(adoptedGateDecision('Edit', mode)).toBe('defer');
      expect(adoptedGateDecision('Read', mode)).toBe('defer');
      expect(adoptedGateDecision('AskUserQuestion', mode)).toBe('defer');
    },
  );

  it('gates consequential tools under default mode, allows read-only ones', () => {
    expect(adoptedGateDecision('Bash', 'default')).toBe('gate');
    expect(adoptedGateDecision('Edit', 'default')).toBe('gate');
    expect(adoptedGateDecision('Read', 'default')).toBe('allow');
    expect(adoptedGateDecision('Grep', 'default')).toBe('allow');
  });

  it('allows edits under acceptEdits but still gates bash', () => {
    expect(adoptedGateDecision('Edit', 'acceptEdits')).toBe('allow');
    expect(adoptedGateDecision('Write', 'acceptEdits')).toBe('allow');
    expect(adoptedGateDecision('Bash', 'acceptEdits')).toBe('gate');
  });

  it('gates consequential tools under plan mode', () => {
    expect(adoptedGateDecision('Bash', 'plan')).toBe('gate');
    expect(adoptedGateDecision('Read', 'plan')).toBe('allow');
  });

  it('fails safe to gating for an absent or unrecognized mode (never an optimistic defer)', () => {
    expect(adoptedGateDecision('Bash', undefined)).toBe('gate');
    expect(adoptedGateDecision('Bash', 'nonsense-mode')).toBe('gate');
    // Only the exact mode strings defer — a near-miss like 'bypass' must not open the gate.
    expect(adoptedGateDecision('Edit', 'bypass')).toBe('gate');
  });
});
