import { readFileSync } from "node:fs";
import type {
	ExpectedArtefacts,
	PerTitleActualPopulations,
	PooledMetrics,
} from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import type { VerificationReport } from "./engine";
import { ReportBuilder } from "./engine";
import type { AutoVmafRow } from "./job";
import { addQcMeasurementChecks, readAutoVmaf } from "./job";

/**
 * the verifier proved every QC mirror EXISTED
 * and never asked whether anything scored it. The paid runner carried zero references to
 * `VmafJob`; a plan whose measurement ERRORed, never ran, or produced 0 results passed
 * with `qc:mirror:*` green — the Live A/E and per-title shapes the audit measured.
 *
 * Each arm plants one of those shapes against a healthy control and names the check that
 * must FAIL. The rule is pure; the wiring into `verifyJob` is pinned by shape at the
 * bottom, which is the only pin its dependencies (database, credentials, bucket) allow.
 */

const pooled = (mean: number, psnr?: number): PooledMetrics =>
	({
		mean,
		harmonicMean: mean - 1,
		min: mean - 10,
		max: 99,
		percentiles: { p1: 70, p5: 75, p10: 78, p25: 82, p50: 88 },
		low1Percent: 69,
		worstFrame: { frameNum: 12, vmaf: mean - 10 },
		...(psnr !== undefined ? { psnr: { mean: psnr, min: 30, max: 50 } } : {}),
	}) as PooledMetrics;

const result = (
	renditionKey: string,
	mean = 90,
	extra: Record<string, unknown> = {},
) => ({
	renditionRef: { renditionKey, ...extra },
	pooled: pooled(mean, 40),
	provenance: null,
});

const exactPerTitleResult = (
	renditionKey: string,
	variant: string,
	providerResult?: {
		streamId: string;
		muxingId: string;
		outputId: string;
		resolvedPath: string;
	},
) => ({
	...result(renditionKey, 90, { perTitleVariant: variant }),
	...(providerResult !== undefined ? { provenance: { providerResult } } : {}),
});

type Row = NonNullable<AutoVmafRow>;

const finished = (results: Row["results"]): Row => ({
	status: "FINISHED",
	error: null,
	model: "vmaf_v0.6.1",
	gateVerdict: null,
	results,
});

const expectedFor = (
	keys: string[],
	options: { perTitle?: string[]; model?: string; psnr?: boolean } = {},
): Pick<ExpectedArtefacts, "qc" | "muxings"> => ({
	muxings: keys.map((key) => ({
		renditionKey: key,
		perTitle: options.perTitle?.includes(key) ?? false,
	})) as never,
	qc: {
		vmaf: true,
		psnr: options.psnr ?? false,
		...(options.model ? { model: options.model } : {}),
		mirrorRenditionKeys: keys,
		mirrorDirSuffix: "qc/",
		mirrors: keys.map((key) => ({
			renditionKey: key,
			outputKey: "out",
			dir: { pattern: "video/", prefix: "video/" } as never,
			filename: `${key}.mp4`,
		})),
	},
});

const finishedJob = { status: "FINISHED", qcOverriddenAt: null };

function run(
	found: Parameters<typeof addQcMeasurementChecks>[1],
): VerificationReport {
	const builder = new ReportBuilder();
	const report = builder.build("qc-join");
	addQcMeasurementChecks(report, found);
	return report;
}

const verdictOf = (report: VerificationReport, id: string) =>
	report.checks.find((c) => c.id === id)?.verdict;

describe("addQcMeasurementChecks — the healthy control", () => {
	it("PASSes measurement, results and scores for an exact population", () => {
		const report = run({
			expected: expectedFor(["v720", "v360"]),
			gate: undefined,
			job: finishedJob,
			vmaf: finished([result("v720"), result("v360")]),
		});
		expect(report.checks.map((c) => [c.id, c.verdict])).toEqual([
			["qc:measurement", "PASS"],
			["qc:results", "PASS"],
			["qc:scores", "PASS"],
		]);
		expect(report.counts.FAIL).toBe(0);
	});

	it("appends nothing when the plan asked for no QC", () => {
		const report = run({
			expected: { muxings: [], qc: undefined },
			gate: undefined,
			job: finishedJob,
			vmaf: null,
		});
		expect(report.checks).toEqual([]);
	});
});

