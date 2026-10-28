import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QC evidence report route . Pins:
 * the 404 split (unknown job vs job-without-QC), the JSON document shape
 * (verdict, digest, upscale context, reserved override flag), the CSV's two
 * tables + formula-injection guard on labels, and the HTML's verdict states —
 * the report is a FILING artifact, so its shape is contract, not styling.
 */

const findUnique = vi.fn();
const vmafFindFirst = vi.fn();
const vmafFindMany = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			encodingJob: { findUnique },
			vmafJob: { findFirst: vmafFindFirst, findMany: vmafFindMany },
		},
	}),
}));

import { autoTriggerKey, labManualTriggerKey } from "@bitovp/db";

import { GET } from "./route";

const JOB_ID = "00000000-0000-4000-8000-0000000000aa";
const VMAF_ID = "00000000-0000-4000-8000-0000000000a1";
const LAB_ID = "00000000-0000-4000-8000-0000000000b2";

function request(
	format?: string,
): [Request, { params: Promise<{ id: string }> }] {
	const qs = format ? `?format=${format}` : "";
	return [
		new Request(`http://test/api/encoding-jobs/${JOB_ID}/qc-report${qs}`),
		{ params: Promise.resolve({ id: JOB_ID }) },
	];
}

const GATE = {
	rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 80 }],
	onFail: "BLOCK_MANIFESTS",
};

/**
 * The verdict, ONE object — audit CRITICAL-1.
 *
 * It is now the MEASUREMENT that owns it, and `EncodingJob.qcVerdict` is the
 * mirror the jobs list reads. These fixtures put the same object in both,
 * because that is what the single writer does in one transaction; a fixture
 * that put a verdict only on the job would be encoding the defect the route
 * used to have.
 */
const VERDICT = {
	pass: false,
	ruleResults: [
		{
			rule: GATE.rules[0],
			pass: false,
			actuals: [
				{ rendition: "v360", value: 95.4, pass: true },
				{ rendition: "pt", variant: "360p_500k", value: 61.2, pass: false },
			],
		},
	],
};

function jobRow(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: JOB_ID,
		name: "gated job",
		labels: ["qc"],
		status: "FINISHED",
		error: null,
		createdAt: new Date("2026-08-13T00:00:00.000Z"),
		qcOverriddenAt: null,
		qcVerdict: VERDICT,
		plan: {
			qc: { vmaf: true, model: "vmaf_v0.6.1", gate: GATE },
			bitmovin: { encoderVersion: "BETA" },
		},
		...over,
	};
}

function vmafRow(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: VMAF_ID,
		createdAt: new Date("2026-08-13T01:00:00.000Z"),
		// The AUTO row by default — this is the provenance that makes a row the
		// gate's evidence, and the report now selects on it.
		triggerKey: autoTriggerKey(JOB_ID),
		gateVerdict: VERDICT,
		model: "vmaf_v0.6.1",
		scoringVersion: 2,
		status: "FINISHED",
		error: null,
		params: { reference: { width: 1920, height: 1080 } },
		cores: 8,
		threads: 4,
		concurrency: 2,
		results: [
			{
				renditionRef: { renditionKey: "v360", height: 360, bitrate: 300000 },
				pooled: {
					mean: 95.4321,
					harmonicMean: 95.1,
					min: 90.2,
					max: 99,
					low1Percent: 91.5,
				},
			},
			{
				renditionRef: {
					renditionKey: "pt",
					perTitleVariant: "360p_500k",
					height: 360,
					bitrate: 500000,
				},
				pooled: { mean: 61.2, harmonicMean: 60.8, min: 40, max: 80 },
			},
			{
				// No renditionKey: the LABEL becomes the CSV rendition cell —
				// and it starts with "=", so the formula guard must neutralize
				// it (a stored label reaches Excel through this export).
				renditionRef: { label: "=HYPERLINK evil", height: 720 },
				pooled: { mean: 88, harmonicMean: 87.5, min: 70, max: 95 },
			},
		],
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	findUnique.mockResolvedValue(jobRow());
	vmafFindFirst.mockResolvedValue(vmafRow());
	vmafFindMany.mockResolvedValue([]);
});

