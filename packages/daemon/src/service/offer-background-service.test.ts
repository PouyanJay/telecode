import { describe, expect, it } from 'vitest';

import { offerBackgroundService } from './offer-background-service';

/**
 * The first-run offer to install the background login service, tested via injected effects (no real
 * stdin, install, or process exit). Covers the decision matrix — unsupported / already-installed /
 * flagged-off / non-interactive skips, and the interactive yes / no / install-failure paths. The harness
 * counts every effect through fixed wrappers and lets each test control only the outcomes.
 */
interface HarnessOptions {
  isInteractive?: boolean;
  noServiceFlag?: boolean;
  platformSupported?: boolean;
  installed?: boolean;
  answer?: boolean;
  installOk?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const calls = {
    isInstalledChecked: 0,
    confirmed: 0,
    installed: 0,
    handedOff: 0,
    notices: [] as string[],
  };
  const offer = {
    isInteractive: options.isInteractive ?? true,
    noServiceFlag: options.noServiceFlag ?? false,
    platformSupported: options.platformSupported ?? true,
    isInstalled: () => {
      calls.isInstalledChecked += 1;
      return Promise.resolve(options.installed ?? false);
    },
    confirm: () => {
      calls.confirmed += 1;
      return Promise.resolve(options.answer ?? true);
    },
    install: () => {
      calls.installed += 1;
      return Promise.resolve(options.installOk ?? true);
    },
    handOff: () => {
      calls.handedOff += 1;
    },
    notify: (message: string) => {
      calls.notices.push(message);
    },
  };
  return { offer, calls };
}

describe('offerBackgroundService', () => {
  it('does nothing (not even a status probe) on an unsupported platform', async () => {
    // Arrange
    const { offer, calls } = harness({ platformSupported: false });

    // Act
    await offerBackgroundService(offer);

    // Assert — short-circuits before probing installation
    expect(calls).toMatchObject({
      isInstalledChecked: 0,
      confirmed: 0,
      installed: 0,
      handedOff: 0,
      notices: [],
    });
  });

  it('does nothing (after checking) when the service is already installed', async () => {
    // Arrange
    const { offer, calls } = harness({ installed: true });

    // Act
    await offerBackgroundService(offer);

    // Assert — the already-installed guard is what short-circuits, so the probe ran once
    expect(calls.isInstalledChecked).toBe(1);
    expect(calls).toMatchObject({ confirmed: 0, installed: 0, handedOff: 0, notices: [] });
  });

  it('skips with a hint (no prompt) when --no-service is passed', async () => {
    // Arrange
    const { offer, calls } = harness({ noServiceFlag: true });

    // Act
    await offerBackgroundService(offer);

    // Assert
    expect(calls.confirmed).toBe(0);
    expect(calls.installed).toBe(0);
    expect(calls.notices.join('')).toMatch(/telecode service install/);
  });

  it('skips with a hint (no prompt) when stdin is not interactive', async () => {
    // Arrange
    const { offer, calls } = harness({ isInteractive: false });

    // Act
    await offerBackgroundService(offer);

    // Assert
    expect(calls.confirmed).toBe(0);
    expect(calls.installed).toBe(0);
    expect(calls.notices.join('')).toMatch(/telecode service install/);
  });

  it('installs, notifies, and hands off when the user confirms', async () => {
    // Arrange
    const { offer, calls } = harness({ answer: true });

    // Act
    await offerBackgroundService(offer);

    // Assert
    expect(calls.confirmed).toBe(1);
    expect(calls.installed).toBe(1);
    expect(calls.handedOff).toBe(1);
    expect(calls.notices.join('')).toMatch(/close this terminal/i);
  });

  it('does not hand off (but notifies) when the install fails', async () => {
    // Arrange
    const { offer, calls } = harness({ answer: true, installOk: false });

    // Act
    await offerBackgroundService(offer);

    // Assert
    expect(calls.installed).toBe(1);
    expect(calls.handedOff).toBe(0);
    expect(calls.notices.join('')).toMatch(/failed/i);
  });

  it('skips install + hand-off (with a hint) when the user declines', async () => {
    // Arrange
    const { offer, calls } = harness({ answer: false });

    // Act
    await offerBackgroundService(offer);

    // Assert
    expect(calls.confirmed).toBe(1);
    expect(calls.installed).toBe(0);
    expect(calls.handedOff).toBe(0);
    expect(calls.notices.join('')).toMatch(/telecode service install/);
  });
});