describe("addQcMeasurementChecks — the shapes the audit measured", () => {
	it("FAILs when no AUTO row exists — the mirrors were billed and nothing scored them", () => {
		const report = run({
			expected: expectedFor(["v720"]),
			gate: undefined,
			job: finishedJob,
			vmaf: null,
		});
		expect(verdictOf(report, "qc:measurement")).toBe("FAIL");
		expect(report.checks).toHaveLength(1);
	});

	it("FAILs an ERROR measurement and carries its error text", () => {
		const report = run({
			expected: expectedFor(["v720"]),
			gate: undefined,
			job: finishedJob,
			vmaf: {
				...finished([]),
				status: "ERROR",
				error: "mirror v720.mp4 absent",
			},
		});
		const check = report.checks.find((c) => c.id === "qc:measurement");
		expect(check?.verdict).toBe("FAIL");
		expect(check?.detail).toContain("mirror v720.mp4 absent");
	});

	it("FAILs a measurement that is still RUNNING at verify time", () => {
		const report = run({
			expected: expectedFor(["v720"]),
			gate: undefined,
			job: finishedJob,
			vmaf: { ...finished([]), status: "RUNNING" },
		});
		expect(verdictOf(report, "qc:measurement")).toBe("FAIL");
		expect(verdictOf(report, "qc:results")).toBeUndefined();
	});

	it("FAILs a FINISHED row with zero results (Live A/E: every media probed, results 0)", () => {
		const report = run({
			expected: expectedFor(["v720", "v360"]),
			gate: undefined,
			job: finishedJob,
			vmaf: finished([]),
		});
		expect(verdictOf(report, "qc:measurement")).toBe("PASS");
		const check = report.checks.find((c) => c.id === "qc:results");
		expect(check?.verdict).toBe("FAIL");
		expect(check?.detail).toContain("unmeasured: v720, v360");
	});

	it("FAILs a short population — one rendition never scored", () => {
		const report = run({
			expected: expectedFor(["v720", "v360"]),
			gate: undefined,
			job: finishedJob,
			vmaf: finished([result("v720")]),
		});
		expect(verdictOf(report, "qc:results")).toBe("FAIL");
	});

	it("FAILs an extra result the plan never asked for, and a duplicate", () => {
		const extra = run({
			expected: expectedFor(["v720"]),
			gate: undefined,
			job: finishedJob,
			vmaf: finished([result("v720"), result("v1080")]),
		});
		expect(extra.checks.find((c) => c.id === "qc:results")?.detail).toContain(
			"not in the plan: v1080",
		);
		const dup = run({
			expected: expectedFor(["v720"]),
			gate: undefined,
			job: finishedJob,
			vmaf: finished([result("v720"), result("v720")]),
		});
		expect(dup.checks.find((c) => c.id === "qc:results")?.detail).toContain(
			"measured more than once: v720",
		);
	});

	it("does not PASS per-title rung counts without an exact provider population", () => {
		const ok = run({
			expected: expectedFor(["pt"], { perTitle: ["pt"] }),
			gate: undefined,
			job: finishedJob,
			vmaf: finished([
				result("pt", 90, { perTitleVariant: "1080_4000_a" }),
				result("pt", 85, { perTitleVariant: "720_2000_b" }),
			]),
		});
		expect(verdictOf(ok, "qc:results")).toBe("SKIP");
		expect(ok.checks.find((c) => c.id === "qc:results")?.detail).toContain(
			"UNVERIFIED per-title QC population",
		);
		const none = run({
			expected: expectedFor(["pt"], { perTitle: ["pt"] }),
			gate: undefined,
			job: finishedJob,
			vmaf: finished([]),
		});
		expect(verdictOf(none, "qc:results")).toBe("FAIL");
	});

	it("requires exact per-title RESULT variants when a complete provider population is available", () => {
		const population: PerTitleActualPopulations = {
			status: "complete",
			results: [
				{ streamId: "s-a", templateRendition: "pt" },
				{ streamId: "s-b", templateRendition: "pt" },
			],
			qc: [
				{
					streamId: "s-a",
					templateRendition: "pt",
					variant: "360p_400000_a",
					mirrors: [
						{
							streamId: "s-a",
							templateRendition: "pt",
							muxingId: "m-a",
							muxingType: "MP4",
							filename: "pt.mp4",
							outputId: "o-a",
							resolvedPath: "out/360p_400000_a/qc/",
						},
					],
				},
				{
					streamId: "s-b",
					templateRendition: "pt",
					variant: "720p_1800000_b",
					mirrors: [
						{
							streamId: "s-b",
							templateRendition: "pt",
							muxingId: "m-b",
							muxingType: "MP4",
							filename: "pt.mp4",
							outputId: "o-b",
							resolvedPath: "out/720p_1800000_b/qc/",
						},
					],
				},
			],
			deliveryMuxings: [],
		};
		const exact = run({
			expected: expectedFor(["pt"], { perTitle: ["pt"] }),
			gate: undefined,
			job: finishedJob,
			perTitlePopulations: population,
			vmaf: finished([
				exactPerTitleResult("pt", "360p_400000_a", {
					streamId: "s-a",
					muxingId: "m-a",
					outputId: "o-a",
					resolvedPath: "out/360p_400000_a/qc/",
				}),
				exactPerTitleResult("pt", "720p_1800000_b", {
					streamId: "s-b",
					muxingId: "m-b",
					outputId: "o-b",
					resolvedPath: "out/720p_1800000_b/qc/",
				}),
			]),
		});
		expect(verdictOf(exact, "qc:results")).toBe("PASS");

		const wrong = run({
			expected: expectedFor(["pt"], { perTitle: ["pt"] }),
			gate: undefined,
			job: finishedJob,
			perTitlePopulations: population,
			vmaf: finished([
				result("pt", 90, { perTitleVariant: "360p_400000_a" }),
				result("pt", 85, { perTitleVariant: "1080p_wrong" }),
			]),
		});
		expect(verdictOf(wrong, "qc:results")).toBe("FAIL");
		expect(wrong.checks.find((c) => c.id === "qc:results")?.detail).toMatch(
			/unmeasured.*720p_1800000_b.*not in.*1080p_wrong/,
		);

		const duplicated = run({
			expected: expectedFor(["pt"], { perTitle: ["pt"] }),
			gate: undefined,
			job: finishedJob,
			perTitlePopulations: population,
			vmaf: finished([
				result("pt", 90, { perTitleVariant: "360p_400000_a" }),
				result("pt", 85, { perTitleVariant: "360p_400000_a" }),
			]),
		});
		expect(verdictOf(duplicated, "qc:results")).toBe("FAIL");
		expect(
			duplicated.checks.find((c) => c.id === "qc:results")?.detail,
		).toContain("measured more than once: pt:360p_400000_a");
	});

	it("FAILs a correctly labelled per-title VMAF row when exact provider provenance is missing", () => {
		const population: PerTitleActualPopulations = {
			status: "complete",
			results: [{ streamId: "s-720", templateRendition: "pt" }],
			qc: [
				{
					streamId: "s-720",
					templateRendition: "pt",
					variant: "720p_1800000_a",
					mirrors: [
						{
							streamId: "s-720",
							templateRendition: "pt",
							muxingId: "m-720",
							muxingType: "MP4",
							filename: "pt.mp4",
							outputId: "o-720",
							resolvedPath: "out/720p_1800000_a/qc/",
						},
					],
				},
			],
			deliveryMuxings: [],
		};
		const report = run({
			expected: expectedFor(["pt"], { perTitle: ["pt"] }),
			gate: undefined,
			job: finishedJob,
			perTitlePopulations: population,
			vmaf: finished([exactPerTitleResult("pt", "720p_1800000_a")]),
		});

		expect(verdictOf(report, "qc:results")).toBe("FAIL");
		expect(report.checks.find((c) => c.id === "qc:results")?.detail).toMatch(
			/missing exact provider RESULT provenance/i,
		);
	});

	it.each([
		"streamId",
		"muxingId",
		"outputId",
		"resolvedPath",
	] as const)("FAILs a correctly labelled per-title VMAF row when provider provenance has the wrong %s", (field) => {
		const expectedProviderResult = {
			streamId: "s-720",
			muxingId: "m-720",
			outputId: "o-720",
			resolvedPath: "out/720p_1800000_a/qc/",
		};
		const population: PerTitleActualPopulations = {
			status: "complete",
			results: [{ streamId: "s-720", templateRendition: "pt" }],
			qc: [
				{
					streamId: "s-720",
					templateRendition: "pt",
					variant: "720p_1800000_a",
					mirrors: [
						{
							...expectedProviderResult,
							templateRendition: "pt",
							muxingType: "MP4",
							filename: "pt.mp4",
						},
					],
				},
			],
			deliveryMuxings: [],
		};
		const report = run({
			expected: expectedFor(["pt"], { perTitle: ["pt"] }),
			gate: undefined,
			job: finishedJob,
			perTitlePopulations: population,
			vmaf: finished([
				exactPerTitleResult("pt", "720p_1800000_a", {
					...expectedProviderResult,
					[field]: `wrong-${field}`,
				}),
			]),
		});

		expect(verdictOf(report, "qc:results")).toBe("FAIL");
		expect(report.checks.find((c) => c.id === "qc:results")?.detail).toMatch(
			/does not match its provider QC mirror/i,
		);
	});

	it("FAILs exact VMAF closure when only the attributed subset was scored", () => {
		const population: PerTitleActualPopulations = {
			status: "complete",
			results: [
				{ streamId: "s-fixed", templateRendition: "fixed" },
				{ streamId: "s-flexible" },
			],
			qc: [
				{
					streamId: "s-fixed",
					templateRendition: "fixed",
					variant: "360p_400000_fixed",
					mirrors: [],
				},
				{
					streamId: "s-flexible",
					variant: "1080p_4000000_flexible",
					mirrors: [],
				},
			],
			deliveryMuxings: [],
		};
		const report = run({
			expected: expectedFor(["fixed", "flexible"], {
				perTitle: ["fixed", "flexible"],
			}),
			gate: undefined,
			job: finishedJob,
			perTitlePopulations: population,
			vmaf: finished([
				result("fixed", 90, { perTitleVariant: "360p_400000_fixed" }),
			]),
		});

		expect(verdictOf(report, "qc:results")).toBe("FAIL");
		expect(report.checks.find((c) => c.id === "qc:results")?.detail).toMatch(
			/unattributed.*s-flexible/i,
		);
	});

	it("FAILs an empty exact per-title RESULT/QC population instead of passing 0/0", () => {
		const report = run({
			expected: expectedFor(["flexible"], { perTitle: ["flexible"] }),
			gate: undefined,
			job: finishedJob,
			perTitlePopulations: {
				status: "complete",
				results: [],
				qc: [],
				deliveryMuxings: [],
			},
			vmaf: finished([]),
		});

		expect(verdictOf(report, "qc:results")).toBe("FAIL");
		expect(report.checks.find((c) => c.id === "qc:results")?.detail).toMatch(
			/empty.*RESULT/i,
		);
	});

	it("marks an incomplete per-title population UNVERIFIED rather than accepting a rendition-only count", () => {
		const report = run({
			expected: expectedFor(["pt"], { perTitle: ["pt"] }),
			gate: undefined,
			job: finishedJob,
			perTitlePopulations: {
				status: "incomplete",
				reason: "legacy snapshot",
			},
			vmaf: finished([result("pt", 90, { perTitleVariant: "360p_400000_a" })]),
		});
		expect(report.checks.find((c) => c.id === "qc:results")).toMatchObject({
			verdict: "SKIP",
			detail: expect.stringMatching(/UNVERIFIED.*legacy snapshot/),
		});
	});

	it("FAILs scores when a result carries no finite VMAF mean", () => {
		const report = run({
			expected: expectedFor(["v720"]),
			gate: undefined,
			job: finishedJob,
			vmaf: finished([
				{
					renditionRef: { renditionKey: "v720" },
					pooled: { mean: Number.NaN },
					provenance: null,
				},
			]),
		});
		expect(verdictOf(report, "qc:scores")).toBe("FAIL");
	});

	it("demands a PSNR mean only when the plan asked for PSNR", () => {
		const row = {
			renditionRef: { renditionKey: "v720" },
			pooled: pooled(90),
			provenance: null,
		};
		const without = run({
			expected: expectedFor(["v720"]),
			gate: undefined,
			job: finishedJob,
			vmaf: finished([row]),
		});
		expect(verdictOf(without, "qc:scores")).toBe("PASS");
		const withPsnr = run({
			expected: expectedFor(["v720"], { psnr: true }),
			gate: undefined,
			job: finishedJob,
			vmaf: finished([row]),
		});
		expect(verdictOf(withPsnr, "qc:scores")).toBe("FAIL");
	});

	it("checks the model only when the plan pinned one", () => {
		const unpinned = run({
			expected: expectedFor(["v720"]),
			gate: undefined,
			job: finishedJob,
			vmaf: finished([result("v720")]),
		});
		expect(verdictOf(unpinned, "qc:model")).toBeUndefined();
		const wrong = run({
			expected: expectedFor(["v720"], { model: "vmaf_v1.0.16_3d0h" }),
			gate: undefined,
			job: finishedJob,
			vmaf: finished([result("v720")]),
		});
		expect(verdictOf(wrong, "qc:model")).toBe("FAIL");
	});
});

