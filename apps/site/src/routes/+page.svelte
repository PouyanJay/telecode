<script lang="ts">
  import { siteContent } from '$lib/content';

  const {
    productName,
    tagline,
    subhead,
    installCommand,
    capabilities,
    howItWorks,
    primaryCta,
    secondaryCta,
    footerLinks,
    license,
  } = siteContent;

  const repoHref = secondaryCta.href;
</script>

<svelte:head>
  <title>{productName} — run Claude Code agents on your machine, from any browser</title>
  <meta name="description" content={subhead} />
</svelte:head>

<header class="site-header hairline-b">
  <div class="bar">
    <span class="brand"><span class="brand-mark" aria-hidden="true"></span>{productName}</span>
    <nav aria-label="Primary">
      <a class="nav-link" href={repoHref} rel="noreferrer">GitHub</a>
    </nav>
  </div>
</header>

<main id="main">
  <section class="hero" aria-labelledby="hero-title">
    <p class="eyebrow">Open · self-hostable · end-to-end encrypted</p>
    <h1 id="hero-title">{tagline}</h1>
    <p class="subhead">{subhead}</p>
    <div class="cta-row">
      <a class="cta cta-primary" href={primaryCta.href}>{primaryCta.label}</a>
      <a class="cta cta-secondary" href={secondaryCta.href} rel="noreferrer">{secondaryCta.label}</a>
    </div>
    <div class="terminal" role="img" aria-label="Install command: {installCommand}">
      <span class="prompt" aria-hidden="true">$</span><code>{installCommand}</code>
    </div>
  </section>

  <section class="capabilities" aria-labelledby="capabilities-title">
    <h2 id="capabilities-title" class="section-title">Why telecode</h2>
    <ul class="capability-grid">
      {#each capabilities as capability (capability.id)}
        <li class="capability">
          <h3>{capability.title}</h3>
          <p>{capability.body}</p>
        </li>
      {/each}
    </ul>
  </section>

  <section class="how" aria-labelledby="how-title">
    <h2 id="how-title" class="section-title">How it works</h2>
    <ol class="steps">
      {#each howItWorks as step (step.n)}
        <li class="step">
          <span class="step-n" aria-hidden="true">{step.n}</span>
          <div class="step-body">
            <h3>{step.title}</h3>
            <p>{step.body}</p>
            {#if step.command}
              <div class="terminal terminal-sm">
                <span class="prompt" aria-hidden="true">$</span><code>{step.command}</code>
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ol>
  </section>

  <section class="closing" aria-labelledby="closing-title">
    <h2 id="closing-title">Your machine. Your keys. Your agents.</h2>
    <div class="cta-row">
      <a class="cta cta-primary" href={primaryCta.href}>{primaryCta.label}</a>
      <a class="cta cta-secondary" href={secondaryCta.href} rel="noreferrer">{secondaryCta.label}</a>
    </div>
  </section>
</main>

<footer class="site-footer hairline-t">
  <div class="footer-inner">
    <span class="brand"><span class="brand-mark" aria-hidden="true"></span>{productName}</span>
    <nav class="footer-nav" aria-label="Footer">
      {#each footerLinks as link (link.href)}
        <a class="nav-link" href={link.href} rel="noreferrer">{link.label}</a>
      {/each}
    </nav>
    <span class="license">{license}</span>
  </div>
</footer>

<style>
  /* ── Frame ─────────────────────────────────────────────────────────────── */
  .site-header {
    position: sticky;
    top: 0;
    z-index: var(--z-sticky);
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(8px);
    /* Lighter top edge — light-from-above app frame. */
    border-top: 2px solid var(--frame-top);
  }
  .bar,
  .footer-inner {
    max-width: var(--width-content);
    margin: 0 auto;
    padding: var(--space-3) var(--space-5);
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
  .bar {
    justify-content: space-between;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .brand-mark {
    width: 9px;
    height: 9px;
    border-radius: var(--radius-sm);
    background: var(--accent);
  }

  .nav-link {
    color: var(--text-secondary);
    text-decoration: none;
    font-size: var(--text-sm);
    border-radius: var(--radius-sm);
    transition: color var(--dur-fast) var(--ease);
  }
  .nav-link:hover {
    color: var(--text);
  }
  .nav-link:focus-visible {
    outline: none;
    color: var(--text);
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }

  main {
    max-width: var(--width-content);
    margin: 0 auto;
    padding: 0 var(--space-5);
  }

  /* ── Hero ──────────────────────────────────────────────────────────────── */
  .hero {
    text-align: center;
    padding-block: var(--space-16) var(--space-12);
  }
  .eyebrow {
    margin: 0 0 var(--space-4);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--accent);
  }
  h1 {
    margin: 0 auto;
    max-width: 20ch;
    font-size: var(--text-2xl);
    line-height: var(--lh-2xl);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .subhead {
    margin: var(--space-5) auto 0;
    max-width: 58ch;
    color: var(--text-secondary);
    font-size: var(--text-lg);
    line-height: var(--lh-lg);
  }

  .cta-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    justify-content: center;
    margin-top: var(--space-8);
  }
  /* CTAs are real links styled to match the Button primitive's language (amber fill = the one accent). */
  .cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 40px;
    padding: 0 var(--space-5);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    text-decoration: none;
    transition:
      background-color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease);
  }
  .cta:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }
  .cta-primary {
    background: var(--primary);
    color: var(--primary-text);
  }
  .cta-primary:hover {
    background: var(--accent-hover);
  }
  .cta-primary:active {
    background: var(--accent-press);
  }
  .cta-secondary {
    background: var(--surface);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .cta-secondary:hover {
    background: var(--bg-muted);
  }

  /* Terminal chip — the data-as-signature house style (mono, ink panel, amber prompt). */
  .terminal {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-8);
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
  .terminal code {
    font-family: inherit;
    color: var(--text);
  }
  .terminal .prompt {
    color: var(--accent);
  }
  .terminal-sm {
    margin-top: var(--space-3);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-xs);
  }

  /* ── Sections ──────────────────────────────────────────────────────────── */
  .section-title {
    margin: 0 0 var(--space-6);
    font-size: var(--text-xl);
    line-height: var(--lh-xl);
    font-weight: 600;
    text-align: center;
  }
  .capabilities,
  .how {
    padding-block: var(--space-12);
  }

  /* Welded panel of capabilities: ONE bordered panel, internal hairline dividers — not floating cards. */
  .capability-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .capability {
    padding: var(--space-6);
    border-top: 1px solid var(--border);
    border-left: 1px solid var(--border);
  }
  /* The first row has no top rule; the first column no left rule — interior hairlines only. */
  .capability:nth-child(-n + 2) {
    border-top: none;
  }
  .capability:nth-child(odd) {
    border-left: none;
  }
  .capability h3 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-base);
    font-weight: 600;
  }
  .capability p {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: var(--lh-sm);
  }

  /* Steps — numbered, hairline-separated rows. */
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    max-width: 48rem;
    margin-inline: auto;
  }
  .step {
    display: flex;
    gap: var(--space-4);
    align-items: flex-start;
  }
  .step-n {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-strong);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--accent);
  }
  .step-body h3 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-base);
    font-weight: 600;
  }
  .step-body p {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: var(--lh-sm);
  }

  /* ── Closing CTA band ──────────────────────────────────────────────────── */
  .closing {
    text-align: center;
    padding-block: var(--space-16);
    margin-top: var(--space-8);
  }
  .closing h2 {
    margin: 0 auto;
    max-width: 24ch;
    font-size: var(--text-xl);
    line-height: var(--lh-xl);
    font-weight: 600;
  }

  /* ── Footer ────────────────────────────────────────────────────────────── */
  .footer-inner {
    flex-wrap: wrap;
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
  .footer-nav {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
    flex: 1;
  }
  .license {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  /* ── Responsive ────────────────────────────────────────────────────────── */
  @media (max-width: 640px) {
    .hero {
      padding-block: var(--space-10) var(--space-8);
    }
    h1 {
      font-size: var(--text-xl);
      line-height: var(--lh-xl);
    }
    .capability-grid {
      grid-template-columns: 1fr;
    }
    /* Single column: every row but the first gets a top rule; no left rules. */
    .capability {
      border-left: none;
      border-top: 1px solid var(--border);
    }
    .capability:first-child {
      border-top: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .cta,
    .nav-link {
      transition: none;
    }
  }
</style>
