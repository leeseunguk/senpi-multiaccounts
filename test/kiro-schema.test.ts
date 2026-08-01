import { describe, expect, it } from "vitest";
import { sanitizeKiroToolSchema } from "../src/providers/kiro/vendor/kiro.js";

describe("Kiro tool schema compatibility", () => {
	it("flattens object unions and recursively sanitizes nested properties", () => {
		const schema = {
			description: "Dispatch one supported action",
			anyOf: [
				{
					type: "object",
					properties: {
						action: { const: "create" },
						payload: {
							oneOf: [
								{
									type: "object",
									properties: { kind: { const: "file" }, path: { type: "string" } },
									required: ["kind", "path"],
								},
								{
									type: "object",
									properties: { kind: { const: "directory" }, path: { type: "string" } },
									required: ["kind", "path"],
								},
							],
						},
					},
					required: ["action", "payload"],
				},
				{
					type: "object",
					properties: {
						action: { const: "remove" },
						target: { type: "string" },
					},
					required: ["action", "target"],
				},
			],
		};

		expect(sanitizeKiroToolSchema(schema)).toEqual({
			description: "Dispatch one supported action",
			type: "object",
			properties: {
				action: { enum: ["create", "remove"] },
				payload: {
					type: "object",
					properties: {
						kind: { enum: ["file", "directory"] },
						path: { type: "string" },
					},
					required: ["kind", "path"],
				},
				target: { type: "string" },
			},
			required: ["action"],
		});
	});

	it("preserves unions containing non-object variants", () => {
		const schema = {
			oneOf: [{ type: "string" }, { type: "object", properties: { value: { type: "number" } } }],
		};

		expect(sanitizeKiroToolSchema(schema)).toEqual(schema);
	});

	it("removes Kiro-rejected object keywords at every depth", () => {
		const schema = {
			type: "object",
			additionalProperties: false,
			required: [],
			properties: {
				items: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: true,
						required: [],
						properties: { value: { type: "string" } },
					},
				},
			},
		};

		expect(sanitizeKiroToolSchema(schema)).toEqual({
			type: "object",
			properties: {
				items: {
					type: "array",
					items: {
						type: "object",
						properties: { value: { type: "string" } },
					},
				},
			},
		});
		expect(schema).toHaveProperty("additionalProperties", false);
	});
});
