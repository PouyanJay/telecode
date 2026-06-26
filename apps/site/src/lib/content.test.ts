import { describe, expect, it } from 'vitest';

import { links, siteContent, type CapabilityId } from './content';

/**
 * The landing content is the product's public positioning, so it is asserted as data (walking skeleton for
 * Phase 5 Task 5). These are *positive* checks — that the four defining capabilities are present and the
 * CTAs point at real destinations. (The "no competitor names" rule is enforced by review + a repo-wide
 * grep, never by hardcoding rival names here — that would itself ship a competitor name.)
 */
describe('landing content', () => {
  it('leads with a non-empty capability headline and subhead', () => {
    expect(siteContent.productName).toBe('telecode');
    expect(siteContent.tagline.trim().length).toBeGreaterThan(0);
    expect(siteContent.subhead.trim().length).toBeGreaterThan(0);
  });

  it('covers the four defining capabilities, each with body copy', () => {
    const expected: CapabilityId[] = [
      'open-source',
      'self-hostable',
      'end-to-end-encrypted',
      'agent-sdk-native',
    ];
    const ids = siteContent.capabilities.map((c) => c.id);
    expect(ids).toEqual(expected);
    for (const capability of siteContent.capabilities) {
      expect(capability.title.trim().length).toBeGreaterThan(0);
      expect(capability.body.trim().length).toBeGreaterThan(0);
    }
  });

  it('points both CTAs at real, absolute destinations', () => {
    for (const cta of [siteContent.primaryCta, siteContent.secondaryCta]) {
      expect(cta.label.trim().length).toBeGreaterThan(0);
      expect(cta.href).toMatch(/^https:\/\//);
    }
    expect(siteContent.secondaryCta.href).toBe(links.repo);
  });

  it('lays out the three-step how-it-works flow with sequential numbering', () => {
    expect(siteContent.howItWorks.map((s) => s.n)).toEqual([1, 2, 3]);
    for (const step of siteContent.howItWorks) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.body.trim().length).toBeGreaterThan(0);
    }
  });

  it('exposes a footer of absolute links and the AGPL license', () => {
    expect(siteContent.footerLinks.length).toBeGreaterThan(0);
    for (const link of siteContent.footerLinks) {
      expect(link.label.trim().length).toBeGreaterThan(0);
      expect(link.href).toMatch(/^https:\/\//);
    }
    expect(siteContent.license).toBe('AGPL-3.0');
  });

  it('shows an install command in the hero', () => {
    expect(siteContent.installCommand.trim().length).toBeGreaterThan(0);
  });

  it('uses only telecode.io domains for first-party destinations', () => {
    const firstParty = Object.values(links).filter((href) => href.includes('telecode'));
    for (const href of firstParty) {
      // The product app is on app.telecode.io; the legacy pouyan.ai domain must not reappear.
      expect(href).not.toContain('telecode.pouyan.ai');
    }
    expect(links.app).toBe('https://app.telecode.io');
  });
});
