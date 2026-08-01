/**
 * Model catalog for the `codex-pool` provider.
 *
 * Registering a provider without a `models` array leaves it with an empty
 * catalog: senpi's `applyExtension()` replaces a provider's model list with
 * whatever the extension supplies, and an extension-registered provider id has
 * no built-in catalog to inherit. The provider then registers "successfully"
 * but exposes zero models, so `--provider codex-pool` fails with
 * `Unknown provider`.
 *
 * These mirror stock `openai-codex` so pooling changes only which account
 * serves a request, never which models exist or how they are priced. Costs are
 * per-million tokens, matching stock's catalog.
 */

export interface CodexModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

export const CODEX_MODELS: CodexModel[] = [
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.4-mini",
		name: "GPT-5.4 Mini",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.35, output: 2.8, cacheRead: 0.035, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	},
];

/** Allow `SENPI_ACCOUNTS_CODEX_MODELS` to narrow the catalog to a subset. */
export function resolveCodexModels(env: NodeJS.ProcessEnv): CodexModel[] {
	const override = env.SENPI_ACCOUNTS_CODEX_MODELS?.trim();
	if (!override) return CODEX_MODELS;
	const ids = override
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
	if (ids.length === 0) return CODEX_MODELS;
	const selected = ids
		.map((id) => CODEX_MODELS.find((model) => model.id === id))
		.filter((model): model is CodexModel => model !== undefined);
	return selected.length > 0 ? selected : CODEX_MODELS;
}