describe("addQcMeasurementChecks — the gate", () => {
	const gate = { rules: [{ metric: "VMAF_MEAN", gte: 80, scope: "OVERALL" }] };
	const failedVerdict = { pass: false, ruleResults: [{ pass: false }] };

	it("FAILs a gate plan whose FINISHED measurement carries no verdict", () => {
		const report = run({
			expected: expectedFor(["v720"]),
			gate,
			job: finishedJob,
			vmaf: finished([result("v720")]),
		});
		expect(verdictOf(report, "qc:gate")).toBe("FAIL");
	});

	it("PASSes a passed gate, and a failed gate that BLOCKED delivery", () => {
		const passed = run({
			expected: expectedFor(["v720"]),
			gate,
			job: finishedJob,
			vmaf: {
				...finished([result("v720")]),
				gateVerdict: { pass: true, ruleResults: [{ pass: true }] },
			},
		});
		expect(verdictOf(passed, "qc:gate")).toBe("PASS");
		const blocked = run({
			expected: expectedFor(["v720"]),
			gate,
			job: { status: "QC_FAILED", qcOverriddenAt: null },
			vmaf: { ...finished([result("v720", 60)]), gateVerdict: failedVerdict },
		});
		expect(verdictOf(blocked, "qc:gate")).toBe("PASS");
	});

	it("FAILs a failed gate on a FINISHED job with no override — delivery escaped", () => {
		const report = run({
			expected: expectedFor(["v720"]),
			gate,
			job: finishedJob,
			vmaf: { ...finished([result("v720", 60)]), gateVerdict: failedVerdict },
		});
		expect(verdictOf(report, "qc:gate")).toBe("FAIL");
	});

	it("WARNs a forced delivery so the reader sees the override", () => {
		const report = run({
			expected: expectedFor(["v720"]),
			gate,
			job: {
				status: "FINISHED",
				qcOverriddenAt: new Date("2026-08-28T01:00:00Z"),
			},
			vmaf: { ...finished([result("v720", 60)]), gateVerdict: failedVerdict },
		});
		expect(verdictOf(report, "qc:gate")).toBe("WARN");
		expect(report.counts.FAIL).toBe(0);
	});
});

