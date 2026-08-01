import { describe, expect, it } from "vitest";
import {
	OPENGATEWAY_BASE_URL,
	OPENGATEWAY_MODELS,
	OPENGATEWAY_PROVIDER_ID,
	opengatewayProviderPackage,
} from "../src/providers/opengateway/index.js";

const context = {
	env: {} as NodeJS.ProcessEnv,
	agentDir: "/tmp/senpi-accounts-opengateway",
};

describe("opengateway provider package", () => {
	it("registers without credentials so senpi can offer it in /login", () => {
		const provider = opengatewayProviderPackage();

		expect(provider.id).toBe("opengateway");
		expect(OPENGATEWAY_PROVIDER_ID).toBe("opengateway");
		expect(provider.enabled).toBeUndefined();
	});

	it("uses senpi's native API-key login and credential management", async () => {
		const config = await opengatewayProviderPackage().build(context);

		expect(config.apiKey).toBe("$OPENGATEWAY_API_KEY");
		expect(config.oauth).toBeUndefined();
	});

	it("targets OpenGateway's OpenAI-compatible API", async () => {
		const config = await opengatewayProviderPackage().build(context);

		expect(OPENGATEWAY_BASE_URL).toBe("https://apis.opengateway.ai/v1");
		expect(config).toMatchObject({
			name: "OpenGateway",
			baseUrl: OPENGATEWAY_BASE_URL,
			api: "openai-completions",
		});
	});

	it("exposes the requested Kimi K3 Ultrafast model", () => {
		const model = OPENGATEWAY_MODELS.find((entry) => entry.id === "moonshotai/kimi-k3-ultrafast");

		expect(model).toMatchObject({
			name: "Kimi K3 Ultrafast",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 131_072,
		});
	});

	it("uses conservative OpenAI compatibility settings", () => {
		const model = OPENGATEWAY_MODELS[0];

		expect(model?.compat).toMatchObject({
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		});
	});
});
