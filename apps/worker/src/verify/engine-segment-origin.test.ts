import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedArtefacts,
	compileExpectedLiveArtefacts,
	compileLiveChannel,
	compilePlan,
	encodingPlanSchema,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { type EngineDeps, verifyArtefacts } from "./engine";
import { verifyLiveChannel } from "./engine-live";

const cases = [
	...[false, true].flatMap((template) =>
		["rand_chars", "rand_chars:8"].map((token) => ({
			template,
			token,
			emptyTemplate: false,
		})),
	),
	{ template: false, token: "rand_chars", emptyTemplate: true },
];
const kinds = ["FMP4", "TS", "CMAF"] as const;

function fixture(family: "live" | "plan", name: string) {
	return JSON.parse(
		readFileSync(
			join(
				import.meta.dirname,
				"../../../../packages/core/src",
				family,
				"__fixtures__",
				`${name}.plan.json`,
			),
			"utf8",
		),
	);
}

function naming(
	kind: (typeof kinds)[number],
	template: boolean,
	token: string,
	emptyTemplate: boolean,
) {
	const suffix = kind === "TS" ? "ts" : "m4s";
	const literal = `seg-{${token}}-%number%.${suffix}`;
	const expanded = `seg-${"A".repeat(token.includes(":") ? 8 : 32)}-1.${suffix}`;
	return {
		fields: template
			? {
					segmentNaming: `default_%number%.${suffix}`,
					segmentNamingTemplate: literal,
				}
			: {
					segmentNaming: literal,
					...(emptyTemplate ? { segmentNamingTemplate: "" } : {}),
				},
		written: template ? expanded : literal.replace("%number%", "1"),
		wrong: template ? literal.replace("%number%", "1") : expanded,
	};
}

function depsFor(keys: string[]): EngineDeps {
	return {
		listAll: async (_outputKey, prefix) =>
			keys
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key, size: 1000 })),
		fetchObject: async (_outputKey, key) => key,
		fetchConcatenated: async (_outputKey, keys) => keys.join("+"),
		probe: async () => ({
			height: 360,
			videoCodec: "h264",
			durationSec: 6,
			bitrateBps: 400000,
		}),
		scanBoxes: async () => ({ psshSystemIds: [] }),
		readText: async () => "",
		parseHls: async () => ({ variants: [], media: [] }),
		parseDash: async () => ({ representations: [], periods: 0 }),
		reference: { durationSec: 6 },
	};
}

describe.each(kinds)("%s segment source origin", (kind) => {
	it.each(
		cases,
	)("verifies Live source names (template=$template, empty=$emptyTemplate, token=$token)", async ({
		template,
		token,
		emptyTemplate,
	}) => {
		const raw = fixture(
			"live",
			kind === "TS" && !template ? "live-akamai-msl-ts" : "live-rtmp-simple",
		);
		const names = naming(kind, template, token, emptyTemplate);
		raw.muxings = raw.muxings.map(
			(muxing: { key: string; streamKey: string; destination: unknown }) => ({
				key: muxing.key,
				streamKey: muxing.streamKey,
				destination: muxing.destination,
				kind,
				segmentLength: 6,
				...names.fields,
			}),
		);
		const plan = liveChannelPlanSchema.parse(raw);
		const expected = compileExpectedLiveArtefacts(plan);
		for (const muxing of expected.muxings) {
			const payload = compileLiveChannel(plan).find(
				(op) => op.step === `muxing:${muxing.muxingKey}`,
			)?.payload;
			expect(payload).toHaveProperty(
				template ? "segmentNamingTemplate" : "segmentNaming",
				muxing.segmentNaming,
			);
			expect(payload).not.toHaveProperty(
				template ? "segmentNaming" : "segmentNamingTemplate",
			);
			expect(muxing.segmentNamingIsTemplate === true).toBe(template);
		}
		const objects = (filename: string) =>
			expected.muxings.flatMap((muxing) => [
				...(kind === "TS"
					? []
					: [{ key: `${muxing.dir.prefix}init.mp4`, size: 1000 }]),
				{ key: `${muxing.dir.prefix}${filename}`, size: 1000 },
			]);
		for (const [filename, verdict] of [
			[names.written, "PASS"],
			[names.wrong, "FAIL"],
		] as const) {
			const report = await verifyLiveChannel(expected, {
				coordinates: { streamKey: "test-stream", encoderIp: "127.0.0.1" },
				fed: true,
				samples: [0, 60000].map((at) => ({
					at,
					status: "RUNNING",
					objects: objects(filename),
				})),
			});
			expect(
				report.checks.find((check) => check.id === "live:segment-naming")
					?.verdict,
			).toBe(verdict);
			if (verdict === "PASS")
				expect(
					report.checks.find((check) => check.id === "live:ladder")?.verdict,
				).toBe("PASS");
		}
	});

	it.each(
		cases.flatMap((entry) =>
			[false, true].map((perTitle) => ({ ...entry, perTitle })),
		),
	)("verifies VOD source names (template=$template, empty=$emptyTemplate, token=$token, perTitle=$perTitle)", async ({
		template,
		token,
		perTitle,
		emptyTemplate,
	}) => {
		const raw = fixture("plan", "fixed-bitrate-hls-on-aws");
		const video = raw.renditions.find(
			(row: { codec: string }) => row.codec === "H264",
		);
		const names = naming(kind, template, token, emptyTemplate);
		raw.renditions = [
			{
				...video,
				height: 360,
				bitrate: perTitle ? null : 400000,
				mode: perTitle ? "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" : "STANDARD",
			},
		];
		raw.muxings = [
			{
				key: "video",
				streamKey: video.key,
				kind,
				segmentLength: 6,
				destination: {
					outputKey: raw.outputs[0].key,
					path: perTitle
						? "out/video/{height}p_{bitrate}_{uuid}/"
						: "out/video/",
				},
				...names.fields,
			},
		];
		raw.manifests = [];
		const plan = encodingPlanSchema.parse(raw);
		const expected = compileExpectedArtefacts(plan);
		const payload = compilePlan(plan).find(
			(op) => op.step === "muxing:video",
		)?.payload;
		expect(payload).toHaveProperty(
			template ? "segmentNamingTemplate" : "segmentNaming",
			expected.muxings[0]?.segmentNaming,
		);
		expect(payload).not.toHaveProperty(
			template ? "segmentNaming" : "segmentNamingTemplate",
		);
		expect(expected.muxings[0]?.segmentNamingIsTemplate === true).toBe(
			template,
		);
		const prefix = perTitle ? "out/video/360p_400000_unit/" : "out/video/";
		for (const [filename, verdict] of [
			[names.written, "PASS"],
			[names.wrong, "FAIL"],
		] as const) {
			const keys = [
				...(kind === "TS" ? [] : [`${prefix}init.mp4`]),
				`${prefix}${filename}`,
			];
			const report = await verifyArtefacts(expected, depsFor(keys));
			const id = `muxing:video:${perTitle ? "360p_400000_unit:" : ""}segments`;
			expect(report.checks.find((check) => check.id === id)?.verdict).toBe(
				verdict,
			);
		}
	});
});