describe("the wiring, pinned by shape", () => {
	// `verifyJob` needs a database, credentials and a bucket, so no test can call it;
	// `addHygieneChecks` has the same limitation and the same kind of pin. What this
	// catches is the one revert that matters: the rule existing and nobody calling it.
	const job = readFileSync(new URL("./job.ts", import.meta.url), "utf8");
	const runner = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");

	it("verifyJob joins the measurement after the hygiene checks", () => {
		const body = job.slice(
			job.indexOf("export async function verifyJob("),
			job.indexOf("export function formatReport("),
		);
		const hygiene = body.indexOf("addHygieneChecks(report");
		const qc = body.indexOf("addQcMeasurementChecks(report");
		expect(hygiene).toBeGreaterThan(-1);
		expect(qc).toBeGreaterThan(hygiene);
		expect(body).toContain("vmaf: await readAutoVmaf(options.prisma, job.id)");
	});

	it("readAutoVmaf carries persisted result provenance into qc:results", async () => {
		const findFirst = vi.fn(() => Promise.resolve(null));
		await readAutoVmaf({ vmafJob: { findFirst } } as never, "encoding-job");

		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				select: expect.objectContaining({
					results: {
						select: {
							renditionRef: true,
							pooled: true,
							provenance: true,
						},
					},
				}),
			}),
		);
	});

	it("the paid runner waits for the AUTO measurement before verifying a QC plan", () => {
		const scenario = runner.slice(
			runner.indexOf("const terminal = await awaitTerminal(config, jobId);"),
			runner.indexOf("const verified = await verifyJob({"),
		);
		expect(scenario).toContain("if (plan.qc?.vmaf || plan.qc?.psnr)");
		expect(scenario).toContain("await awaitVmafTerminal(config, jobId)");
	});
});