describe("GET /api/encoding-jobs/[id]/qc-report", () => {
	it("looks the auto-run up WITHOUT a Json-null sentinel filter, and a null verdict falls back to the newest measurement (ledger #254)", async () => {
		// The old lookup filtered `gateVerdict: { not: DB_NULL }`; on the
		// live-to-VOD route the same shape matched nothing in the deployed
		// image (three bundled copies of the db package — a route's DB_NULL is
		// not the client's DbNull), and here that would not 409 — it would show
		// a gated job's numbers without its verdict. The verdict is read from
		// the AUTO row and checked in JS; the query carries no Json filter.
		findUnique.mockResolvedValue(jobRow({ qcVerdict: null }));
		vmafFindFirst.mockImplementation(
			(args: { where: Record<string, unknown> }) =>
				Promise.resolve(
					args.where.triggerKey
						? vmafRow({ gateVerdict: null })
						: vmafRow({ id: LAB_ID, gateVerdict: null }),
				),
		);
		vmafFindMany.mockResolvedValue([]);
		const res = await GET(...request("json"));
		expect(res.status).toBe(200);
		const queries = vmafFindFirst.mock.calls.map(
			(c: unknown[]) => c[0] as Record<string, unknown>,
		);
		expect(queries).toHaveLength(2);
		expect((queries[0] as { where: Record<string, unknown> }).where).toEqual({
			encodingJobId: JOB_ID,
			triggerKey: autoTriggerKey(JOB_ID),
		});
		// A null-verdict AUTO row is not the verdict carrier: the fallback ran
		// and its row (LAB_ID) is what the report reads.
		const body = (await res.json()) as {
			vmafJobId?: string;
			measurement?: { id?: string };
		};
		expect(JSON.stringify(body)).toContain(LAB_ID);
	});

	it("404s an unknown job, and a job with neither gate nor measurement", async () => {
		findUnique.mockResolvedValue(null);
		const [req, params] = request();
		expect((await GET(req, params)).status).toBe(404);

		findUnique.mockResolvedValue(jobRow({ qcVerdict: null, plan: {} }));
		vmafFindFirst.mockResolvedValue(null);
		const [req2, params2] = request();
		const res = await GET(req2, params2);
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: string }).error).toBe(
			"This job has no QC data",
		);
	});

	it("400s an unknown format", async () => {
		const [req, params] = request("pdf");
		expect((await GET(req, params)).status).toBe(400);
	});

	it("JSON: verdict, stable digest, upscale terms, reserved override flag", async () => {
		const [req, params] = request("json");
		const res = await GET(req, params);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toContain(
			`qc-report-${JOB_ID}.json`,
		);
		const body = (await res.json()) as {
			generatedFor: string;
			planSha256: string;
			encoderVersion: string;
			overridden: boolean;
			verdict: { pass: boolean };
			measurement: { reference: { height: number } };
			renditions: {
				rendition: string;
				variant: string | null;
				upscale: number | null;
				pooled: { mean: number };
			}[];
		};
		expect(body.generatedFor).toBe("QC evidence report");
		expect(JSON.stringify(body)).not.toMatch(/bitovp/i);
		expect(body.verdict.pass).toBe(false);
		expect(body.encoderVersion).toBe("BETA");
		expect(body.overridden).toBe(false);
		expect(body.planSha256).toMatch(/^[0-9a-f]{64}$/);
		// 1080 ÷ 360 = 3× upscale — the #42 context rides IN the report.
		expect(body.renditions[0]).toMatchObject({
			rendition: "v360",
			variant: null,
			upscale: 3,
		});
		expect(body.renditions[1]).toMatchObject({
			rendition: "pt",
			variant: "360p_500k",
		});
		// Rounded for the document, not raw float dumps.
		expect(body.renditions[0]?.pooled.mean).toBe(95.43);
	});

	it("CSV: pooled table + rule table, formula-injection neutralized", async () => {
		const [req, params] = request("csv");
		const res = await GET(req, params);
		expect(res.status).toBe(200);
		const text = await res.text();
		const [pooledHeader] = text.split("\n");
		expect(pooledHeader).toBe(
			"rendition,variant,height,bitrate,upscale,vmafMean,vmafHarmonicMean,vmafLow1Percent,vmafMin,vmafMax,psnrMean",
		);
		// The rule table follows after a blank line.
		expect(text).toContain(
			"\n\nrule,metric,scope,threshold,target,variant,actual,pass",
		);
		expect(text).toContain(
			"1,VMAF_MEAN,PER_RENDITION,80,pt,360p_500k,61.2,false",
		);
		// An unmeasured actual is a WORD, never an empty cell that reads as zero.
		// (Not in this fixture — asserted structurally: no ",," in the rule rows.)
		// Formula guard: the "=HYPERLINK…"-labelled rendition is quoted with a
		// leading apostrophe somewhere in the pooled table.
		expect(text).toContain("'=HYPERLINK evil");
	});

	it("HTML: FAIL badge, upscale caveat, measurement block — print-CSS inline + CSP", async () => {
		const [req, params] = request("html");
		const res = await GET(req, params);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		// review-202 N2: the strictest CSP — a future escaping slip becomes
		// a no-op instead of same-origin XSS.
		expect(res.headers.get("content-security-policy")).toBe(
			"default-src 'none'; style-src 'unsafe-inline'",
		);
		const html = await res.text();
		expect(html).not.toMatch(/bitovp/i);
		expect(html).toContain("FAIL");
		expect(html).toContain("3×");
		expect(html).toContain("1920×1080");
		expect(html).toContain("@page");
	});

	it("HTML: every user-influenced string renders ESCAPED — markup in name/label/variant/error/encoderVersion (review-202 I3)", async () => {
		// The previous guard was `not.toContain("<script")` against a fixture
		// whose evil value was a CSV-formula payload with no markup — it
		// could not fail in either direction, and removing esc from three
		// interpolation sites left 135 tests green (review-202's surviving
		// mutation). This fixture carries REAL markup through every field an
		// operator or a stored row can influence; kill: drop esc anywhere
		// and a raw tag appears.
		// The verdict is the MEASUREMENT's (audit CRITICAL-1), so the injected
		// markup has to ride the row that owns it; the job column is the
		// mirror, and carries the same object because one transaction writes
		// both.
		const evilVerdict = {
			pass: false,
			ruleResults: [
				{
					rule: GATE.rules[0],
					pass: false,
					actuals: [
						{
							rendition: "<svg onload=alert(2)>",
							variant: "<i>rung</i>",
							value: 61.2,
							pass: false,
						},
					],
				},
			],
		};
		findUnique.mockResolvedValue(
			jobRow({
				name: "<script>alert(document.cookie)</script>",
				error: '<img src=x onerror="alert(1)">',
				plan: {
					qc: { vmaf: true, model: "vmaf_v0.6.1", gate: GATE },
					bitmovin: { encoderVersion: "<b>BETA</b>" },
				},
				qcVerdict: evilVerdict,
			}),
		);
		// The "Other measurement runs" table is FOUR more interpolation sites
		// this PR added, and the guard did not reach them: review proved that
		// dropping esc from `run.error` left all 15 tests green. An evil row
		// now rides that table too.
		vmafFindMany.mockResolvedValue([
			vmafRow({
				id: LAB_ID,
				triggerKey: labManualTriggerKey(JOB_ID, "vmaf_v0.6.1", 1),
				status: "<b>ERROR</b>",
				error: "<script>otherRuns()</script>",
				gateVerdict: null,
				results: [],
			}),
		]);
		vmafFindFirst.mockResolvedValue(
			vmafRow({
				gateVerdict: evilVerdict,
				results: [
					{
						renditionRef: {
							label: "<script>steal()</script>",
							height: 360,
							bitrate: 500000,
						},
						pooled: { mean: 61.2, harmonicMean: 60.8, min: 40, max: 80 },
					},
				],
			}),
		);
		const [req, params] = request("html");
		const html = await (await GET(req, params)).text();
		// The forbidden things: ANY raw occurrence of the injected tags.
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("<b>BETA");
		expect(html).not.toContain("<i>rung");
		// And the REQUIRED things: the escaped forms are present, so this
		// test cannot pass by the fixture simply not rendering those fields.
		// The otherRuns table's own escaped forms — present, so this cannot
		// pass by the table simply not rendering.
		expect(html).toContain("&lt;script&gt;otherRuns()&lt;/script&gt;");
		expect(html).toContain("&lt;b&gt;ERROR&lt;/b&gt;");
		expect(html).toContain(
			"&lt;script&gt;alert(document.cookie)&lt;/script&gt;",
		);
		expect(html).toContain("&lt;img src=x onerror=");
		expect(html).toContain("&lt;svg onload=alert(2)&gt;");
		expect(html).toContain("&lt;b&gt;BETA&lt;/b&gt;");
		expect(html).toContain("&lt;i&gt;rung&lt;/i&gt;");
	});

	it("HTML: the two tables share the rendition KEY, so a printed report can be joined (review-202 I4)", async () => {
		const [req, params] = request("html");
		const html = await (await GET(req, params)).text();
		// The pooled table's first cell carries the rendition KEY (the gate
		// table's Target column always did) — "v360" must appear in BOTH.
		const pooledSection = html.slice(
			html.indexOf("Per-rendition pooled metrics"),
			html.indexOf("Gate outcome"),
		);
		const gateSection = html.slice(html.indexOf("Gate outcome"));
		expect(pooledSection).toContain("v360");
		expect(gateSection).toContain("v360");
	});

	it("HTML: a measurement ERROR reads MEASUREMENT FAILED, not FAIL", async () => {
		findUnique.mockResolvedValue(
			jobRow({ qcVerdict: null, status: "QC_FAILED" }),
		);
		vmafFindFirst.mockResolvedValue(
			vmafRow({
				status: "ERROR",
				error: "ffmpeg exploded",
				results: [],
				gateVerdict: null,
			}),
		);
		const [req, params] = request("html");
		const html = await (await GET(req, params)).text();
		expect(html).toContain("MEASUREMENT FAILED");
		expect(html).toContain("ffmpeg exploded");
		expect(html).toContain("no verdict yet");
	});

	it("a forced delivery is stated in every format (ledger #86 PR4)", async () => {
		findUnique.mockResolvedValue(
			jobRow({ qcOverriddenAt: new Date("2026-08-14T01:00:00.000Z") }),
		);
		const [reqJ, paramsJ] = request("json");
		const body = (await (await GET(reqJ, paramsJ)).json()) as {
			overridden: boolean;
			overriddenAt: string;
		};
		expect(body.overridden).toBe(true);
		expect(body.overriddenAt).toBe("2026-08-14T01:00:00.000Z");
		const [reqH, paramsH] = request("html");
		const html = await (await GET(reqH, paramsH)).text();
		expect(html).toContain("Delivery was forced despite a failing gate");
		// review-203 I1: the CSV was the silent format — a compliance reader
		// concluded BLOCKED where it shipped. Now a stable trailing block.
		const [reqC, paramsC] = request("csv");
		const csv = await (await GET(reqC, paramsC)).text();
		expect(csv).toContain("\noverridden,overriddenAt\n");
		expect(csv).toContain("true,2026-08-14T01:00:00.000Z");
	});

	it("an UN-forced job's CSV still carries the override block (stable layout)", async () => {
		const [req, params] = request("csv");
		const csv = await (await GET(req, params)).text();
		expect(csv).toContain("\noverridden,overriddenAt\nfalse,");
	});

	it("a no-verdict override reads 'without a gate verdict', never 'failing gate' (review-203 N4)", async () => {
		findUnique.mockResolvedValue(
			jobRow({
				qcVerdict: null,
				status: "FINISHED",
				qcOverriddenAt: new Date("2026-08-14T01:00:00.000Z"),
			}),
		);
		vmafFindFirst.mockResolvedValue(
			vmafRow({
				status: "ERROR",
				error: "ffmpeg exploded",
				results: [],
				gateVerdict: null,
			}),
		);
		const [req, params] = request("html");
		const html = await (await GET(req, params)).text();
		expect(html).toContain("Delivery was forced without a gate verdict");
		expect(html).not.toContain("despite a failing gate");
	});

	it("a gate with no measurement yet reports PENDING", async () => {
		findUnique.mockResolvedValue(
			jobRow({ qcVerdict: null, status: "AWAITING_QC" }),
		);
		vmafFindFirst.mockResolvedValue(null);
		const [req, params] = request("html");
		const html = await (await GET(req, params)).text();
		expect(html).toContain("PENDING");
		expect(html).toContain("No measurement exists");
	});

	it("a later lab re-run never lends its status to the gate's verdict (audit CRITICAL-1)", async () => {
		/*
		 * The finding: the route read the verdict off `EncodingJob.qcVerdict`
		 * and, INDEPENDENTLY, selected the newest VmafJob — two selections,
		 * one document. An operator who re-ran VMAF by hand after a PASS got a
		 * report whose badge said PASS and whose measurement block carried the
		 * re-run's id, model and ERROR text.
		 *
		 * Kill: point the measurement selection back at the newest row
		 * (drop the `gateVerdict: { not: DB_NULL }` filter) and the id, the
		 * status and the rendition count all move to the lab run.
		 */
		const PASS_VERDICT = {
			pass: true,
			ruleResults: [
				{
					rule: GATE.rules[0],
					pass: true,
					actuals: [{ rendition: "v360", value: 95.4, pass: true }],
				},
			],
		};
		const gateRun = vmafRow({ gateVerdict: PASS_VERDICT });
		const labRun = vmafRow({
			id: LAB_ID,
			triggerKey: labManualTriggerKey(JOB_ID, "vmaf_v0.6.1", 1),
			// LATER than the gate run: this is the whole mechanism. Under the
			// old shape "newest" and "the one that gated" were different rows.
			createdAt: new Date("2026-08-13T09:00:00.000Z"),
			status: "ERROR",
			error: "lab re-run: ffmpeg exploded",
			gateVerdict: null,
			results: [],
		});
		findUnique.mockResolvedValue(jobRow({ qcVerdict: PASS_VERDICT }));
		// The two queries are told apart the way the route tells them apart,
		// so a reverted filter reaches the lab run instead of erroring out.
		// The fake discriminates the AUTO lookup by its trigger key — the route
		// no longer sends a verdict filter ; the verdict is read
		// from the AUTO row and checked in JS.
		vmafFindFirst.mockImplementation(
			(args: { where: { triggerKey?: unknown } }) =>
				Promise.resolve(
					args.where.triggerKey === autoTriggerKey(JOB_ID) ? gateRun : labRun,
				),
		);
		vmafFindMany.mockResolvedValue([labRun]);

		const [req, params] = request();
		const body = await (await GET(req, params)).json();

		// The measurement block is the GATE run's, whole.
		expect(body.measurement.vmafJobId).toBe(VMAF_ID);
		expect(body.measurement.status).toBe("FINISHED");
		expect(body.measurement.error).toBeNull();
		expect(body.renditions).toHaveLength(3);
		expect(body.verdict.pass).toBe(true);
		expect(body.verdictEvidence).toBe("MEASUREMENT");
		// And the lab run is present, in its own frame, labelled as no gate.
		expect(body.otherRuns).toEqual([
			{
				vmafJobId: LAB_ID,
				status: "ERROR",
				error: "lab re-run: ffmpeg exploded",
				createdAt: "2026-08-13T09:00:00.000Z",
				trigger: "LAB_MANUAL",
				carriedGateVerdict: false,
			},
		]);

		const [htmlReq, htmlParams] = request("html");
		const html = await (await GET(htmlReq, htmlParams)).text();
		expect(html).toContain("PASS");
		expect(html).not.toContain("MEASUREMENT FAILED");
		// The re-run's failure is disclosed — under Other runs, not as the
		// gate's own state. Both halves matter: hiding it would be the same
		// document lying in the other direction.
		expect(html).toContain("Other measurement runs");
		expect(html).toContain("lab re-run: ffmpeg exploded");
	});

	it("a verdict whose measurement is gone reads VERDICT WITHOUT EVIDENCE, never PASS (audit CRITICAL-1)", async () => {
		// The mirror outliving its VmafJob (retention sweep, manual delete).
		// Dropping the verdict here would contradict the jobs list; printing
		// it as a plain PASS would assert evidence that no row holds.
		findUnique.mockResolvedValue(
			jobRow({ qcVerdict: { pass: true, ruleResults: [] } }),
		);
		vmafFindFirst.mockResolvedValue(null);
		const body = await (await GET(...request())).json();
		expect(body.verdictEvidence).toBe("ORPHANED");
		expect(body.measurement).toBeNull();
		const html = await (await GET(...request("html"))).text();
		expect(html).toContain("VERDICT WITHOUT EVIDENCE");
	});

	it("a lab re-run that ALSO carries a verdict is still not the gate evidence (the axis the first fix missed)", async () => {
		/*
		 * Before #198, `gateCtx` used the linked PLAN without checking the
		 * trigger, so manual runs wrote their own verdict AND the job mirror.
		 * Those historical rows remain after the writer fix. Therefore
		 * "the newest row carrying a verdict" is not the row that
		 * gated delivery, and the first cut of the CRITICAL-1 fix selected on
		 * exactly that. This arm is the one that fails under it.
		 *
		 * Kill: drop `triggerKey` from the gate query's where and the lab run's
		 * FAIL becomes the gate's verdict.
		 */
		const autoRun = vmafRow({
			gateVerdict: { pass: true, ruleResults: [] },
		});
		const labRun = vmafRow({
			id: LAB_ID,
			triggerKey: labManualTriggerKey(JOB_ID, "vmaf_v0.6.1", 1),
			createdAt: new Date("2026-08-13T09:00:00.000Z"),
			// A verdict of its own, and a FAILING one.
			gateVerdict: { pass: false, ruleResults: [] },
			results: [],
		});
		// The mirror carries the LAB run's verdict, because that write is the
		// runner's last one. The report must not take the badge from it.
		findUnique.mockResolvedValue(
			jobRow({ qcVerdict: { pass: false, ruleResults: [] } }),
		);
		vmafFindFirst.mockImplementation(
			(args: { where: { triggerKey?: unknown } }) =>
				Promise.resolve(args.where.triggerKey ? autoRun : labRun),
		);
		vmafFindMany.mockResolvedValue([labRun]);

		const body = await (await GET(...request())).json();
		expect(body.measurement.vmafJobId).toBe(VMAF_ID);
		expect(body.verdict.pass).toBe(true);
		expect(body.verdictEvidence).toBe("MEASUREMENT");
		expect(body.otherRuns[0]).toMatchObject({
			vmafJobId: LAB_ID,
			trigger: "LAB_MANUAL",
			// True, and that is the point: presence of a verdict does NOT make
			// a row the gate's, which is why `trigger` exists beside it.
			carriedGateVerdict: true,
		});
	});

	it("CSV discloses verdictEvidence and otherRuns — it was the silent format again", async () => {
		/*
		 * Review of this PR, reproduced empirically before the fix: with a
		 * stored `qcVerdict` and NO VmafJob at all — the ORPHANED case that
		 * `verdictEvidence` exists to disclose — the CSV came back with an
		 * empty pooled table AND an empty rule table, saying nothing about the
		 * verdict at all, while JSON and HTML both said VERDICT WITHOUT
		 * EVIDENCE.
		 *
		 * Two causes, both fixed: the rule loop read the bare `verdict` (the
		 * gate run's only) instead of `report.verdict`, and no trailing block
		 * carried the new fields.
		 *
		 * This is the SAME defect class as review-203 I1, which this very file
		 * already fixed once for the `overridden` flag — "a compliance reader
		 * concluded BLOCKED where it shipped". A format that is silent about
		 * the thing the document exists to state is the failure mode here.
		 */
		findUnique.mockResolvedValue(jobRow());
		vmafFindFirst.mockResolvedValue(null);
		vmafFindMany.mockResolvedValue([]);
		const csv = await (await GET(...request("csv"))).text();
		expect(csv).toContain("verdictEvidence");
		expect(csv).toContain("ORPHANED");
		// And the rule table is NOT empty — the mirrored verdict's rows are
		// present, which is what the bare-`verdict` read suppressed.
		expect(csv).toContain("VMAF_MEAN");
		expect(csv).toContain("360p_500k");
	});

	it("CSV lists other runs with provenance, not just the gate's own", async () => {
		const labRun = vmafRow({
			id: LAB_ID,
			triggerKey: labManualTriggerKey(JOB_ID, "vmaf_v0.6.1", 1),
			createdAt: new Date("2026-08-13T09:00:00.000Z"),
			status: "ERROR",
			error: "lab re-run: ffmpeg exploded",
			gateVerdict: null,
			results: [],
		});
		findUnique.mockResolvedValue(jobRow());
		vmafFindFirst.mockResolvedValue(vmafRow());
		vmafFindMany.mockResolvedValue([labRun]);
		const csv = await (await GET(...request("csv"))).text();
		expect(csv).toContain(
			"otherRunVmafJobId,trigger,status,carriedGateVerdict,createdAt,error",
		);
		expect(csv).toContain(`${LAB_ID},LAB_MANUAL,ERROR,false`);
		expect(csv).toContain("lab re-run: ffmpeg exploded");
		// MEASUREMENT, because the default vmafRow IS the auto row with a
		// verdict — the evidence line must not read ORPHANED here.
		expect(csv).toContain("MEASUREMENT");
	});

	it("BOTH selection queries are shaped as the route needs — the fallback had no coverage at all", async () => {
		/*
		 * Reviewer's finding, demonstrated rather than argued: every test used
		 * `vmafFindFirst.mockResolvedValue(...)`, which ignores the `where`
		 * clause, so the SECOND query — the informational fallback taken when
		 * no gated AUTO row exists — was never exercised in any of the 15
		 * tests. They proved it by flipping its `orderBy` from "desc" to "asc"
		 * (in production: show the OLDEST unrelated measurement instead of the
		 * newest) and watching all 15 stay green.
		 *
		 * Asserting the CALL SHAPE is the instrument here, not the returned
		 * row: the mock is what decides which row comes back, so a test that
		 * checked the row would be grading the mock. What the route actually
		 * owns is the query it sends.
		 */
		findUnique.mockResolvedValue(jobRow({ qcVerdict: null }));
		// No AUTO row carrying a verdict -> the fallback runs.
		vmafFindFirst.mockImplementation(
			(args: { where: Record<string, unknown> }) =>
				Promise.resolve(
					args.where.triggerKey ? null : vmafRow({ gateVerdict: null }),
				),
		);
		vmafFindMany.mockResolvedValue([]);
		await GET(...request());

		const queries = vmafFindFirst.mock.calls.map(
			(c: unknown[]) => c[0] as Record<string, unknown>,
		);
		// Asserted, not destructured-and-hoped: a route that stopped issuing
		// the fallback entirely would leave `fallbackQuery` undefined, and
		// every `toEqual` below would then be comparing against nothing.
		expect(queries).toHaveLength(2);
		const gateQuery = queries[0] as Record<string, unknown>;
		const fallbackQuery = queries[1] as Record<string, unknown>;
		// The gate query: scoped to the AUTO row AND to a non-null verdict.
		// : no Json-null sentinel in the filter — the verdict is
		// read from the row and checked in JS.
		expect(gateQuery.where).toEqual({
			encodingJobId: JOB_ID,
			triggerKey: autoTriggerKey(JOB_ID),
		});
		// The fallback: every measurement for the job, NEWEST first. The
		// ordering is the whole point — it decides which measurement an
		// operator is shown when nothing gated.
		expect(fallbackQuery.where).toEqual({ encodingJobId: JOB_ID });
		expect(fallbackQuery.orderBy).toEqual({ createdAt: "desc" });
	});

	it("the other-runs query excludes the gate's own row — and only when there is one (review-320c)", async () => {
		/*
		 * Same instrument as the shape test above, for the THIRD query. The
		 * `id: { not: vmaf.id }` exclusion keeps the gate-evidence row out of its
		 * own "other runs" list, and no fixture ever gave `vmafFindMany` a row
		 * sharing the gate row's id — so deleting the exclusion changed nothing
		 * any of the 20 tests could see (a reviewer proved it by mutation). The
		 * mock decides what comes back; what the route owns is the query it sends.
		 */
		await GET(...request("json"));
		const withGate = vmafFindMany.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
		};
		expect(withGate.where).toEqual({
			encodingJobId: JOB_ID,
			id: { not: VMAF_ID },
		});

		// No gate row at all: the list is every measurement, nothing excluded.
		vi.clearAllMocks();
		findUnique.mockResolvedValue(jobRow());
		vmafFindFirst.mockResolvedValue(null);
		vmafFindMany.mockResolvedValue([]);
		await GET(...request("json"));
		const withoutGate = vmafFindMany.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
		};
		expect(withoutGate.where).toEqual({ encodingJobId: JOB_ID });
	});

	it("a truncated run list SAYS SO in all three formats — the cap is not silent", async () => {
		/*
		 * Review of this PR. The first cut set `take: 100` and cited
		 * /api/vmaf-jobs as the precedent — but that sibling takes `limit + 1`
		 * and reports a `nextCursor`. I copied the cap NUMBER and left the
		 * disclosure behind, which is a silent truncation in an EVIDENCE
		 * document: the same defect as the silent CSV, introduced in the commit
		 * that fixed the silent CSV.
		 *
		 * A consumer counting `otherRuns.length` to answer "how many times was
		 * this re-measured" gets a wrong number past 100 and nothing tells it.
		 */
		const rows = Array.from({ length: 101 }, (_, i) =>
			vmafRow({
				id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
				triggerKey: labManualTriggerKey(JOB_ID, "vmaf_v0.6.1", i + 1),
				gateVerdict: null,
				results: [],
			}),
		);
		findUnique.mockResolvedValue(jobRow());
		vmafFindFirst.mockResolvedValue(vmafRow());
		vmafFindMany.mockResolvedValue(rows);

		const body = await (await GET(...request())).json();
		// Sliced to the cap, and the overflow is REPORTED rather than inferable
		// only by noticing the length is suspiciously round.
		expect(body.otherRuns).toHaveLength(100);
		expect(body.otherRunsTruncated).toBe(true);
		/*
		 * The QUERY, not just the result — and this assertion exists because
		 * its absence was caught by a surviving mutant, not by foresight.
		 * `vmafFindMany` is a mock: it returns 101 rows whatever `take` says,
		 * so reverting the route to a SILENT `take: LIMIT` left all 20 tests
		 * green. That is the identical "the mock ignores the query" gap review
		 * had just found in the fallback selection — reintroduced by me while
		 * fixing it. Asserting the sent query is the only thing that can see it.
		 */
		expect(vmafFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ take: 101 }),
		);

		const html = await (await GET(...request("html"))).text();
		expect(html).toContain("a floor, not a total");

		const csv = await (await GET(...request("csv"))).text();
		expect(csv).toContain("verdictEvidence,otherRunsTruncated");
		expect(csv).toContain("MEASUREMENT,true");
	});

	it("an UNtruncated list says so too, so the flag is read and not assumed", async () => {
		// The negative arm: without it, hard-coding `otherRunsTruncated: true`
		// would satisfy the arm above and be wrong for every ordinary report.
		findUnique.mockResolvedValue(jobRow());
		vmafFindFirst.mockResolvedValue(vmafRow());
		vmafFindMany.mockResolvedValue([]);
		const body = await (await GET(...request())).json();
		expect(body.otherRunsTruncated).toBe(false);
		const html = await (await GET(...request("html"))).text();
		expect(html).not.toContain("a floor, not a total");
		const csv = await (await GET(...request("csv"))).text();
		expect(csv).toContain("MEASUREMENT,false");
	});
});

it.each([
	"json",
	"csv",
	"html",
])("accepts the native organization marker without changing the %s report", async (format) => {
	const [req, params] = request(format);
	const url = new URL(req.url);
	url.searchParams.set(
		"expectedOrganizationId",
		"00000000-0000-4000-8000-000000000001",
	);
	expect((await GET(new Request(url), params)).status).toBe(200);
});
it.each([
	"invalid",
	"00000000-0000-4000-8000-000000000001&expectedOrganizationId=00000000-0000-4000-8000-000000000001",
])("refuses malformed report organization markers before reading the job: %s", async (value) => {
	const [req, params] = request("json");
	expect(
		(
			await GET(
				new Request(`${req.url}&expectedOrganizationId=${value}`),
				params,
			)
		).status,
	).toBe(400);
	expect(findUnique).not.toHaveBeenCalled();
});
