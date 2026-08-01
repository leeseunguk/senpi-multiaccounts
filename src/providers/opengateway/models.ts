/**
 * OpenGateway's public catalog confirms that Kimi K3 Ultrafast accepts text and
 * images and supports Chat Completions. It does not publish token limits or
 * pricing, so the limits match Kimi K3 in senpi's other gateway catalogs and
 * costs stay zero rather than inventing billing data.
 */

export interface OpenGatewayModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
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

const OPENAI_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
} as const;

export const OPENGATEWAY_MODELS: OpenGatewayModel[] = [
	{
		id: "moonshotai/kimi-k3-ultrafast",
		name: "Kimi K3 Ultrafast",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		compat: OPENAI_COMPAT,
	},
];
