/**
 * WOPR GitHub Plugin Types
 *
 * Shared types (WOPRPlugin, WOPRPluginContext, etc.) are imported from
 * @wopr-network/plugin-types. This file contains only GitHub-specific types.
 */

import type { ConfigSchema, WOPRPlugin } from "@wopr-network/plugin-types";

export type { WOPRPluginContext } from "@wopr-network/plugin-types";

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

	/** Update an existing org webhook when the hostname changes */
	updateWebhook(
		org: string,
		oldHostname: string,
		newHostname: string,
	): Promise<WebhookSetupResult>;

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

/**
 * Extension of WOPRPlugin that includes configSchema for backward compatibility.
 * The shared WOPRPlugin type uses `manifest` instead, but existing plugins
 * still use the inline configSchema format.
 */
export interface WOPRPluginWithConfig extends WOPRPlugin {
	configSchema?: ConfigSchema;
}

/**
 * Minimal event emitter for custom inter-plugin events.
 * Used to subscribe to custom event names (e.g. "webhooks:ready")
 * that are not part of the core WOPREventMap.
 */
export interface CustomEventEmitter {
	on(event: string, listener: (...args: any[]) => void): void;
	off(event: string, listener: (...args: any[]) => void): void;
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
