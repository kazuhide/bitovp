import { describe, expect, it, vi } from "vitest";
import {
	AisaTranslationError,
	probeAisaTranslationEngine,
	readAisaTranslationEngineConfig,
	translateAisaObservations,
} from "./aisa-live-translations-engine";

const config = {
	baseUrl: "http://127.0.0.1:11445/v1",
	model: "installed-qwen",
	token: "private-token",
};
const input = [{ id: "observation-1", text: "The player scores a goal." }];
const completion = (content: unknown, extra: Record<string, unknown> = {}) =>
	Response.json({
		model: config.model,
		choices: [
			{ finish_reason: "stop", message: { content: JSON.stringify(content) } },
		],
		...extra,
	});

describe("installed local AISA translation engine", () => {
	it("requires explicit server configuration and refuses nonlocal or credential-bearing URLs", () => {
		expect(readAisaTranslationEngineConfig({})).toBeUndefined();
		for (const baseUrl of [
			"https://cloud.example/v1",
			"http://localhost.example/v1",
			"http://token@127.0.0.1/v1",
			"http://127.0.0.1/v1?key=private",
		])
			expect(() =>
				readAisaTranslationEngineConfig({
					BITOVP_AISA_TRANSLATION_BASE_URL: baseUrl,
					BITOVP_AISA_TRANSLATION_MODEL: config.model,
				}),
			).toThrow(AisaTranslationError);
		expect(
			readAisaTranslationEngineConfig({
				BITOVP_AISA_TRANSLATION_BASE_URL: config.baseUrl,
				BITOVP_AISA_TRANSLATION_MODEL: config.model,
			}),
		).toEqual({ baseUrl: config.baseUrl, model: config.model });
	});
	it("reports availability only when the configured model is advertised by the local engine", async () => {
		expect(
			await probeAisaTranslationEngine(
				config,
				vi.fn(async () => Response.json({ data: [{ id: config.model }] })),
			),
		).toBe(true);
		expect(
			await probeAisaTranslationEngine(
				config,
				vi.fn(async () => Response.json({ data: [{ id: "another-model" }] })),
			),
		).toBe(false);
		expect(
			await probeAisaTranslationEngine(
				config,
				vi.fn(async () => {
					throw new Error("private connection detail");
				}),
			),
		).toBe(false);
	});
	it("sends only immutable source strings and accepts the exact requested IDs", async () => {
		const transport = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body));
				expect(body.model).toBe(config.model);
				expect(body.stream).toBe(false);
				expect(body.messages[0].content).toContain("Translate");
				expect(body.messages[1].content).toBe(
					JSON.stringify({
						observations: [{ id: "o0", text: input[0]?.text }],
					}),
				);
				expect(JSON.stringify(body)).not.toContain("startInSeconds");
				expect(new Headers(init?.headers).get("Authorization")).toBe(
					"Bearer private-token",
				);
				return completion({
					translations: [{ id: "o0", text: "選手がゴールを決めます。" }],
				});
			},
		);
		expect(await translateAisaObservations(config, input, transport)).toEqual([
			{ id: "observation-1", text: "選手がゴールを決めます。" },
		]);
		expect(transport).toHaveBeenCalledTimes(1);
	});
	it("rejects invented IDs, missing IDs, duplicate IDs, non-Japanese text and truncated output", async () => {
		for (const translations of [
			[],
			[{ id: "foreign", text: "ゴール" }],
			[
				{ id: "observation-1", text: "ゴール" },
				{ id: "observation-1", text: "ゴール" },
			],
			[{ id: "observation-1", text: "A goal" }],
		])
			await expect(
				translateAisaObservations(
					config,
					input,
					vi.fn(async () => completion({ translations })),
				),
			).rejects.toThrow(AisaTranslationError);
		await expect(
			translateAisaObservations(
				config,
				input,
				vi.fn(async () =>
					completion(
						{},
						{
							choices: [
								{ finish_reason: "length", message: { content: "{}" } },
							],
						},
					),
				),
			),
		).rejects.toThrow(AisaTranslationError);
	});
	it("never exposes transport details or retries inference automatically", async () => {
		const transport = vi.fn(async () => {
			throw new Error("token=private-token");
		});
		await expect(
			translateAisaObservations(config, input, transport),
		).rejects.toThrow("AISA translation unavailable");
		expect(transport).toHaveBeenCalledTimes(1);
	});
});
