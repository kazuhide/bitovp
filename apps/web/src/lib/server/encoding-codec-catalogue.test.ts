import BitmovinApi from "@bitmovin/api-sdk";
import { expect, it, vi } from "vitest";
import { encodingCodecProtocols } from "@/lib/encoding-codec-catalogue";
import { auditedOperationCases } from "../../../../../scripts/api-coverage-test-cases";
import { encodingCodecReader } from "./encoding-codec-catalogue";

// SDK 1.289.0 wire spellings. Keep expected paths independent of the readers.
const groups = [
	{
		kind: "video-codecs",
		family: "video",
		protocols: ["av1", "h262", "h264", "h265", "h265v2", "mjpeg", "vp8", "vp9"],
	},
	{
		kind: "audio-codecs",
		family: "audio",
		protocols: [
			"aac",
			"ac3",
			"dolby-atmos",
			"dolby-digital",
			"dolby-digital-plus",
			"dts",
			"dts-passthrough",
			"dtsx",
			"eac3",
			"he-aac-v1",
			"he-aac-v2",
			"mp2",
			"mp3",
			"opus",
			"passthrough",
			"pcm",
			"vorbis",
		],
	},
	{
		kind: "subtitle-codecs",
		family: "subtitles",
		protocols: ["dvb-subtitle", "imsc", "webvtt"],
	},
] as const;

const cases = groups.flatMap(({ kind, family, protocols }) =>
	protocols.map((protocol) => ({ kind, family, protocol })),
);

const ID = "e96acd24-9ead-42d6-88dd-a706b3dfdeab";
const OFFSET = 11;
const LIMIT = 7;
const account = { apiKey: "fixture-api-key", tenantOrgId: "fixture-tenant" };

it.each(
	auditedOperationCases(
		import.meta.url,
		"native-codec-pairs",
		cases,
		({ family, protocol }) => [
			`GET /encoding/configurations/${family}/${protocol}`,
			`GET /encoding/configurations/${family}/${protocol}/{configuration_id}`,
		],
	),
)("sends exact paginated list and detail GETs for $kind/$protocol", async ({
	kind,
	family,
	protocol,
}) => {
	const path = `/v1/encoding/configurations/${family}/${protocol}`;
	const resource = { id: ID, name: "Test codec configuration" };
	const page = { items: [resource], offset: OFFSET, totalCount: OFFSET + 1 };
	const transport = vi.fn(async (url: string, _init?: RequestInit) =>
		Response.json({
			status: "SUCCESS",
			data: {
				result: new URL(url).pathname === `${path}/${ID}` ? resource : page,
			},
		}),
	);
	const api = new BitmovinApi({ ...account, fetch: transport });
	const reader = encodingCodecReader(kind, protocol);
	if (!reader) throw new Error(`Missing codec reader: ${kind}/${protocol}`);

	await expect(
		reader.list(api, { offset: OFFSET, limit: LIMIT }),
	).resolves.toMatchObject(page);
	await expect(reader.get(api, ID)).resolves.toMatchObject(resource);
	const sent = transport.mock.calls.map(([target, init]) => {
		const url = new URL(target);
		const headers = new Headers(init?.headers);
		expect(url.origin).toBe("https://api.bitmovin.com");
		expect(init?.method).toBe("GET");
		expect(init?.body).toBeUndefined();
		expect(headers.get("X-Api-Key")).toBe(account.apiKey);
		expect(headers.get("X-Tenant-Org-Id")).toBe(account.tenantOrgId);
		return [url.pathname, Object.fromEntries(url.searchParams)];
	});
	expect(sent).toEqual([
		[path, { offset: String(OFFSET), limit: String(LIMIT) }],
		[`${path}/${ID}`, {}],
	]);
});

it("publishes labels for the exact typed codec pairs", () => {
	expect(Object.keys(encodingCodecProtocols).sort()).toEqual(
		groups.map(({ kind }) => kind).sort(),
	);
	for (const { kind, protocols } of groups) {
		expect(Object.keys(encodingCodecProtocols[kind]).sort()).toEqual(
			[...protocols].sort(),
		);
		for (const label of Object.values(encodingCodecProtocols[kind]))
			expect(label.trim()).not.toBe("");
	}
});

it.each([
	["video-codecs", undefined],
	["video-codecs", ""],
	["video-codecs", "aac"],
	["video-codecs", "h264/customData"],
	["video-codecs", "constructor"],
	["audio-codecs", "__proto__"],
	["inputs", "s3"],
	["__proto__", "av1"],
	["constructor", "av1"],
] as const)("rejects non-allowlisted selection %s / %s", (kind, protocol) => {
	expect(encodingCodecReader(kind, protocol)).toBeUndefined();
});
