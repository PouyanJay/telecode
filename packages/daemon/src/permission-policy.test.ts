import type { PermissionModeName } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { classifyTool } from './permission-policy';

const ALL_MODES: readonly PermissionModeName[] = [
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
];
// The modes that keep the human gate for consequential tools (bypassPermissions surrenders it).
const GATED_MODES: readonly PermissionModeName[] = ['default', 'plan', 'acceptEdits'];

describe('classifyTool', () => {
  it.each(['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite'])(
    'auto-allows the read-only tool %s in every mode',
    (tool) => {
      for (const mode of ALL_MODES) expect(classifyTool(tool, mode)).toBe('allow');
    },
  );

  it.each(GATED_MODES)('always asks for Bash in %s mode (the unapproved-command bug)', (mode) => {
    expect(classifyTool('Bash', mode)).toBe('ask');
  });

  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])(
    'asks for the edit tool %s under default/plan but auto-allows it under acceptEdits',
    (tool) => {
      expect(classifyTool(tool, 'default')).toBe('ask');
      expect(classifyTool(tool, 'plan')).toBe('ask');
      expect(classifyTool(tool, 'acceptEdits')).toBe('allow');
    },
  );

  it.each(['WebFetch', 'WebSearch', 'Task'])(
    'asks for the network/subagent tool %s even under acceptEdits',
    (tool) => {
      expect(classifyTool(tool, 'acceptEdits')).toBe('ask');
    },
  );

  it('fails safe: an unknown/new tool asks rather than silently running', () => {
    expect(classifyTool('Frobnicate', 'default')).toBe('ask');
    expect(classifyTool('Frobnicate', 'acceptEdits')).toBe('ask');
  });

  it('read-only stays auto-allowed under bypassPermissions too (safe regardless of mode)', () => {
    expect(classifyTool('Read', 'bypassPermissions')).toBe('allow');
  });
});

describe('bypassPermissions (launch-selectable, bypass-launch-mode)', () => {
  it.each(['Bash', 'Write', 'Edit', 'WebFetch', 'KillShell', 'SomeFutureTool'])(
    'auto-allows %s — the operator explicitly surrendered the gate at launch',
    (tool) => {
      expect(classifyTool(tool, 'bypassPermissions')).toBe('allow');
    },
  );

  it('still asks for AskUserQuestion — a question is a request FOR the human, never bypassable', () => {
    expect(classifyTool('AskUserQuestion', 'bypassPermissions')).toBe('ask');
  });

  it('leaves every other mode exactly as conservative as before', () => {
    expect(classifyTool('Bash', 'default')).toBe('ask');
    expect(classifyTool('Bash', 'acceptEdits')).toBe('ask');
    expect(classifyTool('Bash', 'plan')).toBe('ask');
    expect(classifyTool('Write', 'acceptEdits')).toBe('allow');
    expect(classifyTool('AskUserQuestion', 'default')).toBe('ask');
  });
});
