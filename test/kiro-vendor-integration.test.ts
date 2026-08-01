import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugLogger } from "../src/providers/kiro/vendor/debug-logger.js";
import { crc32 } from "../src/providers/kiro/vendor/eventstream.js";
import { createKiroStream } from "../src/providers/kiro/vendor/kiro.js";

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function bytes(...parts: Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}

function stringHeader(name: string, value: string): Uint8Array {
	const encodedName = encoder.encode(name);
	const encodedValue = encoder.encode(value);
	const output = new Uint8Array(1 + encodedName.length + 1 + 2 + encodedValue.length);
	const view = new DataView(output.buffer);
	output[0] = encodedName.length;
	output.set(encodedName, 1);
	output[1 + encodedName.length] = 7;
	view.setUint16(2 + encodedName.length, encodedValue.length, false);
	output.set(encodedValue, 4 + encodedName.length);
	return output;
}

function eventFrame(eventType: string, payload: Record<string, unknown>): Uint8Array {
	const headers = bytes(stringHeader(":message-type", "event"), stringHeader(":event-type", eventType));
	const body = encoder.encode(JSON.stringify(payload));
	const frame = new Uint8Array(16 + headers.length + body.length);
	const view = new DataView(frame.buffer);
	view.setUint32(0, frame.length, false);
	view.setUint32(4, headers.length, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(headers, 12);
	frame.set(body, 12 + headers.length);
	view.setUint32(frame.length - 4, crc32(frame.subarray(0, frame.length - 4)), false);
	return frame;
}

function model(): Model<Api> {
	return {
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "kiro-codewhisperer",
		provider: "kiro",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 32_000,
	};
}

type CapturedRequest = {
	conversationState: {
		currentMessage: {
			userInputMessage: {
				content: string;
				userInputMessageContext?: {
					tools?: Array<{ toolSpecification: { inputSchema: { json: unknown } } }>;
				};
			};
		};
	};
};

describe("Kiro vendor integration", () => {
	it("posts sanitized tools, preserves long context, and decodes fragmented eventstream frames", async () => {
		const longPrompt = Array.from({ length: 2_000 }, (_, index) => `context-marker-${index}`).join("\n");
		const context = {
			messages: [{ role: "user", content: longPrompt, timestamp: Date.now() }],
			tools: [
				{
					name: "dispatch",
					description: "Dispatch an action",
					parameters: {
						oneOf: [
							{
								type: "object",
								additionalProperties: false,
								properties: { action: { const: "create" } },
								required: ["action"],
							},
							{
								type: "object",
								additionalProperties: false,
								properties: { action: { const: "remove" } },
								required: ["action"],
							},
						],
					},
				},
			],
		} as Context;
		let captured: CapturedRequest | undefined;
		const frame = eventFrame("assistantResponseEvent", { content: "hello", messageId: "response-1" });
		globalThis.fetch = vi.fn(async (_input, init) => {
			captured = JSON.parse(String(init?.body)) as CapturedRequest;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(frame.subarray(0, 7));
					controller.enqueue(frame.subarray(7, 29));
					controller.enqueue(frame.subarray(29));
					controller.close();
				},
			});
			return new Response(body, { status: 200 });
		});
		const logger = new DebugLogger({ extensionRoot: "/tmp/senpi-accounts-test", debug: false });
		const logError = vi.spyOn(logger, "error");
		const stream = createKiroStream(
			{
				providerId: "kiro",
				upstreamUrl: "https://example.invalid/generate",
				endpoint: "codewhisperer",
				apiKey: "managed",
				requestTimeoutMs: 1_000,
				headers: {},
			},
			{},
			logger,
		)(model(), context, { apiKey: "access-token" });
		const events: Record<string, unknown>[] = [];
		for await (const event of stream as unknown as AsyncIterable<Record<string, unknown>>) events.push(event);

		expect(captured?.conversationState.currentMessage.userInputMessage.content).toBe(longPrompt);
		expect(
			captured?.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0]
				?.toolSpecification.inputSchema.json,
		).toEqual({
			type: "object",
			properties: { action: { enum: ["create", "remove"] } },
			required: ["action"],
		});
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(events.find((event) => event.type === "text_delta")).toMatchObject({ delta: "hello" });
		expect(logError).not.toHaveBeenCalled();
	});
});
