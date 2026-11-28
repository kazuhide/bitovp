import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

const base = () => loadPlan("mp4-fixed-bitrate-hls-vtt-on-aws");
const destination = { outputKey: "origin", path: "extras/" };
const source = { inputKey: "main", inputPath: "extras/subtitles.scc" };

describe("VOD encoding supplements", () => {
	it("binds independent uploads and stream work to the correct compiled parents", () => {
		const plan = encodingPlanSchema.parse({
			...base(),
			supplements: [
				{
					kind: "SCC_CONVERSION",
					key: "sub",
					...source,
					destination,
					filename: "subs.vtt",
				},
				{
					kind: "BIF",
					key: "thumbs",
					renditionKey: "v540",
					destination,
					filename: "thumbs.bif",
					distance: 10,
					width: 320,
				},
				{ kind: "PSNR", key: "qc", renditionKey: "v540" },
			],
		});
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(() => planToEncodingTemplateYaml(plan)).toThrow(/Plan JSON/);
		const steps = compilePlan(plan);
		expect(steps.find((step) => step.step === "supplement:sub")).toMatchObject({
			kind: "CREATE_ENCODING_SUPPLEMENT",
			refs: {
				encodingId: "encoding",
				inputId: "input:main",
				outputId: "output:origin",
			},
			payload: {
				supplement: {
					kind: "SCC_CONVERSION",
					filename: "subs.vtt",
					inputPath: source.inputPath,
				},
			},
		});
		for (const key of ["thumbs", "qc"]) {
			const index = steps.findIndex(
				(step) => step.step === `supplement:${key}`,
			);
			expect(index).toBeGreaterThan(
				steps.findIndex((step) => step.step === "stream:v540"),
			);
			expect(index).toBeLessThan(
				steps.findIndex((step) => step.kind === "START_ENCODING"),
			);
			expect(steps[index]?.refs).toMatchObject({
				encodingId: "encoding",
				streamId: "stream:v540",
			});
		}
	});

	it("reports dangling references, duplicate singleton measurement, and files already written", () => {
		const plan = base();
		const file = plan.muxings.find((muxing) => muxing.kind === "MP4");
		if (file?.kind !== "MP4" || !file.destination)
			throw new Error("Expected an MP4 fixture");
		const modified = encodingPlanSchema.parse({
			...plan,
			supplements: [
				{
					kind: "SCC_CONVERSION",
					key: "sub",
					...source,
					destination: file.destination,
					filename: file.filename,
				},
				{ kind: "PSNR", key: "qc", renditionKey: "v540" },
				{ kind: "PSNR", key: "qc2", renditionKey: "v540" },
				{
					kind: "CEA_SCC",
					key: "bad",
					...source,
					inputKey: "missing",
					renditionKey: "a64",
				},
			],
		});
		expect(validatePlan(modified).map((issue) => issue.code)).toEqual(
			expect.arrayContaining([
				"PLAN_SUPPLEMENT_OUTPUT_COLLISION",
				"PLAN_SUPPLEMENT_DUPLICATE",
				"PLAN_SUPPLEMENT_INPUT",
				"PLAN_SUPPLEMENT_VIDEO",
			]),
		);
	});

	it("binds DVB burn-in to subtitle-relative ingest and keeps supplement destinations distinct", () => {
		const plan = encodingPlanSchema.parse({
			...base(),
			deliveryMirrors: [{ outputKey: "origin" }],
			supplements: [
				{
					kind: "BURN_IN_DVBSUB",
					key: "subtitle",
					renditionKey: "v540",
					ingestKey: "video",
				},
				{
					kind: "SCC_CONVERSION",
					key: "convert",
					...source,
					destination,
					filename: "captions.vtt",
				},
			],
		});
		expect(validatePlan(plan).map((issue) => issue.code)).toEqual(
			expect.arrayContaining([
				"PLAN_SUPPLEMENT_INGEST",
				"PLAN_SUPPLEMENT_DESTINATION_MIRROR",
			]),
		);
	});

	it("requires a BIF size and strict object paths", () => {
		for (const supplement of [
			{
				kind: "BIF",
				key: "no-size",
				renditionKey: "v540",
				destination,
				filename: "thumbs.bif",
				distance: 10,
			},
			{
				kind: "SIDECAR",
				key: "outside",
				inputKey: "main",
				inputPath: "https://example.test/input.vtt",
				destination,
			},
		]) {
			expect(
				encodingPlanSchema.safeParse({ ...base(), supplements: [supplement] })
					.success,
			).toBe(false);
		}
	});
});
