import { createHash } from "node:crypto";
import type { QcGate, QcVerdict } from "@bitovp/core";
import type { Prisma, VmafTriggerKind } from "@bitovp/db";
import { autoTriggerKey, vmafTriggerKind } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { comparisonContext } from "@/app/qc/vmaf-context";
import { renditionLabel } from "@/app/qc/vmaf-shared";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/** C6's cap for the secondary run list. Overflow is reported, never dropped. */
const OTHER_RUNS_LIMIT = 100;

/**
 * QC evidence report : one document per
 * encoding job stating what was measured, against what, and what the gate
 * decided — job identity, plan digest, encoder version, per-rendition pooled
 * metrics WITH the comparison's own terms (upscale factor + reference
 * resolution ride IN the report — the #42 lesson: a correct low number with
 * no context reads as a broken pipeline), rule outcomes, and the measurement
 * error when the verdict never happened.
 *
 * Formats: json (machine filing), csv (spreadsheets — FIVE blocks, each a
 * self-describing header after a blank line: pooled metrics, rule outcomes,
 * override state, verdict evidence, other runs; it said "two tables" from
 * before review-203 added the third and this PR added the last two),
 * html (print-CSS, so
 * browser print-to-PDF is the PDF path — the design's honest no-PDF-library
 * stance). English on purpose: exports are DATA, one wording for whoever
 * reads a payload and whoever reads a log (the renditionLabel precedent).
 *
 * The override flag (design §4): `overridden`/`overriddenAt` state a forced
 * delivery in every format (review-203 I1 added the CSV block).
 */

const querySchema = z.object({
	format: z.enum(["json", "csv", "html"]).default("json"),
});

/** RFC 4180 + formula-injection guard — same rules as the vmaf export. */
function csvCell(value: string): string {
	const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\n\r]/.test(guarded)
		? `"${guarded.replace(/"/g, '""')}"`
		: guarded;
}

type PooledJson = {
	mean?: number;
	harmonicMean?: number;
	min?: number;
	max?: number;
	low1Percent?: number;
	psnr?: { mean?: number };
};

type StoredRenditionRef = {
	renditionKey?: string;
	label?: string;
	height?: number | null;
	bitrate?: number | null;
	perTitleVariant?: string;
};

type ReportRendition = {
	rendition: string;
	label: string;
	variant: string | null;
	height: number | null;
	bitrate: number | null;
	/** reference-height ÷ rendition-height, when both are known (#42). */
	upscale: number | null;
	pooled: {
		mean: number | null;
		harmonicMean: number | null;
		low1Percent: number | null;
		min: number | null;
		max: number | null;
		psnrMean: number | null;
	};
};

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number | null, places = 2): number | null {
	return value === null ? null : Number(value.toFixed(places));
}

