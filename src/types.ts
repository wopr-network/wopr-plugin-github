/**
 * WOPR GitHub Plugin Types
 */

/**
 * Maps GitHub event types to WOPR session names.
 * Use "*" as a catch-all fallback for unmatched events.
 *
 * @example
 * { "pull_request": "code-review", "issues": "project-mgmt", "*": "default" }
 */
export type EventRoutingTable = Record<string, string>;

export interface GitHubConfig {
  /** GitHub organizations to manage */
  orgs?: string[];
  /** Session to route PR events to */
  prReviewSession?: string;
  /** Session to route merge/release events to */
  releaseSession?: string;
  /** Event-type routing table: maps GitHub event types to WOPR session names */
  routing?: EventRoutingTable;
}

export interface WebhookSetupResult {
  success: boolean;
  webhookUrl?: string;
  webhookId?: number;
  error?: string;
}

export interface WebhookEvent {
  /** GitHub event type from X-GitHub-Event header (e.g. "push", "pull_request") */
  eventType?: string;
  /** Webhook payload body */
  payload: Record<string, unknown>;
  /** GitHub delivery ID from X-GitHub-Delivery header */
  deliveryId?: string;
}

export interface WebhookRouteResult {
  /** Whether routing was successful */
  routed: boolean;
  /** Target session the event was routed to */
  session?: string;
  /** Reason if not routed */
  reason?: string;
}

export interface GitHubExtension {
  /** Set up GitHub webhook for an org */
  setupWebhook(org: string): Promise<WebhookSetupResult>;

  /** Get webhook URL (requires funnel) */
  getWebhookUrl(): Promise<string | null>;

  /** Check if gh CLI is authenticated */
  isAuthenticated(): Promise<boolean>;

  /** Route an incoming webhook event to the configured session */
  handleWebhook(event: WebhookEvent): WebhookRouteResult;

  /** Resolve which session an event type maps to (without forwarding) */
  resolveSession(eventType: string): string | null;
}

export interface WOPRPluginContext {
  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug?(msg: string): void;
  };
  getConfig<T>(): T | undefined;
  getMainConfig<T>(key: string): T | undefined;
  registerExtension(name: string, extension: unknown): void;
  unregisterExtension(name: string): void;
  getExtension(name: string): unknown;
}

export interface WOPRPlugin {
  name: string;
  version: string;
  description?: string;
  configSchema?: {
    title: string;
    description: string;
    fields: Array<{
      name: string;
      type: string;
      label?: string;
      description?: string;
      required?: boolean;
      default?: unknown;
    }>;
  };
  commands?: Array<{
    name: string;
    description: string;
    usage?: string;
    handler: (ctx: WOPRPluginContext, args: string[]) => Promise<void>;
  }>;
  init?(ctx: WOPRPluginContext): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface FunnelExtension {
  getUrl(port: number): string | null;
  expose(port: number, path?: string): Promise<string | null>;
  isAvailable(): Promise<boolean>;
  getHostname(): Promise<string | null>;
}

export interface WebhooksExtension {
  getConfig(): { basePath: string; token: string } | null;
}
