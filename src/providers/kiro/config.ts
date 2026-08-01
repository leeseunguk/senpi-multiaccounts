/**
 * Kiro endpoint and model configuration.
 *
 * Values verified against Kiro's desktop auth service and the CodeWhisperer
 * streaming API. Model availability is decided server-side by the account's
 * subscription tier, so this list is a catalog: `KIRO_MODELS_OVERRIDE` lets the
 * user pin a different set without a code change.
 */

export const KIRO_PROVIDER_ID = "kiro";
export const KIRO_API = "kiro-codewhisperer";

export const KIRO_REGION = "us-east-1";

/** CodeWhisperer streaming inference endpoint. */
export const KIRO_UPSTREAM_URL = `https://codewhisperer.${KIRO_REGION}.amazonaws.com/generateAssistantResponse`;

/** Kiro's desktop auth service: Google / GitHub social login and refresh. */
export const KIRO_AUTH_BASE = `https://prod.${KIRO_REGION}.auth.desktop.kiro.dev`;

export const KIRO_SOCIAL = {
	portalUrl: "https://app.kiro.dev/signin",
	portalRedirectUri: "http://localhost:3128",
	callbackPath: "/oauth/callback",
	authorizeUrl: `${KIRO_AUTH_BASE}/login`,
	tokenUrl: `${KIRO_AUTH_BASE}/oauth/token`,
	refreshUrl: `${KIRO_AUTH_BASE}/refreshToken`,
	/** Used only when no local callback server can be bound. */
	redirectUri: "kiro://kiro.kiroAgent/authenticate-success",
} as const;

/**
 * AWS Builder ID / Identity Center. Kiro's auth service does not serve Builder
 * ID, so it must go through the SSO OIDC device-code flow instead.
 */
export const KIRO_IDC = {
	startUrl: "https://view.awsapps.com/start",
	clientName: "kiro-oauth-client",
	clientType: "public",
	issuerUrl: "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6",
	scopes: ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"],
	grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
} as const;

export type KiroAuthMethod = "google" | "github" | "builder-id";

export const KIRO_AUTH_METHOD_LABELS: Record<KiroAuthMethod, string> = {
	google: "Google",
	github: "GitHub",
	"builder-id": "AWS Builder ID",
};

export const KIRO_MAX_OUTPUT_TOKENS = 32_000;
export const KIRO_REQUEST_TIMEOUT_MS = 600_000;

export interface KiroModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function model(id: string, name: string, contextWindow: number, input: ("text" | "image")[] = ["text"]): KiroModel {
	return {
		id,
		name,
		reasoning: true,
		input,
		contextWindow,
		maxTokens: KIRO_MAX_OUTPUT_TOKENS,
		// Subscription-metered: senpi must not attribute per-token cost to it.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

/**
 * Catalog of models Kiro may serve. Entries the account is not entitled to
 * simply fail upstream, so listing a model here is not a promise it is usable.
 *
 * Synchronized with `kiro-cli 2.15.2 chat --list-models`. Listing models is
 * read-only; completion probing is deliberately not automatic because it
 * consumes credits and eligibility can differ between pooled accounts.
 */
export const KIRO_MODELS: KiroModel[] = [
	model("auto", "Auto (Kiro)", 1_000_000),
	model("claude-opus-5", "Claude Opus 5 (Kiro)", 1_000_000),
	model("claude-sonnet-5", "Claude Sonnet 5 (Kiro)", 1_000_000),
	model("claude-opus-4.8", "Claude Opus 4.8 (Kiro)", 1_000_000),
	model("gpt-5.6-sol", "GPT-5.6 Sol (Kiro)", 272_000),
	model("gpt-5.6-terra", "GPT-5.6 Terra (Kiro)", 272_000),
	model("gpt-5.6-luna", "GPT-5.6 Luna (Kiro)", 272_000),
	model("claude-opus-4.7", "Claude Opus 4.7 (Kiro)", 1_000_000),
	model("claude-opus-4.6", "Claude Opus 4.6 (Kiro)", 1_000_000),
	model("claude-sonnet-4.6", "Claude Sonnet 4.6 (Kiro)", 1_000_000),
	model("claude-opus-4.5", "Claude Opus 4.5 (Kiro)", 200_000),
	model("claude-sonnet-4.5", "Claude Sonnet 4.5 (Kiro)", 200_000),
	model("claude-sonnet-4", "Claude Sonnet 4 (Kiro)", 200_000),
	model("claude-haiku-4.5", "Claude Haiku 4.5 (Kiro)", 200_000),
	model("deepseek-3.2", "DeepSeek 3.2 (Kiro)", 164_000),
	model("minimax-m2.5", "MiniMax M2.5 (Kiro)", 196_000),
	model("minimax-m2.1", "MiniMax M2.1 (Kiro)", 196_000),
	model("glm-5", "GLM-5 (Kiro)", 200_000),
	model("qwen3-coder-next", "Qwen3 Coder Next (Kiro)", 256_000),
];

/**
 * Resolve the model list, allowing `KIRO_MODELS_OVERRIDE` to replace it with a
 * comma-separated list of ids. Unknown ids are carried through so a newly
 * released model can be used before this catalog knows about it.
 */
export function resolveModels(env: NodeJS.ProcessEnv = process.env): KiroModel[] {
	const override = env.KIRO_MODELS_OVERRIDE?.trim();
	if (!override) return KIRO_MODELS;

	const ids = override
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean)
		.filter((id, index, all) => all.indexOf(id) === index);
	if (ids.length === 0) return KIRO_MODELS;

	return ids.map((id) => {
		const known = KIRO_MODELS.find((candidate) => candidate.id === id);
		return known ?? model(id, `${id} (Kiro)`, 200_000);
	});
}