it("keeps a bare random-looking thumbnail token literal", async () => {
	const raw = fixture("plan", "fixed-bitrate-hls-on-aws");
	raw.muxings = raw.muxings.slice(0, 1);
	raw.manifests = [];
	raw.thumbnails = [
		{
			key: "thumb",
			streamKey: raw.renditions[0].key,
			height: 180,
			pattern: "thumb_{rand_chars}_%number%.jpg",
			positions: [1],
			destination: { outputKey: raw.outputs[0].key, path: "out/thumbs/" },
		},
	];
	const expected = compileExpectedArtefacts(encodingPlanSchema.parse(raw));
	for (const [name, verdict] of [
		["thumb_{rand_chars}_1.jpg", "PASS"],
		[`thumb_${"A".repeat(32)}_1.jpg`, "FAIL"],
	] as const) {
		const report = await verifyArtefacts(
			expected,
			depsFor([`out/thumbs/${name}`]),
		);
		expect(
			report.checks.find((check) => check.id === "thumbnails:thumb")?.verdict,
		).toBe(verdict);
	}
});

it("does not expand directory placeholders inside a literal segment filename", async () => {
	const raw = fixture("plan", "fixed-bitrate-hls-on-aws");
	raw.muxings = [
		{ ...raw.muxings[0], segmentNaming: "seg-{uuid}-%number%.m4s" },
	];
	raw.manifests = [];
	const expected = compileExpectedArtefacts(encodingPlanSchema.parse(raw));
	const muxing = expected.muxings[0];
	if (!muxing) throw new Error("Missing fixture muxing");
	for (const [name, verdict] of [
		["seg-{uuid}-1.m4s", "PASS"],
		["seg-expanded-1.m4s", "FAIL"],
	] as const) {
		const report = await verifyArtefacts(
			expected,
			depsFor([`${muxing.dir.prefix}init.mp4`, `${muxing.dir.prefix}${name}`]),
		);
		expect(
			report.checks.find(
				(check) => check.id === `muxing:${muxing.muxingKey}:segments`,
			)?.verdict,
		).toBe(verdict);
	}
});

it("keeps a bare random-looking QC output directory literal", async () => {
	const raw = fixture("plan", "fixed-bitrate-hls-on-aws");
	const video = raw.renditions[0];
	raw.renditions = [
		{ ...video, bitrate: null, mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" },
	];
	raw.muxings = [
		{
			...raw.muxings[0],
			destination: {
				outputKey: raw.outputs[0].key,
				path: "out/{rand_chars}/{height}p_{bitrate}_{uuid}/",
			},
		},
	];
	raw.manifests = [];
	raw.qc = { vmaf: true };
	const expected = compileExpectedArtefacts(encodingPlanSchema.parse(raw));
	const mirror = expected.qc?.mirrors[0];
	if (!mirror) throw new Error("Missing expected QC mirror");
	const variant = "360p_400000_unit";
	for (const [random, verdict] of [
		["{rand_chars}", "PASS"],
		["A".repeat(32), "FAIL"],
	] as const) {
		const resolvedPath = `out/${random}/${variant}/qc/`;
		const report = await verifyArtefacts(expected, {
			...depsFor([`${resolvedPath}${mirror.filename}`]),
			providerOutputIds: { [mirror.outputKey]: "provider-origin" },
			perTitlePopulations: {
				status: "complete",
				results: [{ streamId: "result-stream", templateRendition: video.key }],
				deliveryMuxings: [],
				qc: [
					{
						streamId: "result-stream",
						templateRendition: video.key,
						variant,
						mirrors: [
							{
								streamId: "result-stream",
								templateRendition: video.key,
								muxingId: "qc-result",
								muxingType: "MP4",
								filename: mirror.filename,
								outputId: "provider-origin",
								resolvedPath,
							},
						],
					},
				],
			},
		});
		expect(
			report.checks.find(
				(check) =>
					check.id === `qc:pertitle:unit:${video.key}:result-stream:${variant}`,
			)?.verdict,
		).toBe(verdict);
	}
});
