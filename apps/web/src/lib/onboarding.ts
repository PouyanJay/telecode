/**
 * The first-run onboarding model (Phase 4 T14): the ordered path a signed-in user walks to their first
 * remote launch — pair a machine, then launch a session. Pure over observable state so the `Onboarding`
 * stepper stays a thin renderer; exactly one step is `current` at a time, and the pair step carries the
 * environment-aware command (dev `make run` vs prod `npx @telecode/cli`) so the screen never lies about how to
 * start the daemon.
 */

/** How a user starts their daemon and where its pairing code appears (from `$lib/pairing-instructions`). */
export interface PairingInstructionsInput {
  readonly command: string;
  readonly codeLocation: string | null;
}

/** A step is finished, the one to act on now, or not yet reachable. */
export type OnboardingStepStatus = 'done' | 'current' | 'upcoming';

/** One step of the onboarding path. `command`/`codeLocation` are present only on the pair step. */
export interface OnboardingStep {
  readonly key: 'pair' | 'launch';
  readonly title: string;
  readonly body: string;
  readonly status: OnboardingStepStatus;
  readonly command?: string;
  readonly codeLocation?: string | null;
}

/** Observable state the onboarding path is derived from. */
export interface OnboardingContext {
  readonly paired: boolean;
  readonly hasSessions: boolean;
  readonly instructions: PairingInstructionsInput;
}

/** Build the ordered onboarding steps with their statuses for the current state. */
export function buildOnboardingSteps(context: OnboardingContext): OnboardingStep[] {
  const { paired, hasSessions, instructions } = context;
  return [
    {
      key: 'pair',
      title: 'Pair your machine',
      body: 'Run the command on the machine you want to control, then enter the code it gives you.',
      status: paired ? 'done' : 'current',
      command: instructions.command,
      codeLocation: instructions.codeLocation,
    },
    {
      key: 'launch',
      title: 'Launch your first session',
      body: "Describe a task for the agent. You'll approve each consequential action before it runs.",
      status: hasSessions ? 'done' : paired ? 'current' : 'upcoming',
    },
  ];
}