export async function GET(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const url = new URL(req.url);
	const parsed = querySchema.safeParse({
		format: url.searchParams.get("format") ?? undefined,
	});
	if (!parsed.success) {
		return jsonError(400, "Invalid export parameters");
	}
	const { format } = parsed.data;

	try {
		const ctx = await getServerContext();
		const job = await ctx.prisma.encodingJob.findUnique({
			where: { id },
			select: {
				id: true,
				name: true,
				labels: true,
				status: true,
				error: true,
				createdAt: true,
				qcVerdict: true,
				qcOverriddenAt: true,
				plan: true,
			},
		});
		if (!job) {
			return jsonError(404, "Not found");
		}
		const plan = job.plan as {
			qc?: { model?: string; gate?: QcGate };
			bitmovin?: { encoderVersion?: string };
		} | null;
		/*
		 * THE GATE-EVIDENCE MEASUREMENT — audit ce4a935f CRITICAL-1.
		 *
		 * This used to be "the LATEST measurement", selected INDEPENDENTLY of
		 * the verdict, which was read from the denormalized
		 * `EncodingJob.qcVerdict`. Two independent selections joined into one
		 * document, so an automatic run's PASS badge could be printed beside a
		 * LATER manual lab run's measurement id, model and ERROR. On an
		 * evidence document.
		 *
		 * The fix is not to store a third copy of the linkage — an id on the
		 * encoding job would be a third thing able to drift from the other two.
		 * It is to read the verdict FROM THE ROW THAT OWNS IT. `gateVerdict` has
		 * exactly ONE writer (`vmaf/processor.ts`), which writes it in the SAME
		 * transaction as the `qcVerdict` mirror — the schema states that
		 * contract on both columns. Taking the verdict from the same row that
		 * carries the numbers makes a mismatch unrepresentable rather than
		 * merely unlikely.
		 *
		 * WHICH row is the `vod-auto:` one, and this is not a stylistic choice:
		 * the first cut of this fix said "the newest row carrying a verdict",
		 * which is the SAME defect one axis over. Before #198, the writer
		 * also evaluated gates for lab-manual runs. Those historical verdicts
		 * remain stored even though only exact AUTO now evaluates a gate.
		 * "Newest with a verdict" would still elect an old lab run as the gate's
		 * evidence. `orchestrator/processor.ts` scopes its own read to the AUTO
		 * row for this exact reason (review-258 122-A2); the evidence document
		 * has to agree with the decision, so it reads the same row.
		 *
		 * Later runs are not dropped — they are reported SEPARATELY below, which
		 * is what the operator needs: a failing lab re-run is real information,
		 * it just is not the gate's evidence.
		 */
		const MEASUREMENT_FIELDS = {
			id: true,
			model: true,
			scoringVersion: true,
			status: true,
			error: true,
			params: true,
			cores: true,
			threads: true,
			concurrency: true,
			createdAt: true,
			gateVerdict: true,
			results: {
				orderBy: { createdAt: "asc" },
				select: { renditionRef: true, pooled: true },
			},
			// `satisfies`, not `as const` and not a bare object: the first
			// widens the nested select and Prisma's inference then loses
			// `results`; the second drops the field-name check entirely. This
			// keeps both — the same reason the repo's exhaustiveness anchors
			// use it.
		} satisfies Prisma.VmafJobSelect;
		// At most one such row exists — `vmaf/trigger.ts` holds a unique
		// constraint on it — so this is a lookup, not a ranking. The verdict
		// is read back and checked in JS, NOT filtered with a Json-null
		// sentinel: `gateVerdict: { not: DB_NULL }` is the shape that matched
		// nothing in the deployed image on the live-to-VOD route (ledger
		// #254), and here a filter that silently matched nothing would not
		// 409 — it would fall through to "the newest measurement" and show a
		// gated job's numbers without its verdict.
		const autoRunRow = await ctx.prisma.vmafJob.findFirst({
			where: { encodingJobId: id, triggerKey: autoTriggerKey(id) },
			select: MEASUREMENT_FIELDS,
		});
		const autoRun = autoRunRow?.gateVerdict != null ? autoRunRow : null;
		// With no gate run there is no verdict to mis-pair, so the newest
		// measurement carries the numbers and the verdict stays null.
		const vmaf =
			autoRun ??
			(await ctx.prisma.vmafJob.findFirst({
				where: { encodingJobId: id },
				orderBy: { createdAt: "desc" },
				select: MEASUREMENT_FIELDS,
			}));
		// Every OTHER run, newest first — the lab re-runs whose status the old
		// shape smuggled into the gate's own measurement block.
		const otherRunRows = await ctx.prisma.vmafJob.findMany({
			where: {
				encodingJobId: id,
				...(vmaf ? { id: { not: vmaf.id } } : {}),
			},
			orderBy: { createdAt: "desc" },
			// C6 (list endpoints paginate, limit ≤ 100). LIMIT + 1, not LIMIT,
			// so the overflow is DETECTABLE. Review of this PR caught that the
			// first cut cited /api/vmaf-jobs as its precedent, copied that
			// sibling's cap NUMBER and left its disclosure behind — the sibling
			// takes `limit + 1` and reports a `nextCursor`. A silent truncation
			// in an EVIDENCE document is the same defect as the silent CSV this
			// same commit series fixed, one field over: a consumer counting
			// `otherRuns.length` to answer "how many times was this
			// re-measured" gets a wrong number past 100 and nothing says so.
			take: OTHER_RUNS_LIMIT + 1,
			select: {
				id: true,
				status: true,
				error: true,
				createdAt: true,
				triggerKey: true,
				gateVerdict: true,
			},
		});
		const otherRunsTruncated = otherRunRows.length > OTHER_RUNS_LIMIT;
		const otherRuns = otherRunRows.slice(0, OTHER_RUNS_LIMIT).map((run) => ({
			vmafJobId: run.id,
			status: run.status,
			error: run.error,
			createdAt: run.createdAt.toISOString(),
			// WHY this run is not the gate evidence. Provenance, not the
			// presence of a verdict: historical lab re-runs can carry a
			// gateVerdict, so `carriedGateVerdict` alone would read as "this
			// one gated too" for exactly the rows this field exists to
			// distinguish.
			trigger: vmafTriggerKind(run.triggerKey, id),
			carriedGateVerdict: run.gateVerdict != null,
		}));
		const gate = plan?.qc?.gate ?? null;
		if (!gate && !vmaf) {
			// A QC report for a job with neither a gate nor a measurement is a
			// resource that does not exist, not an empty document.
			return jsonError(404, "This job has no QC data");
		}

		const reference = (
			(vmaf?.params ?? {}) as {
				reference?: { width?: number; height?: number };
			}
		).reference;
		const renditions: ReportRendition[] = (vmaf?.results ?? []).map(
			(result, index) => {
				const ref = result.renditionRef as StoredRenditionRef;
				const pooled = result.pooled as PooledJson;
				const terms = comparisonContext({
					renditionHeight: ref.height ?? undefined,
					referenceHeight: reference?.height ?? undefined,
				});
				return {
					rendition: ref.renditionKey ?? ref.label ?? `rendition-${index + 1}`,
					// Null-stripped: the stored ref spells unknown as null, the
					// label helper's type as absence.
					label: renditionLabel(
						{
							...(ref.label ? { label: ref.label } : {}),
							...(ref.height ? { height: ref.height } : {}),
							...(ref.bitrate ? { bitrate: ref.bitrate } : {}),
						},
						index,
					),
					variant: ref.perTitleVariant ?? null,
					height: ref.height ?? null,
					bitrate: ref.bitrate ?? null,
					upscale:
						terms.kind === "cross-resolution" || terms.kind === "native"
							? round(terms.upscale)
							: null,
					pooled: {
						mean: round(num(pooled.mean)),
						harmonicMean: round(num(pooled.harmonicMean)),
						low1Percent: round(num(pooled.low1Percent)),
						min: round(num(pooled.min)),
						max: round(num(pooled.max)),
						psnrMean: round(num(pooled.psnr?.mean)),
					},
				};
			},
		);

		/*
		 * THE VERDICT COMES FROM THE MEASUREMENT THAT OWNS IT, not from the
		 * encoding job's denormalized mirror (audit CRITICAL-1). One row, so
		 * the badge and the measurement block cannot describe different runs.
		 *
		 * `EncodingJob.qcVerdict` still exists and is still correct — it is the
		 * jobs LIST's copy and the orchestrator boundary's read. It is simply
		 * not this document's source, because a document that joins two
		 * independent selections is exactly how a PASS badge ended up beside a
		 * failed run's id.
		 */
		const verdict = (autoRun?.gateVerdict as QcVerdict | null) ?? null;
		/*
		 * ORPHANED, and worth a field rather than silence. If the mirror says
		 * there was a verdict but no measurement carries one, the row that
		 * produced it is gone — and dropping the verdict here would make this
		 * report contradict the jobs list, which is the same defect one level
		 * over. State it instead.
		 */
		const mirroredVerdict = (job.qcVerdict as QcVerdict | null) ?? null;
		const verdictEvidence: Report["verdictEvidence"] =
			verdict !== null
				? "MEASUREMENT"
				: mirroredVerdict !== null
					? "ORPHANED"
					: "NONE";
		const report = {
			generatedFor: "QC evidence report",
			job: {
				id: job.id,
				name: job.name,
				labels: job.labels,
				status: job.status,
				error: job.error,
				createdAt: job.createdAt.toISOString(),
			},
			// sha256 of the stored plan JSON: ties the report to the exact
			// configuration that produced it, without embedding credentials
			// (the digest is one-way; the plan itself is NOT in the report).
			planSha256: createHash("sha256")
				.update(JSON.stringify(job.plan))
				.digest("hex"),
			encoderVersion: plan?.bitmovin?.encoderVersion ?? "STABLE",
			measurement: vmaf
				? {
						vmafJobId: vmaf.id,
						model: vmaf.model,
						scoringVersion: vmaf.scoringVersion,
						status: vmaf.status,
						error: vmaf.error,
						reference: reference ?? null,
						cores: vmaf.cores,
						threads: vmaf.threads,
						concurrency: vmaf.concurrency,
					}
				: null,
			gate,
			verdict: verdict ?? mirroredVerdict,
			verdictEvidence,
			otherRuns,
			otherRunsTruncated,
			// PR4: no longer reserved — the audited override stamps this.
			// Loose != so an absent field (a mock, a projection change) reads
			// NOT-overridden — claiming a forced delivery that never happened
			// is the worse direction for an evidence document.
			overridden: job.qcOverriddenAt != null,
			overriddenAt: job.qcOverriddenAt?.toISOString() ?? null,
			renditions,
		};

		const stem = `qc-report-${job.id}`;
		if (format === "json") {
			return new NextResponse(JSON.stringify(report, null, 2), {
				status: 200,
				headers: {
					"content-type": "application/json; charset=utf-8",
					"content-disposition": `attachment; filename="${stem}.json"`,
				},
			});
		}
		if (format === "csv") {
			const lines = [
				"rendition,variant,height,bitrate,upscale,vmafMean,vmafHarmonicMean,vmafLow1Percent,vmafMin,vmafMax,psnrMean",
			];
			for (const r of renditions) {
				lines.push(
					[
						csvCell(r.rendition),
						csvCell(r.variant ?? ""),
						r.height ?? "",
						r.bitrate ?? "",
						r.upscale ?? "",
						r.pooled.mean ?? "",
						r.pooled.harmonicMean ?? "",
						r.pooled.low1Percent ?? "",
						r.pooled.min ?? "",
						r.pooled.max ?? "",
						r.pooled.psnrMean ?? "",
					].join(","),
				);
			}
			lines.push("");
			lines.push("rule,metric,scope,threshold,target,variant,actual,pass");
			// `report.verdict`, NOT the bare `verdict` (review of this PR).
			// The bare one is the gate run's only; `report.verdict` is
			// `verdict ?? mirroredVerdict`, which is what JSON and HTML print.
			// Reading the narrower value here made the CSV the one format that
			// showed an EMPTY rule table for an ORPHANED verdict — a stored
			// verdict that no measurement backs, rendered as no verdict at all.
			for (const [ruleIndex, ruleResult] of (
				report.verdict?.ruleResults ?? []
			).entries()) {
				for (const actual of ruleResult.actuals) {
					lines.push(
						[
							ruleIndex + 1,
							csvCell(ruleResult.rule.metric),
							csvCell(ruleResult.rule.scope),
							ruleResult.rule.gte,
							csvCell(actual.rendition),
							csvCell(actual.variant ?? ""),
							actual.value ?? "unmeasured",
							actual.pass,
						].join(","),
					);
				}
			}
			// review-203 I1: the CSV is a filing artifact like the HTML — a
			// forced delivery must be stated in EVERY format, and this one was
			// silent (a compliance reader concluded BLOCKED where it shipped).
			// Always present so the layout is stable (the psnr-column rule).
			lines.push("");
			lines.push("overridden,overriddenAt");
			lines.push(`${report.overridden},${report.overriddenAt ?? ""}`);
			// Same rule as `overridden` above, and it was broken the same way:
			// this PR added `verdictEvidence` and `otherRuns` to JSON and HTML
			// and left the CSV silent. In the ORPHANED case that silence was
			// total — an empty pooled table and an empty rule table, with
			// nothing saying a verdict existed at all. Always present so the
			// layout is stable (the psnr-column rule).
			lines.push("");
			lines.push("verdictEvidence,otherRunsTruncated");
			lines.push(
				`${csvCell(report.verdictEvidence)},${report.otherRunsTruncated}`,
			);
			lines.push("");
			lines.push(
				"otherRunVmafJobId,trigger,status,carriedGateVerdict,createdAt,error",
			);
			for (const run of report.otherRuns) {
				lines.push(
					[
						csvCell(run.vmafJobId),
						csvCell(run.trigger),
						csvCell(run.status),
						run.carriedGateVerdict,
						csvCell(run.createdAt),
						csvCell(run.error ?? ""),
					].join(","),
				);
			}
			return new NextResponse(lines.join("\n"), {
				status: 200,
				headers: {
					"content-type": "text/csv; charset=utf-8",
					"content-disposition": `attachment; filename="${stem}.csv"`,
				},
			});
		}
		return new NextResponse(reportHtml(report), {
			status: 200,
			headers: {
				// Inline, not attachment: the print-to-PDF path is "open, Cmd-P".
				"content-type": "text/html; charset=utf-8",
				// review-202 N2: this is the app's only string-built text/html
				// response — a self-contained document (inline style, no
				// scripts, no assets), so the strictest CSP costs nothing and
				// downgrades any future escaping slip from same-origin XSS to
				// a no-op.
				"content-security-policy":
					"default-src 'none'; style-src 'unsafe-inline'",
			},
		});
	} catch (err) {
		return routeError(err);
	}
}

