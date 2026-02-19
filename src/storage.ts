/**
 * WOPR Plugin Storage API
 *
 * Defines the interface for the SQL-backed Storage API that plugins use
 * to persist data. This interface matches the expected runtime API on
 * WOPRPluginContext.storage when the WOPR daemon provides it.
 *
 * The Storage API is optional — plugins must check for its presence and
 * log a warning if unavailable (graceful degradation).
 */

/**
 * Schema definition for a storage table.
 * Passed to storage.register() to declare the plugin's data schema.
 */
export interface StorageTableSchema {
	/** Human-readable description of this table */
	description?: string;
	/** Version for schema migrations */
	version?: number;
}

/**
 * The Storage API provided to plugins via ctx.storage.
 * Plugins access this as (ctx as PluginContextWithStorage).storage.
 */
export interface PluginStorageAPI {
	/**
	 * Register a storage table schema with the WOPR daemon.
	 * Call this during plugin init() before using get/put/list/delete.
	 */
	register(table: string, schema: StorageTableSchema): void;

	/**
	 * Retrieve a stored value by table and key.
	 * Returns null if the key does not exist.
	 */
	get(table: string, key: string): Promise<unknown>;

	/**
	 * Store a value under table/key (upsert semantics).
	 */
	put(table: string, key: string, value: unknown): Promise<void>;

	/**
	 * List all values in a table.
	 */
	list(table: string): Promise<unknown[]>;

	/**
	 * Delete a value by table and key.
	 */
	delete(table: string, key: string): Promise<void>;
}

/**
 * Extended plugin context type that includes the optional Storage API.
 * Use this to safely access ctx.storage without modifying plugin-types.
 */
export interface PluginContextWithStorage {
	storage?: PluginStorageAPI;
}

/**
 * Storage table name for GitHub webhook subscriptions.
 */
export const SUBSCRIPTIONS_TABLE = "github_subscriptions";

/**
 * Schema for the subscriptions table.
 */
export const SUBSCRIPTIONS_SCHEMA: StorageTableSchema = {
	description: "GitHub repo webhook subscriptions — keyed by owner/repo string",
	version: 1,
};
