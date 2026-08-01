import { describe, expect, it } from "vitest";
import { KIRO_MODELS, resolveModels } from "../src/providers/kiro/config.js";

const KIRO_CLI_2_15_2_MODELS = [
	"auto",
	"claude-opus-5",
	"claude-sonnet-5",
	"claude-opus-4.8",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"claude-opus-4.7",
	"claude-opus-4.6",
	"claude-sonnet-4.6",
	"claude-opus-4.5",
	"claude-sonnet-4.5",
	"claude-sonnet-4",
	"claude-haiku-4.5",
	"deepseek-3.2",
	"minimax-m2.5",
	"minimax-m2.1",
	"glm-5",
	"qwen3-coder-next",
];

describe("Kiro model catalog", () => {
	it("matches the current Kiro CLI catalog", () => {
		expect(KIRO_MODELS.map((model) => model.id)).toEqual(KIRO_CLI_2_15_2_MODELS);
	});

	it("deduplicates explicit overrides while preserving order", () => {
		const models = resolveModels({
			KIRO_MODELS_OVERRIDE: "gpt-5.6-sol, claude-sonnet-5, gpt-5.6-sol",
		} as NodeJS.ProcessEnv);

		expect(models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "claude-sonnet-5"]);
	});
});