type Report = {
	job: {
		id: string;
		name: string;
		labels: string[];
		status: string;
		error: string | null;
		createdAt: string;
	};
	planSha256: string;
	encoderVersion: string;
	measurement: {
		vmafJobId: string;
		model: string;
		scoringVersion: number;
		status: string;
		error: string | null;
		reference: { width?: number; height?: number } | null;
		cores: number | null;
		threads: number | null;
		concurrency: number | null;
	} | null;
	gate: QcGate | null;
	verdict: QcVerdict | null;
	/**
	 * WHERE the verdict above came from — audit CRITICAL-1.
	 *
	 * `MEASUREMENT`: read off the VmafJob that produced it, which is the only
	 * state in which the badge and the measurement block are guaranteed to
	 * describe the same run. `ORPHANED`: the encoding job's mirror carries a
	 * verdict but no measurement does, so the producing row is gone — reported
	 * rather than dropped, because dropping it would make this document
	 * contradict the jobs list. `NONE`: no verdict anywhere.
	 */
	verdictEvidence: "MEASUREMENT" | "ORPHANED" | "NONE";
	/**
	 * Every OTHER measurement for this job, newest first. A manual lab re-run
	 * belongs here and not in `measurement` — conflating the two is what let a
	 * later run's ERROR print beside an earlier run's PASS.
	 */
	/**
	 * The run list above hit its C6 cap and is INCOMPLETE. Reported rather than
	 * left to be inferred from a length: a consumer counting `otherRuns.length`
	 * as "how many re-measurements happened" is exactly the reader this
	 * document exists to keep honest.
	 */
	otherRunsTruncated: boolean;
	otherRuns: {
		vmafJobId: string;
		/**
		 * WHY this run is not the gate evidence. Declared as well as emitted
		 * (review of this PR): the runtime object always carried it, but the
		 * type did not, and `report` reaches the renderers through an untyped
		 * const so excess-property checking never fired. A future consumer
		 * reading this type would have silently lost the field.
		 */
		trigger: VmafTriggerKind;
		status: string;
		error: string | null;
		createdAt: string;
		carriedGateVerdict: boolean;
	}[];
	overridden: boolean;
	overriddenAt: string | null;
	renditions: ReportRendition[];
};

