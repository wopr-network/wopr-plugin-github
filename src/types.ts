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
  /** Repo-level webhook subscriptions: maps "owner/repo" to subscription info */
  subscriptions?: Record<string, RepoSubscription>;
}

export interface RepoSubscription {
  /** The "owner/repo" string */
  repo: string;
  /** GitHub webhook ID (for cleanup on unsubscribe) */
  webhookId: number;
  /** GitHub event types this subscription listens for */
  events: string[];
  /** WOPR session to route events to (optional override; uses routing table if unset) */
  session?: string;
  /** ISO timestamp of when the subscription was created */
  createdAt: string;
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

export interface GitHubItemSummary {
  type: "pr" | "issue";
  repo: string;
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  bodyPreview: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** PR-only fields */
  mergeable?: string;
  reviewDecision?: string;
  additions?: number;
  deletions?: number;
  headRef?: string;
  baseRef?: string;
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

  /** View PR details */
  viewPr(repo: string, num: number): GitHubItemSummary | null;

  /** View issue details */
  viewIssue(repo: string, num: number): GitHubItemSummary | null;

  /** Subscribe a repo to webhook events */
  subscribe(
    repo: string,
    options?: { events?: string[]; session?: string },
  ): Promise<WebhookSetupResult>;

  /** Unsubscribe a repo from webhook events */
  unsubscribe(repo: string): Promise<{ success: boolean; error?: string }>;

  /** List all repo-level subscriptions */
  listSubscriptions(): RepoSubscription[];
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
