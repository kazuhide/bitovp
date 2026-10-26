import type { LiveChannelPlan } from "@bitovp/core";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkLiveCaptureReadiness } from "./live-capture-readiness";

const now = Date.parse("2026-09-09T01:00:00Z");
const createdAt = new Date(now - 60_000);
const plan = {
	outputs: [{ key: "out", kind: "S3", credentialId: "cred", bucket: "bucket" }],
	renditions: ["v720", "v360"].map((key) => ({
		key,
		codec: "H264",
		height: 720,
	})),
	muxings: ["v720", "v360"].map((key) => ({
		key,
		streamKey: key,
		kind: "TS",
		segmentNaming: "segment_%number%.ts",
		segmentLength: 6,
		destination: { outputKey: "out", path: `run2/${key}` },
	})),
} as LiveChannelPlan;

const object = (key: string, at = now - 10_000) => ({
	key,
	size: 188,
	lastModified: new Date(at).toISOString(),
});
function browser(
	list: ObjectStorageBrowser["listObjects"] = vi.fn(
		async ({ prefix }: { prefix?: string }) => ({
			objects: [object(`${prefix}segment_1.ts`)],
			prefixes: [],
		}),
	),
) {
	return {
		listObjects: list,
		getObject: vi.fn(),
		dispose: vi.fn(),
	} as unknown as ObjectStorageBrowser;
}
afterEach(() => vi.useRealTimers());

