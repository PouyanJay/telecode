import webpush from 'web-push';

/** A stored push subscription (the DB columns), as the relay holds it. */
export interface StoredPushSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/**
 * The notification payload. ROUTING METADATA ONLY — the relay never includes agent content (prompts,
 * tool details), keeping it payload-blind. `data.url` is the deep-link the service worker opens.
 */
export interface PushPayload {
  readonly title: string;
  readonly body: string;
  readonly data: { readonly sessionId: string; readonly url: string };
}

/**
 * The seam that isolates web-push delivery (a DI boundary like `AgentAdapter`/`GithubClient`), so the
 * relay's awaiting-input path is exercised in tests without a real push service. `gone` is true when the
 * subscription has expired (HTTP 404/410) so the caller can prune it.
 */
export interface PushSender {
  send(subscription: StoredPushSubscription, payload: PushPayload): Promise<{ gone: boolean }>;
}

export interface VapidConfig {
  /** `mailto:` (or https) contact for the push services, per the VAPID spec. */
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

/** The real sender: encrypts the payload to the subscription keys and delivers it via web-push + VAPID. */
export function createWebPushSender(vapid: VapidConfig): PushSender {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return {
    async send(subscription, payload): Promise<{ gone: boolean }> {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
        );
        return { gone: false };
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        // 404/410: the subscription is dead (browser unsubscribed / endpoint expired) → prune it.
        if (statusCode === 404 || statusCode === 410) {
          return { gone: true };
        }
        throw err;
      }
    },
  };
}
