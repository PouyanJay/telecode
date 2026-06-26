/**
 * The landing page's content, as data (the house pattern: structured content in a `$lib` module, a thin
 * Svelte component renders it; this is what the unit tests assert against). Positioning is **capability-
 * based** — telecode is described by what it *is and does* (open · self-hostable · end-to-end encrypted ·
 * Agent-SDK-native), never by comparison to a named competitor (a BLOCKING project rule).
 */

/** Canonical off-site destinations. The product PWA lives on a subdomain; the source on GitHub. */
export const links = {
  /** The product web app (the dashboard) — a subdomain of the marketing apex. */
  app: 'https://app.telecode.io',
  /** Source + issues. */
  repo: 'https://github.com/PouyanJay/telecode',
  /** Getting-started guide (install → pair → launch). */
  docs: 'https://github.com/PouyanJay/telecode/blob/main/docs/getting-started.md',
  /** Self-hosting guide. */
  selfHost: 'https://github.com/PouyanJay/telecode/blob/main/docs/self-hosting.md',
} as const;

/** The four pillars that define telecode. Stable ids let tests assert coverage without matching prose. */
export type CapabilityId =
  | 'open-source'
  | 'self-hostable'
  | 'end-to-end-encrypted'
  | 'agent-sdk-native';

export interface Capability {
  readonly id: CapabilityId;
  readonly title: string;
  readonly body: string;
}

export interface CallToAction {
  readonly label: string;
  readonly href: string;
}

export interface HowItWorksStep {
  readonly n: number;
  readonly title: string;
  readonly body: string;
  /** An optional terminal command shown in a mono chip (the data-as-signature house style). */
  readonly command?: string;
}

export interface FooterLink {
  readonly label: string;
  readonly href: string;
}

export interface SiteContent {
  readonly productName: string;
  /** The hero headline — what telecode lets you do, in one line. */
  readonly tagline: string;
  readonly subhead: string;
  /** The command shown in the hero terminal chip. */
  readonly installCommand: string;
  readonly capabilities: readonly Capability[];
  readonly howItWorks: readonly HowItWorksStep[];
  readonly primaryCta: CallToAction;
  readonly secondaryCta: CallToAction;
  readonly footerLinks: readonly FooterLink[];
  /** SPDX license id, shown in the footer. */
  readonly license: string;
}

export const siteContent: SiteContent = {
  productName: 'telecode',
  tagline: 'Run Claude Code agents on your own machine — drive them from any browser.',
  subhead:
    'telecode is an open-source, self-hostable command center for Claude Code agents. Launch, watch, and steer agents that run on your hardware, from your phone or laptop — your code never leaves your machine.',
  installCommand: 'npx telecode',
  capabilities: [
    {
      id: 'open-source',
      title: 'Open source',
      body: 'AGPL-3.0 and built in the open. Read every line, fork it, and own your workflow — no black boxes between you and your agents.',
    },
    {
      id: 'self-hostable',
      title: 'Self-hostable',
      body: 'Run the whole stack yourself with one command. The relay is a thin multiplexer; your laptop does the work and nothing ever reaches into it.',
    },
    {
      id: 'end-to-end-encrypted',
      title: 'End-to-end encrypted',
      body: 'Prompts, output, and diffs are encrypted in your browser. The relay only ever forwards ciphertext plus routing metadata — it cannot read your work.',
    },
    {
      id: 'agent-sdk-native',
      title: 'Agent-SDK-native',
      body: 'Built directly on the Claude Agent SDK — real sessions, real tool approvals — not screen-scraping a terminal. Every consequential action waits for your decision.',
    },
  ],
  howItWorks: [
    {
      n: 1,
      title: 'Install on your machine',
      body: 'Run one command where your agents should work. The daemon dials out to the relay — nothing ever reaches into your laptop.',
      command: 'npx telecode',
    },
    {
      n: 2,
      title: 'Pair from the browser',
      body: 'The daemon prints a short code. Sign in to the dashboard, enter the code, and this machine is bound to your account.',
    },
    {
      n: 3,
      title: 'Launch & steer',
      body: 'Pick a device, point at a repo, and send a prompt. Watch output stream and approve each consequential tool call — from your phone or laptop.',
    },
  ],
  primaryCta: { label: 'Get started', href: links.docs },
  secondaryCta: { label: 'View on GitHub', href: links.repo },
  footerLinks: [
    { label: 'GitHub', href: links.repo },
    { label: 'Documentation', href: links.docs },
    { label: 'Self-hosting', href: links.selfHost },
    { label: 'Privacy', href: 'https://github.com/PouyanJay/telecode/blob/main/docs/telemetry.md' },
  ],
  license: 'AGPL-3.0',
};
