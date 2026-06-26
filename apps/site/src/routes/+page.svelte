<script lang="ts">
  import { siteContent } from '$lib/content';

  const { productName, tagline, subhead, capabilities, primaryCta, secondaryCta } = siteContent;
</script>

<svelte:head>
  <title>{productName} — run Claude Code agents on your machine, from any browser</title>
  <meta name="description" content={subhead} />
</svelte:head>

<main id="main">
  <section class="hero" aria-labelledby="hero-title">
    <p class="eyebrow">{productName}</p>
    <h1 id="hero-title">{tagline}</h1>
    <p class="subhead">{subhead}</p>
    <div class="cta-row">
      <a class="cta cta-primary" href={primaryCta.href}>{primaryCta.label}</a>
      <a class="cta cta-secondary" href={secondaryCta.href} rel="noreferrer">
        {secondaryCta.label}
      </a>
    </div>
  </section>

  <section class="capabilities" aria-label="What telecode is">
    <ul class="capability-grid">
      {#each capabilities as capability (capability.id)}
        <li class="capability">
          <h2>{capability.title}</h2>
          <p>{capability.body}</p>
        </li>
      {/each}
    </ul>
  </section>
</main>

<style>
  main {
    max-width: var(--width-content);
    margin: 0 auto;
    padding: var(--space-16) var(--space-5) var(--space-12);
  }

  .hero {
    text-align: center;
    padding-block: var(--space-12) var(--space-16);
  }
  .eyebrow {
    margin: 0 0 var(--space-4);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: 0.18em;
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
    max-width: 56ch;
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

  .capability-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-4);
  }
  .capability {
    padding: var(--space-6);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .capability h2 {
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

  @media (max-width: 640px) {
    main {
      padding-top: var(--space-10);
    }
    .capability-grid {
      grid-template-columns: 1fr;
    }
    h1 {
      font-size: var(--text-xl);
      line-height: var(--lh-xl);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .cta {
      transition: none;
    }
  }
</style>
