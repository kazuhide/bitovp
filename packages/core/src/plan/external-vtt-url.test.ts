import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { liveChannelPlanSchema } from "../live/schema";
import { curlForStep } from "./curl-from-step";
import { encodingPlanSchema } from "./schema";
import type { StepLogEntry } from "./steplog";
import { loadPlan } from "./test-support";

const privateUrls = [
	"https://cdn.example.test/sub.vtt?token=SYNTHETIC_URL_SECRET",
	"https://cdn.example.test/sub.vtt?X-Amz-Credential=SYNTHETIC_URL_SECRET&X-Amz-Signature=SYNTHETIC_SIGNATURE",
	"https://cdn.example.test/sub.vtt?Policy=SYNTHETIC_URL_SECRET&Signature=SYNTHETIC_SIGNATURE&Key-Pair-Id=example",
	"https://cdn.example.test/sub.vtt?ticket=SYNTHETIC_URL_SECRET",
	"https://cdn.example.test/sub.vtt?%74%6f%6b%65%6e=SYNTHETIC_URL_SECRET",
	"https://cdn.example.test/sub.vtt#SYNTHETIC_URL_SECRET",
	"https://synthetic-user:SYNTHETIC_URL_SECRET@cdn.example.test/sub.vtt",
	"https://SYNTHETIC_URL_SECRET@cdn.example.test/sub.vtt",
	"ftp://cdn.example.test/sub.vtt",
	"SYNTHETIC_URL_SECRET",
];
const publicUrls = [
	"https://cdn.example.test/subtitles/ja%20JP.vtt",
	"http://cdn.example.test:8080/subtitles/en.vtt",
];

function parsePlans(vttUrl: string, kind: "HLS" | "DASH") {
	const vod = loadPlan("av1-fmp4-dash-hls");
	const live = liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				new URL(
					"../live/__fixtures__/live-rtmp-simple.plan.json",
					import.meta.url,
				),
				"utf8",
			),
		),
	);
	for (const manifest of [...vod.manifests, ...live.liveManifests]) {
		if (manifest.kind !== kind) continue;
		if (manifest.kind === "HLS")
			manifest.detailed = {
				additionalMedia: [
					{
						type: "VTT",
						name: "English",
						groupId: "subtitles",
						uri: "subtitles.m3u8",
						vttUrl,
					},
				],
			};
		else
			manifest.detailed = {
				additionalRepresentations: [{ type: "VTT", vttUrl, lang: "en" }],
			};
	}
	return [
		encodingPlanSchema.safeParse(vod),
		liveChannelPlanSchema.safeParse(live),
	];
}

function entry(kind: "HLS" | "DASH", vttUrl: string): StepLogEntry {
	return {
		step: "external-subtitle",
		kind:
			kind === "HLS"
				? "CREATE_HLS_VTT_MEDIA"
				: "CREATE_DASH_REPRESENTATION_VTT",
		status: "DONE",
		payload: { vttUrl },
		refs: {
			manifestId: "manifest",
			periodId: "period",
			adaptationSetId: "set",
		},
		request: {
			vttUrl,
			...(kind === "HLS"
				? { name: "English", groupId: "subtitles", uri: "subtitles.m3u8" }
				: {}),
			refs: {
				manifestId: "manifest-id",
				periodId: "period-id",
				adaptationSetId: "set-id",
			},
		},
	};
}

describe.each([
	"HLS",
	"DASH",
] as const)("external %s VTT URL policy", (kind) => {
	it.each(
		privateUrls,
	)("rejects credential-bearing URLs before VOD or Live plan persistence: %s", (url) => {
		for (const result of parsePlans(url, kind)) {
			expect(result.success).toBe(false);
			if (result.success) throw new Error("Expected a rejected URL");
			expect(result.error.message).toMatch(/public.*query.*signed URLs/i);
			expect(result.error.message).not.toContain("SYNTHETIC_URL_SECRET");
		}
	});
	it.each(
		publicUrls,
	)("keeps public VTT URLs usable in both plan types: %s", (url) => {
		for (const result of parsePlans(url, kind))
			expect(result.success).toBe(true);
		const log = entry(kind, url);
		const before = structuredClone(log);
		const curl = curlForStep(log);
		expect(curl.ok).toBe(true);
		if (!curl.ok) throw new Error(curl.code);
		expect(curl.command).toContain(url);
		expect(log).toEqual(before);
	});
	it.each(
		privateUrls,
	)("refuses cURL from an older credential-bearing snapshot: %s", (url) => {
		const log = entry(kind, url);
		const before = structuredClone(log);
		const result = curlForStep(log);
		expect(result).toEqual({
			ok: false,
			code: "UNSAFE_EXTERNAL_VTT_URL",
			kind: log.kind,
		});
		expect(JSON.stringify(result)).not.toContain("SYNTHETIC_URL_SECRET");
		expect(log).toEqual(before);
	});
});