describe("Live capture readiness at the request boundary", () => {
	it.each([
		"/",
		"/custom/media/",
	])("reads storage keys relative to output root for %s", async (path) => {
		const rooted = structuredClone(plan);
		rooted.renditions = rooted.renditions.slice(0, 1);
		rooted.muxings = rooted.muxings.slice(0, 1);
		const muxing = rooted.muxings[0];
		if (!muxing?.destination) throw new Error("missing muxing");
		muxing.destination.path = path;
		const prefix = path === "/" ? "" : "custom/media/";
		const driver = browser(
			vi.fn(async () => ({
				objects: [object(`${prefix}segment_17.ts`)],
				prefixes: [],
			})),
		);
		expect(
			(
				await checkLiveCaptureReadiness(
					rooted,
					createdAt,
					async () => driver,
					() => now,
				)
			).kind,
		).toBe("ready");
		expect(driver.listObjects).toHaveBeenCalledWith(
			expect.objectContaining({ prefix }),
		);
	});
	it.each([
		["{rand_chars:8}", "Ab12Cd34"],
		["{segment_rand_chars:8}", "98765432"],
		["{rand_chars}", "A".repeat(32)],
		["{segment_rand_chars}", "9".repeat(32)],
	])("recognises expanded %s before the numeric segment index", async (token, random) => {
		const templated = structuredClone(plan);
		for (const muxing of templated.muxings) {
			if (muxing.kind !== "MP4")
				muxing.segmentNamingTemplate = `v.part+${token}_%number%.mp4`;
		}
		const result = await checkLiveCaptureReadiness(
			templated,
			createdAt,
			async () =>
				browser(
					vi.fn(async ({ prefix }) => ({
						objects: [object(`${prefix}v.part+${random}_17.mp4`)],
						prefixes: [],
					})),
				),
			() => now,
		);
		expect(result).toMatchObject({ kind: "ready", ready: 2, total: 2 });
	});
	it.each([
		"v.part+Ab12Cd3_17.mp4",
		"v.part+Ab12Cd345_17.mp4",
		"v.part+Ab12C-34_17.mp4",
		"vXpart+Ab12Cd34_17Xmp4",
		"v.part+Ab12Cd34_latest.mp4",
		"v.part+Ab12Cd34_9007199254740992.mp4",
		"v.part+{rand_chars:8}_17.mp4",
	])("does not admit an invalid expanded template object: %s", async (name) => {
		const templated = structuredClone(plan);
		for (const muxing of templated.muxings) {
			if (muxing.kind !== "MP4")
				muxing.segmentNamingTemplate = "v.part+{rand_chars:8}_%number%.mp4";
		}
		expect(
			await checkLiveCaptureReadiness(
				templated,
				createdAt,
				async () =>
					browser(
						vi.fn(async ({ prefix }) => ({
							objects: [object(`${prefix}${name}`)],
							prefixes: [],
						})),
					),
				() => now,
			),
		).toMatchObject({ kind: "awaiting", ready: 0, total: 2 });
	});
	it("keeps random-looking tokens literal when declared in segmentNaming", async () => {
		const literal = structuredClone(plan);
		for (const muxing of literal.muxings) {
			if (muxing.kind !== "MP4")
				muxing.segmentNaming = "seg-{rand_chars:8}-%number%.ts";
		}
		for (const [name, kind] of [
			["seg-{rand_chars:8}-17.ts", "ready"],
			["seg-Ab12Cd34-17.ts", "awaiting"],
		] as const) {
			expect(
				(
					await checkLiveCaptureReadiness(
						literal,
						createdAt,
						async () =>
							browser(
								vi.fn(async ({ prefix }) => ({
									objects: [object(`${prefix}${name}`)],
									prefixes: [],
								})),
							),
						() => now,
					)
				).kind,
			).toBe(kind);
		}
	});
	it("requires a fresh CMAF init segment and media segment before capture is ready", async () => {
		const cmaf = structuredClone(plan);
		cmaf.muxings = cmaf.muxings.map((muxing) => ({
			key: muxing.key,
			streamKey: muxing.streamKey,
			destination: muxing.destination,
			kind: "CMAF",
			segmentLength: 6,
			segmentNaming: "segment_%number%.m4s",
			initSegmentName: "init.mp4",
		}));
		for (const hasInit of [false, true]) {
			const resolve = vi.fn(async () =>
				browser(
					vi.fn(async ({ prefix }) => ({
						objects: [
							object(`${prefix}segment_1.m4s`),
							...(hasInit ? [object(`${prefix}init.mp4`)] : []),
						],
						prefixes: [],
					})),
				),
			);
			const result = await checkLiveCaptureReadiness(
				cmaf,
				createdAt,
				resolve,
				() => now,
			);
			expect(result.kind).toBe(hasInit ? "ready" : "awaiting");
		}
	});
	it.each([
		false,
		true,
	])("requires one fresh expanded CMAF init across all listing pages (ambiguous=%s)", async (ambiguous) => {
		const cmaf = structuredClone(plan);
		cmaf.muxings = cmaf.muxings.map((muxing) => ({
			key: muxing.key,
			streamKey: muxing.streamKey,
			destination: muxing.destination,
			kind: "CMAF",
			segmentLength: 6,
			segmentNaming: "segment_%number%.m4s",
			initSegmentName: "init.mp4",
			initSegmentNameTemplate: "init-{rand_chars}.mp4",
		}));
		const result = await checkLiveCaptureReadiness(
			cmaf,
			createdAt,
			async () =>
				browser(
					vi.fn(async ({ prefix, cursor }) => ({
						objects: cursor
							? ambiguous
								? [object(`${prefix}init-${"B".repeat(32)}.mp4`)]
								: []
							: [
									object(`${prefix}segment_17.m4s`),
									// This materialized literal default does not select the init object.
									object(`${prefix}init.mp4`),
									object(`${prefix}init-${"A".repeat(32)}.mp4`),
								],
						prefixes: [],
						...(cursor ? {} : { nextCursor: "more" }),
					})),
				),
			() => now,
		);
		expect(result.kind).toBe(ambiguous ? "unobservable" : "ready");
	});
	it.each([
		1, 2,
	])("requires an unambiguous storage mirror (%i candidates)", async (count) => {
		const mirrored = structuredClone(plan);
		mirrored.outputs = [
			{
				key: "out",
				name: "MSL primary",
				kind: "AKAMAI_MSL",
				credentialId: "msl",
				streamFormat: "HLS",
				mslVersion: "MSL4",
			},
		];
		mirrored.deliveryMirrors = [];
		for (let i = 0; i < count; i++) {
			mirrored.outputs.push({
				key: `storage-${i}`,
				name: `Storage mirror ${i}`,
				kind: "GENERIC_S3",
				credentialId: `cred-${i}`,
				bucket: `bucket-${i}`,
			});
			mirrored.deliveryMirrors.push({ outputKey: `storage-${i}` });
		}
		const resolve = vi.fn(async (_credentialId: string) => browser());
		const result = await checkLiveCaptureReadiness(
			mirrored,
			createdAt,
			resolve,
			() => now,
		);
		expect(result.kind).toBe(count === 1 ? "ready" : "unobservable");
		if (count === 1)
			expect(resolve.mock.calls.map(([id]) => id)).toEqual([
				"cred-0",
				"cred-0",
			]);
		else expect(resolve).not.toHaveBeenCalled();
	});
	it("does not turn a mirrored MSL5 dollar-token name into observable segments", async () => {
		const mirrored = structuredClone(plan);
		mirrored.outputs.push({
			key: "msl",
			name: "MSL5 primary",
			kind: "AKAMAI_MSL",
			credentialId: "msl",
			streamFormat: "HLS",
			mslVersion: "MSL5",
		});
		mirrored.deliveryMirrors = [{ outputKey: "out" }];
		for (const muxing of mirrored.muxings) {
			if (muxing.kind === "MP4" || !muxing.destination) continue;
			muxing.destination.outputKey = "msl";
			muxing.segmentNaming = "$RepresentationID$_$Number$.ts";
		}
		const resolve = vi.fn(async (_credentialId: string) => browser());
		expect(
			(await checkLiveCaptureReadiness(mirrored, createdAt, resolve, () => now))
				.kind,
		).toBe("unobservable");
		expect(resolve).not.toHaveBeenCalled();
	});
	it("rejects sequence numbers the capture worker cannot parse", async () => {
		const driver = browser(
			vi.fn(async ({ prefix }) => ({
				prefixes: [],
				objects: [object(`${prefix}segment_${"9".repeat(400)}.ts`)],
			})),
		);
		expect(
			(
				await checkLiveCaptureReadiness(
					plan,
					createdAt,
					async () => driver,
					() => now,
				)
			).kind,
		).toBe("awaiting");
	});
	it("resolves Azure containers through the same locator as the capture worker", async () => {
		const driver = browser();
		const azure = {
			...plan,
			outputs: [
				{
					key: "out",
					kind: "AZURE",
					credentialId: "cred",
					container: "azure-container",
				},
			],
		} as LiveChannelPlan;
		expect(
			(
				await checkLiveCaptureReadiness(
					azure,
					createdAt,
					async () => driver,
					() => now,
				)
			).kind,
		).toBe("ready");
		expect(driver.listObjects).toHaveBeenCalledWith(
			expect.objectContaining({ bucket: "azure-container" }),
		);
	});
	it("caps targets before opening clients", async () => {
		const resolve = vi.fn();
		const huge = {
			...plan,
			renditions: Array.from({ length: 17 }, () => plan.renditions[0]),
			muxings: plan.muxings,
		} as LiveChannelPlan;
		expect(
			(await checkLiveCaptureReadiness(huge, createdAt, resolve, () => now))
				.kind,
		).toBe("unobservable");
		expect(resolve).not.toHaveBeenCalled();
	});
	it("never accepts a late read and never starts more reads after the deadline", async () => {
		let clock = now;
		const list = vi.fn(async ({ prefix }: { prefix?: string }) => {
			clock += 15_001;
			return {
				prefixes: [],
				objects: [object(`${prefix}segment_1.ts`)],
				nextCursor: "more",
			};
		});
		const result = await checkLiveCaptureReadiness(
			plan,
			createdAt,
			async () => browser(list),
			() => clock,
		);
		expect(result.kind).toBe("unobservable");
		expect(list).toHaveBeenCalledTimes(1);
	});
	it("bounds pagination and rejects a repeated cursor", async () => {
		let page = 0;
		const list = vi.fn(async () => ({
			prefixes: [],
			objects: [],
			nextCursor: `page${page++}`,
		}));
		expect(
			(
				await checkLiveCaptureReadiness(
					plan,
					createdAt,
					async () => browser(list),
					() => now,
				)
			).kind,
		).toBe("unobservable");
		expect(list).toHaveBeenCalledTimes(20);
		list.mockClear().mockImplementation(async () => ({
			prefixes: [],
			objects: [],
			nextCursor: "same",
		}));
		expect(
			(
				await checkLiveCaptureReadiness(
					plan,
					createdAt,
					async () => browser(list),
					() => now,
				)
			).kind,
		).toBe("unobservable");
		expect(list).toHaveBeenCalledTimes(4);
	});
	it("keeps at most two target reads in flight and awaits every one", async () => {
		let active = 0;
		let maximum = 0;
		const list = vi.fn(async ({ prefix }: { prefix?: string }) => {
			active++;
			maximum = Math.max(maximum, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return { prefixes: [], objects: [object(`${prefix}segment_1.ts`)] };
		});
		expect(
			(
				await checkLiveCaptureReadiness(
					plan,
					createdAt,
					async () => browser(list),
					() => now,
				)
			).kind,
		).toBe("ready");
		expect(maximum).toBe(2);
		expect(active).toBe(0);
	});
	it("requires current-run nonempty segments from every exact target; monitoring publish is irrelevant", async () => {
		const driver = browser();
		const result = await checkLiveCaptureReadiness(
			plan,
			createdAt,
			async () => driver,
			() => now,
		);
		expect(result).toMatchObject({ kind: "ready", ready: 2, total: 2 });
		expect(driver.listObjects).toHaveBeenCalledWith(
			expect.objectContaining({
				prefix: "run2/v720/",
				recursive: true,
				limit: 100,
			}),
		);
		expect(driver.dispose).toHaveBeenCalled();
	});

	it("does not admit partial renditions or old same-prefix leftovers", async () => {
		const driver = browser(
			vi.fn(async ({ prefix }) => ({
				prefixes: [],
				objects: [
					object(
						`${prefix}segment_1.ts`,
						prefix?.includes("v360") ? now - 120_000 : now - 10_000,
					),
				],
			})),
		);
		expect(
			await checkLiveCaptureReadiness(
				plan,
				createdAt,
				async () => driver,
				() => now,
			),
		).toMatchObject({ kind: "awaiting", ready: 1, total: 2 });
	});

	it.each([
		undefined,
		"invalid",
		new Date(now + 1).toISOString(),
	])("refuses unknown or future object timestamps: %s", async (lastModified) => {
		const driver = browser(
			vi.fn(async ({ prefix }) => ({
				prefixes: [],
				objects: [{ key: `${prefix}segment_1.ts`, size: 188, lastModified }],
			})),
		);
		expect(
			(
				await checkLiveCaptureReadiness(
					plan,
					createdAt,
					async () => driver,
					() => now,
				)
			).kind,
		).toBe("unobservable");
	});

	it("does not accept sibling prefixes, foreign filenames or zero-byte objects", async () => {
		const driver = browser(
			vi.fn(async ({ prefix }) => ({
				prefixes: [],
				objects: [
					object(`${prefix?.slice(0, -1)}-foreign/segment_1.ts`),
					object(`${prefix}notes.ts`),
					{ ...object(`${prefix}segment_2.ts`), size: 0 },
				],
			})),
		);
		expect(
			(
				await checkLiveCaptureReadiness(
					plan,
					createdAt,
					async () => driver,
					() => now,
				)
			).kind,
		).toBe("awaiting");
	});

	it("DASH/fMP4 works without HLS but also needs a current nonempty init", async () => {
		const fmp4 = {
			...plan,
			muxings: plan.muxings.map((mux) => ({
				...mux,
				kind: "FMP4",
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
			})),
		} as LiveChannelPlan;
		const withoutInit = browser(
			vi.fn(async ({ prefix }) => ({
				prefixes: [],
				objects: [object(`${prefix}segment_1.m4s`)],
			})),
		);
		expect(
			(
				await checkLiveCaptureReadiness(
					fmp4,
					createdAt,
					async () => withoutInit,
					() => now,
				)
			).kind,
		).toBe("awaiting");
		const withInit = browser(
			vi.fn(async ({ prefix }) => ({
				prefixes: [],
				objects: [
					object(`${prefix}init.mp4`),
					object(`${prefix}segment_1.m4s`),
				],
			})),
		);
		expect(
			(
				await checkLiveCaptureReadiness(
					fmp4,
					createdAt,
					async () => withInit,
					() => now,
				)
			).kind,
		).toBe("ready");
	});

	it("missing driver or failed storage read is actionable unobservable, never a job-ready fallback", async () => {
		expect(
			(
				await checkLiveCaptureReadiness(
					plan,
					createdAt,
					async () => null,
					() => now,
				)
			).kind,
		).toBe("unobservable");
		const driver = browser(
			vi.fn(async () => {
				throw new Error("secret upstream URL");
			}),
		);
		const result = await checkLiveCaptureReadiness(
			plan,
			createdAt,
			async () => driver,
			() => now,
		);
		expect(result.kind).toBe("unobservable");
		expect(JSON.stringify(result)).not.toContain("secret");
	});
});
