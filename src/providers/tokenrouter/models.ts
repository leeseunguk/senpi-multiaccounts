/**
 * Model catalog for the `tokenrouter` provider.
 *
 * An extension-registered provider id has no built-in catalog to inherit, so a
 * provider without a `models` array registers "successfully" with zero models
 * and `--provider tokenrouter` then fails with `Unknown provider`.
 *
 * TokenRouter is a router: its upstream list changes often, and `GET /v1/models`
 * returns ids only — no context window, no pricing. Those are the two things
 * senpi needs to budget a turn, so this file pins the models actually worth
 * routing through and `TOKENROUTER_MODELS_OVERRIDE` lets a user add more without
 * a code change. Costs are per-million tokens, matching stock's catalog.
 */

export interface TokenRouterModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: {
		supportsStore: boolean;
		supportsDeveloperRole: boolean;
		supportsReasoningEffort: boolean;
		supportsUsageInStreaming: boolean;
		supportsStrictMode: boolean;
		maxTokensField: "max_tokens";
	};
}

/**
 * TokenRouter speaks the OpenAI wire format but not OpenAI's newer dialect.
 * Measured against the live endpoint with a real key:
 *
 *   role: "developer"  -> HTTP 400 "role 'developer' is not allowed"
 *   store: false       -> HTTP 200 but the body is whitespace, no completion
 *
 * senpi sends both by default for an `openai-completions` provider, which is why
 * a turn came back as `422 openai_error` while a plain curl succeeded. Every
 * model therefore carries the conservative compat profile, the same way stock's
 * llama.cpp provider does for its OpenAI-compatible server.
 */
const COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
} as const;

export const TOKENROUTER_MODELS: TokenRouterModel[] = [
	{
		// Free during TokenRouter's launch promotion, hence cost 0 across the board.
		id: "moonshotai/kimi-k3-free",
		name: "Kimi K3 (free)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
		compat: COMPAT,
	},
	{
		id: "moonshotai/kimi-k3",
		name: "Kimi K3",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.6, output: 2.5, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
		compat: COMPAT,
	},
	{
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		compat: COMPAT,
	},
	{
		id: "qwen/qwen3.7-max",
		name: "Qwen 3.7 Max",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.2, output: 6, cacheRead: 0.24, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 65_536,
		compat: COMPAT,
	},
	{
		id: "z-ai/glm-5.2",
		name: "GLM 5.2",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		compat: COMPAT,
	},
];

/**
 * Catalog for this run.
 *
 * `TOKENROUTER_MODELS_OVERRIDE` takes a comma-separated list of TokenRouter
 * model ids. Unknown ids get conservative defaults rather than being dropped:
 * the router accepts them, so refusing to register them would be the addon
 * second-guessing the upstream.
 */
export function resolveTokenRouterModels(env: NodeJS.ProcessEnv): TokenRouterModel[] {
	const override = env.TOKENROUTER_MODELS_OVERRIDE?.trim();
	if (!override) return TOKENROUTER_MODELS;

	const known = new Map(TOKENROUTER_MODELS.map((model) => [model.id, model]));
	return override
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean)
		.map(
			(id) =>
				known.get(id) ?? {
					id,
					name: id,
					reasoning: false,
					input: ["text" as const],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 32_000,
					compat: COMPAT,
				},
		);
}
