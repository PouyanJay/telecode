import type { PermissionModeName } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { classifyTool } from './permission-policy';

const ALL_MODES: readonly PermissionModeName[] = [
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
];

describe('classifyTool', () => {
  it.each(['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite'])(
    'auto-allows the read-only tool %s in every mode',
    (tool) => {
      for (const mode of ALL_MODES) expect(classifyTool(tool, mode)).toBe('allow');
    },
  );

  it.each(ALL_MODES)('always asks for Bash in %s mode (the unapproved-command bug)', (mode) => {
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

  it('never surrenders the gate under bypassPermissions — consequential tools still ask', () => {
    expect(classifyTool('Bash', 'bypassPermissions')).toBe('ask');
    expect(classifyTool('Write', 'bypassPermissions')).toBe('ask');
    // read-only stays auto-allowed (it is safe regardless of mode)
    expect(classifyTool('Read', 'bypassPermissions')).toBe('allow');
  });
});
