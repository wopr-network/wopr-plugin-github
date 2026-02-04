/**
 * WOPR GitHub Plugin Types
 */

export interface GitHubConfig {
  /** GitHub organizations to manage */
  orgs?: string[];
  /** Session to route PR events to */
  prReviewSession?: string;
  /** Session to route merge/release events to */
  releaseSession?: string;
}

export interface WebhookSetupResult {
  success: boolean;
  webhookUrl?: string;
  webhookId?: number;
  error?: string;
}

export interface GitHubExtension {
  /** Set up GitHub webhook for an org */
  setupWebhook(org: string): Promise<WebhookSetupResult>;

  /** Get webhook URL (requires funnel) */
  getWebhookUrl(): Promise<string | null>;

  /** Check if gh CLI is authenticated */
  isAuthenticated(): Promise<boolean>;
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
