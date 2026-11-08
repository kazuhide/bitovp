import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalysisProvider } from "./analysis-sweep";

afterEach(() => vi.unstubAllGlobals());
describe("authoritative provider response capture", () => {
	it("binds exact successful transport bytes to account, encoding and locale", async () => {
		const raw = {
			metadata: { version: "1" },
			duration: 2,
			scenes: [],
			future: "retained",
		};
		const body = JSON.stringify({ status: "SUCCESS", data: { result: raw } });
		const fetch = vi.fn(async (_url: string) => new Response(body));
		vi.stubGlobal("fetch", fetch);
		const provider = await createAnalysisProvider({
			revealBitmovinAccount: async () => ({
				apiKey: "secret-not-evidence",
				tenantOrgId: null,
			}),
		})("account");
		expect(provider.getCaptured).toBeTypeOf("function");
		expect(await provider.getCaptured("encoding", "ja")).toEqual({
			accountId: "account",
			encodingId: "encoding",
			locale: "ja",
			providerResponseSha256: createHash("sha256").update(body).digest("hex"),
			raw,
		});
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"https://api.bitmovin.com/v1/ai-scene-analysis/analyses/by-encoding-id/encoding/details/language/ja",
		);
	});
	it("keeps concurrent locale captures isolated", async () => {
		const body = (locale: string) =>
			JSON.stringify({ status: "SUCCESS", data: { result: { locale } } });
		let finishEnglish: (() => void) | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/details"))
					await new Promise<void>((resolve) => {
						finishEnglish = resolve;
					});
				return new Response(body(url.endsWith("/details") ? "en" : "ja"));
			}),
		);
		const provider = await createAnalysisProvider({
			revealBitmovinAccount: async () => ({
				apiKey: "test",
				tenantOrgId: null,
			}),
		})("account");
		expect(provider.getCaptured).toBeTypeOf("function");
		const en = provider.getCaptured("encoding", "en");
		const ja = await provider.getCaptured("encoding", "ja");
		finishEnglish?.();
		expect(ja.raw).toEqual({ locale: "ja" });
		expect((await en).raw).toEqual({ locale: "en" });
	});
	it("does not emit capture for an unsuccessful provider response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status: "ERROR",
							data: { result: { duration: 2 } },
						}),
						{ status: 403 },
					),
			),
		);
		const provider = await createAnalysisProvider({
			revealBitmovinAccount: async () => ({
				apiKey: "test",
				tenantOrgId: null,
			}),
		})("account");
		expect(provider.getCaptured).toBeTypeOf("function");
		await expect(provider.getCaptured("encoding", "en")).rejects.toThrow();
	});
});