function esc(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function verdictBadge(report: Report): { text: string; cls: string } {
	/*
	 * ORPHANED is checked FIRST and never renders a bare PASS — audit
	 * CRITICAL-1. A verdict whose measurement is gone is not evidence of
	 * anything, and this is the badge a reader takes away from the document.
	 */
	if (report.verdictEvidence === "ORPHANED") {
		return { text: "VERDICT WITHOUT EVIDENCE", cls: "fail" };
	}
	if (report.verdict) {
		return report.verdict.pass
			? { text: "PASS", cls: "pass" }
			: { text: "FAIL", cls: "fail" };
	}
	if (report.measurement?.status === "ERROR") {
		return { text: "MEASUREMENT FAILED", cls: "fail" };
	}
	if (report.gate) {
		return { text: "PENDING", cls: "pending" };
	}
	return { text: "NO GATE", cls: "pending" };
}

/**
 * Print-CSS evidence document. Self-contained (inline CSS, no assets), A4
 * margins via @page, table page-break rules — browser print-to-PDF IS the
 * PDF export. Kept deliberately monochrome-safe: the verdict is words and a
 * border, not a color that dies on a grayscale printer.
 */
function reportHtml(report: Report): string {
	const badge = verdictBadge(report);
	const rows = report.renditions
		.map(
			(r) => `<tr>
<td>${esc(r.rendition)}${r.variant ? ` <span class="muted">(${esc(r.variant)})</span>` : ""}${
				r.label !== r.rendition
					? ` <span class="muted">${esc(r.label)}</span>`
					: ""
			}</td>
<td class="num">${num(r.height) ?? "—"}</td>
<td class="num">${num(r.bitrate) ? Math.round((num(r.bitrate) as number) / 1000) : "—"}</td>
<td class="num">${r.upscale === null ? "—" : `${r.upscale}×`}</td>
<td class="num">${r.pooled.mean ?? "—"}</td>
<td class="num">${r.pooled.harmonicMean ?? "—"}</td>
<td class="num">${r.pooled.low1Percent ?? "—"}</td>
<td class="num">${r.pooled.min ?? "—"}</td>
<td class="num">${r.pooled.psnrMean ?? "—"}</td>
</tr>`,
		)
		.join("\n");
	const ruleRows = (report.verdict?.ruleResults ?? [])
		.flatMap((ruleResult, ruleIndex) =>
			ruleResult.actuals.map(
				(actual) => `<tr>
<td class="num">${ruleIndex + 1}</td>
<td>${esc(ruleResult.rule.metric)}</td>
<td>${esc(ruleResult.rule.scope)}</td>
<td class="num">≥ ${num(ruleResult.rule.gte) ?? esc(String(ruleResult.rule.gte))}</td>
<td>${esc(actual.rendition)}${actual.variant ? ` <span class="muted">(${esc(actual.variant)})</span>` : ""}</td>
<td class="num">${num(actual.value) ?? "unmeasured"}</td>
<td class="${actual.pass ? "pass" : "fail"}">${actual.pass ? "pass" : "FAIL"}</td>
</tr>`,
			),
		)
		.join("\n");
	const reference = report.measurement?.reference;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>QC report — ${esc(report.job.name)}</title>
<style>
@page { size: A4; margin: 18mm; }
* { box-sizing: border-box; }
body { font: 13px/1.5 -apple-system, "Segoe UI", sans-serif; color: #111; margin: 0; }
h1 { font-size: 20px; margin: 0 0 2px; }
h2 { font-size: 14px; margin: 24px 0 6px; border-bottom: 1px solid #999; padding-bottom: 2px; }
table { border-collapse: collapse; width: 100%; page-break-inside: avoid; }
th, td { border: 1px solid #bbb; padding: 4px 8px; text-align: left; }
th { background: #f0f0f0; font-weight: 600; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.muted { color: #666; font-size: 11px; }
.badge { display: inline-block; border: 2px solid #111; padding: 2px 12px; font-weight: 700; letter-spacing: 0.06em; }
.badge.fail { border-style: double; }
.pass { color: #0a6b31; font-weight: 600; }
.fail { color: #a11212; font-weight: 700; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 8px 0; }
dt { color: #555; }
dd { margin: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
footer { margin-top: 28px; color: #666; font-size: 11px; }
</style>
</head>
<body>
<h1>QC evidence report</h1>
<p class="muted">${esc(report.job.name)}</p>
<p><span class="badge ${badge.cls}">${badge.text}</span></p>
<h2>Job</h2>
<dl>
<dt>Encoding job</dt><dd>${esc(report.job.id)}</dd>
<dt>Status</dt><dd>${esc(report.job.status)}${report.job.error ? ` — ${esc(report.job.error)}` : ""}</dd>
<dt>Created</dt><dd>${esc(report.job.createdAt)}</dd>
<dt>Encoder version</dt><dd>${esc(report.encoderVersion)}</dd>
<dt>Plan digest (sha256)</dt><dd>${esc(report.planSha256)}</dd>
${
	report.overridden
		? `<dt>Override</dt><dd>${
				report.verdict
					? "Delivery was forced despite a failing gate"
					: "Delivery was forced without a gate verdict (the measurement never completed)"
			}${report.overriddenAt ? ` — ${esc(report.overriddenAt)}` : ""}</dd>`
		: ""
}
</dl>
<h2>Measurement${report.verdictEvidence === "MEASUREMENT" ? " (gate evidence)" : ""}</h2>
${
	report.verdictEvidence === "MEASUREMENT"
		? ""
		: report.verdictEvidence === "ORPHANED"
			? '<p class="fail">The stored verdict\'s measurement no longer exists, so the numbers below are NOT the evidence it was based on. Treat the verdict as unsupported.</p>'
			: '<p class="muted">No gate verdict was produced, so the measurement below is informational.</p>'
}
${
	report.measurement
		? `<dl>
<dt>VMAF model</dt><dd>${esc(report.measurement.model)}</dd>
<dt>Scoring generation</dt><dd>${report.measurement.scoringVersion}</dd>
<dt>Reference</dt><dd>${
				num(reference?.width) && num(reference?.height)
					? `${num(reference?.width)}×${num(reference?.height)}`
					: "unknown"
			}</dd>
<dt>Run profile</dt><dd>${report.measurement.cores ?? "?"} cores · ${report.measurement.threads ?? "?"} threads · concurrency ${report.measurement.concurrency ?? "?"}</dd>
${report.measurement.error ? `<dt>Measurement error</dt><dd class="fail">${esc(report.measurement.error)}</dd>` : ""}
</dl>`
		: '<p class="muted">No measurement exists for this job.</p>'
}
<h2>Per-rendition pooled metrics</h2>
${
	report.renditions.length > 0
		? `<table>
<thead><tr><th>Rendition</th><th class="num">Height</th><th class="num">kbps</th><th class="num">Upscale</th><th class="num">VMAF mean</th><th class="num">Harmonic</th><th class="num">1% low</th><th class="num">Min</th><th class="num">PSNR</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="muted">Upscale = reference height ÷ rendition height. A heavily upscaled rung scores low by construction — read its numbers beside that factor, not alone.</p>`
		: '<p class="muted">No pooled results were persisted.</p>'
}
<h2>Gate outcome</h2>
${
	report.verdict
		? `<table>
<thead><tr><th class="num">Rule</th><th>Metric</th><th>Scope</th><th class="num">Threshold</th><th>Target</th><th class="num">Actual</th><th>Result</th></tr></thead>
<tbody>
${ruleRows}
</tbody>
</table>`
		: report.gate
			? '<p class="muted">The gate has no verdict yet (measurement pending or failed).</p>'
			: '<p class="muted">This plan carries no QC gate; the measurement above is informational.</p>'
}
<h2>Other measurement runs</h2>
${
	report.otherRuns.length > 0
		? `<p class="muted">These runs are NOT this gate's evidence. A manual lab re-run's status says nothing about the verdict above — the two used to be printed as one block, which is what this section exists to prevent.</p>
<table>
<thead><tr><th>Run</th><th>Started</th><th>Status</th><th>Gate run?</th><th>Error</th></tr></thead>
<tbody>
${report.otherRuns
	.map(
		(run) =>
			`<tr><td>${esc(run.vmafJobId)}</td><td>${esc(run.createdAt)}</td><td class="${run.status === "ERROR" ? "fail" : ""}">${esc(run.status)}</td><td>${run.carriedGateVerdict ? "yes" : "no"}</td><td class="${run.error ? "fail" : ""}">${run.error ? esc(run.error) : "—"}</td></tr>`,
	)
	.join("\n")}
</tbody>
</table>${
				report.otherRunsTruncated
					? `\n<p class="fail">Only the ${OTHER_RUNS_LIMIT} most recent other runs are listed — this job has more. The count above is a floor, not a total.</p>`
					: ""
			}`
		: '<p class="muted">This job has exactly one measurement run.</p>'
}
<footer>Report for encoding job ${esc(report.job.id)} · plan sha256 ${esc(report.planSha256.slice(0, 16))}… · verdict evidence ${esc(report.verdictEvidence)}</footer>
</body>
</html>`;
}
