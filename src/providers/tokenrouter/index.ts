import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderBuildContext, ProviderConfig, ProviderPackage } from "../../core/types.js";
import { resolveTokenRouterModels, TOKENROUTER_MODELS } from "./models.js";

/**
 * TokenRouter: one OpenAI-compatible endpoint in front of many upstreams.
 *
 * Stock senpi has no `tokenrouter` provider, so `/login` cannot offer it and the
 * models are unreachable however the key is stored. Registering the provider id
 * here is what puts TokenRouter in the `/login` list — that is the whole gap
 * this package fills.
 *
 * There is no account pool: TokenRouter meters one account and rotating keys
 * would buy nothing, so this is a single-credential provider like stock's
 * `opencode-go`. That also means no affinity, no failover and no usage cache —
 * adding them would be machinery with nothing to schedule.
 */

export const TOKENROUTER_PROVIDER_ID = "tokenrouter";
export const TOKENROUTER_BASE_URL = "https://api.tokenrouter.com/v1";

export { TOKENROUTER_MODELS, resolveTokenRouterModels, type TokenRouterModel } from "./models.js";

function storedKey(agentDir: string): string | undefined {
	const authPath = join(agentDir, "auth.json");
	if (!existsSync(authPath)) return undefined;
	try {
		const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { key?: string }>;
		return auth[TOKENROUTER_PROVIDER_ID]?.key;
	} catch {
		return undefined;
	}
}

function resolveKey(context: ProviderBuildContext): string | undefined {
	return context.env.TOKENROUTER_API_KEY?.trim() || storedKey(context.agentDir);
}

export function tokenrouterProviderPackage(): ProviderPackage {
	return {
		id: TOKENROUTER_PROVIDER_ID,
		label: "TokenRouter",
		enabled(_env, context?: ProviderBuildContext) {
			// Registering a provider with no credential puts a permanently failing
			// entry in the model list, so stay out of the way until there is a key.
			// `context` is absent in stock's `enabled(env)` shape; treat that as
			// "cannot tell" and register, letting `build` surface the real state.
			if (!context) return true;
			return resolveKey(context)
				? true
				: "no TokenRouter credential; run `/login tokenrouter` or set TOKENROUTER_API_KEY";
		},
		build(context: ProviderBuildContext): ProviderConfig {
			const apiKey = resolveKey(context);
			return {
				name: "TokenRouter",
				baseUrl: TOKENROUTER_BASE_URL,
				api: "openai-completions",
				models: resolveTokenRouterModels(context.env),
				...(apiKey === undefined ? {} : { apiKey }),
				oauth: {
					name: "TokenRouter (API key)",
					// `/login tokenrouter` prompts for the key from the TokenRouter
					// console; senpi persists whatever this returns into auth.json.
					login: async (callbacks) => {
						const prompt = (callbacks as unknown as { prompt?: (spec: unknown) => Promise<string> }).prompt;
						if (!prompt) throw new Error("TokenRouter login needs an interactive prompt");
						const key = (
							await prompt({
								type: "secret",
								message: "TokenRouter API key (https://www.tokenrouter.com -> Console -> API Keys)",
							})
						).trim();
						if (!key) throw new Error("No TokenRouter API key entered");
						return { type: "api_key", key } as never;
					},
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => (credentials as unknown as { key?: string }).key ?? "",
				},
			};
		},
	};
}
