import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "./schema";
import { validatePlan } from "./validate";

/**
 * PLAN_QC_IO_NOT_READABLE.
 *
 * The defect was a BILLED one: `qc.vmaf` on an Akamai Object Storage plan
 * compiled, ran, and was invoiced before the measurement worker refused the
 * output kind it could never have read. These arms hold the rail to the two
 * things that make it worth having — it fires on every kind the worker cannot
 * stream, and it does NOT fire on a plan that merely DECLARES an unreadable
 * output while its QC mirror lands somewhere readable.
 */

const CRED = "00000000-0000-4000-8000-00000000000";

const OUTPUTS = {
	S3: { kind: "S3", credentialId: `${CRED}2`, bucket: "b" },
	AZURE: { kind: "AZURE", credentialId: `${CRED}2`, container: "c" },
	// Host/keys resolve from the credential at execution (C10), so the OUTPUT
	// carries no host — the field the first cut of this test invented.
	GENERIC_S3: { kind: "GENERIC_S3", credentialId: `${CRED}2`, bucket: "b" },
	GCS: { kind: "GCS", credentialId: `${CRED}2`, bucket: "b" },
	GCS_SERVICE_ACCOUNT: {
		kind: "GCS_SERVICE_ACCOUNT",
		credentialId: `${CRED}2`,
		bucket: "b",
	},
	SFTP: { kind: "SFTP", credentialId: `${CRED}2` },
} as const;

const INPUTS = {
	S3: { kind: "S3", credentialId: `${CRED}1`, bucket: "b" },
	// Credential-less by schema: a public source host, so there is nothing to
	// sign a GET with. The one input kind that is unreadable for scoring.
	HTTPS: { kind: "HTTPS", host: "cdn.example.com" },
} as const;

function issuesFor(opts: {
	output: keyof typeof OUTPUTS;
	input?: keyof typeof INPUTS;
	qc?: Record<string, unknown>;
	extraOutput?: keyof typeof OUTPUTS;
	demoteQcIoReadable?: boolean;
	/** Two video renditions sharing ONE input and ONE output. */
	twoRenditions?: boolean;
}) {
	const outputs: Record<string, unknown>[] = [
		{ key: "out", ...OUTPUTS[opts.output] },
	];
	if (opts.extraOutput) {
		outputs.push({ key: "spare", ...OUTPUTS[opts.extraOutput] });
	}
	const plan = encodingPlanSchema.parse({
		planVersion: 1,
		name: "qc-io",
		bitmovin: {},
		inputs: [{ key: "in", ...INPUTS[opts.input ?? "S3"] }],
		outputs,
		ingest: [
			{
				key: "video",
				inputKey: "in",
				inputPath: "a.mp4",
				selectionMode: "VIDEO_RELATIVE",
			},
		],
		renditions: [
			{
				key: "v",
				codec: "H264",
				ingestKey: "video",
				height: 360,
				bitrate: 300000,
			},
			...(opts.twoRenditions
				? [
						{
							key: "v2",
							codec: "H264",
							ingestKey: "video",
							height: 720,
							bitrate: 900000,
						},
					]
				: []),
		],
		muxings: [
			{
				key: "v",
				kind: "FMP4",
				streamKey: "v",
				destination: { outputKey: "out", path: "x/360p" },
			},
			...(opts.twoRenditions
				? [
						{
							key: "v2",
							kind: "FMP4",
							streamKey: "v2",
							destination: { outputKey: "out", path: "x/720p" },
						},
					]
				: []),
		],
		manifests: [],
		generation: { timing: "JUST_IN_TIME" },
		qc: opts.qc ?? { vmaf: true },
	});
	return validatePlan(
		plan,
		opts.demoteQcIoReadable ? { demoteQcIoReadable: true } : {},
	);
}

const codesFor = (opts: Parameters<typeof issuesFor>[0]): string[] =>
	issuesFor(opts).map((i) => i.code);

const RAIL = "PLAN_QC_IO_NOT_READABLE";

describe("QC needs IO it can read back — before the encode is billed", () => {
	it.each([
		"S3",
		"AZURE",
	] as const)("%s is streamable, so the rail stays quiet", (output) => {
		expect(codesFor({ output })).not.toContain(RAIL);
	});

	/**
	 * The audit reported GENERIC_S3. The other two came from deriving the
	 * population out of the schema union instead of from the reported instance
	 * — same shape, same billed failure, never reported.
	 */
	it.each([
		"GENERIC_S3",
		"GCS",
		"GCS_SERVICE_ACCOUNT",
	] as const)("%s is browsable by packages/storage but was refused by the worker — the rail must NOT fire", (output) => {
		// These three ARE readable; the fix routes them. Guards the regression
		// where a narrower fix re-refuses them at plan time instead.
		expect(codesFor({ output })).not.toContain(RAIL);
	});

	it("fires when the QC mirror lands on an output nothing can GET", () => {
		const codes = codesFor({ output: "SFTP" });
		expect(codes).toContain(RAIL);
	});

	/**
	 * The scoping claim, and the arm that would catch an over-broad fix.
	 *
	 * A plan may legitimately declare an SFTP (or MSL, or NetStorage) output it
	 * delivers to, while the QC mirror rides a muxing whose destination is a
	 * bucket we can read. Rejecting on DECLARATION rather than on what the QC
	 * targets actually touch would refuse plans that work.
	 */
	it("stays quiet when an unreadable output exists but QC never touches it", () => {
		const codes = codesFor({ output: "S3", extraOutput: "SFTP" });
		expect(codes).not.toContain(RAIL);
	});

	it("stays quiet when QC is off, whatever the output is", () => {
		expect(
			codesFor({ output: "SFTP", qc: { vmaf: false, psnr: false } }),
		).not.toContain(RAIL);
	});

	/**
	 * The REFERENCE (input) half — review finding 3 (M9).
	 *
	 * Swapping the rail's `plan.inputs.find` to `plan.outputs.find` left all
	 * 2588 core tests green, because every plan here used an S3 input and the
	 * `role === "reference"` refusal was never once reached. The rail's blind
	 * spot was exactly what its own tests were pointed at — the output side.
	 * This is the arm that makes the reference lookup load-bearing.
	 */
	it("fires on the REFERENCE side when the input cannot be signed for", () => {
		const issues = issuesFor({ output: "S3", input: "HTTPS" });
		const issue = issues.find((x) => x.code === RAIL);
		expect(issue).toBeDefined();
		expect(issue?.message).toContain("reference");
		expect(issue?.message).toContain("carries no credential");
		// And it points at the reference, not at the metric toggle.
		expect(issue?.path).toBe("qc.reference");
	});

	/**
	 * SEVERITY tracks the harm — review finding 3.
	 *
	 * `error` is a hard block at every submission door (submit, re-run, watch
	 * sweep, both preset routes). Reserved for a gate, where the DELIVERY
	 * outcome depends on a number that cannot be produced. Without one, the
	 * encode is exactly what was asked for and only a measurement is lost.
	 */
	it("is a WARNING with no gate — the encode is still what was asked for", () => {
		const issue = issuesFor({ output: "SFTP" }).find((x) => x.code === RAIL);
		expect(issue?.level).toBe("warning");
		expect(issue?.message).toContain("only the measurement would fail");
	});

	it("is an ERROR when a gate makes the DELIVERY depend on the number", () => {
		const issue = issuesFor({
			output: "SFTP",
			qc: {
				vmaf: true,
				gate: {
					onFail: "BLOCK_MANIFESTS",
					rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 90 }],
				},
			},
		}).find((x) => x.code === RAIL);
		expect(issue?.level).toBe("error");
		expect(issue?.message).toContain("delivery would be marked failed");
	});

	/**
	 * The TRIGGER, both directions — review M11 and M14 both survived.
	 *
	 * M14 (trigger → `if (true)`) surviving showed the "QC is off" arm was
	 * exercising `enumerateQcTargets`'s own gate rather than the rail's, and
	 * M11 showed `qc.psnr` could be dropped from the trigger unnoticed.
	 */
	it("fires for a psnr-only plan, and points at qc.psnr", () => {
		const issue = issuesFor({
			output: "SFTP",
			qc: { vmaf: false, psnr: true },
		}).find((x) => x.code === RAIL);
		expect(issue).toBeDefined();
		expect(issue?.path).toBe("qc.psnr");
	});

	/**
	 * The RE-RUN door — review finding 3, the `skipDeliveryCommitment`
	 * precedent (#82 / review-210 C1) applied to the same shape. A rail added
	 * later must not retroactively make a FINISHED job un-re-runnable, and
	 * there is no in-app way to strip `qc` from a persisted plan.
	 */
	it("does not BLOCK a plan that was already submitted — it downgrades", () => {
		const gate = {
			vmaf: true,
			gate: {
				onFail: "BLOCK_MANIFESTS",
				rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 90 }],
			},
		};
		// Fresh submission of a gated plan: a hard block.
		expect(
			issuesFor({ output: "SFTP", qc: gate }).find((x) => x.code === RAIL)
				?.level,
		).toBe("error");
		// The same plan arriving at the re-run door: still REPORTED, no longer
		// blocking. The first cut SKIPPED it, which made the operator's second
		// click as uninformed as the first and threw away the very warning
		// finding 3 existed to preserve (review argued the downgrade; it is
		// strictly better).
		const onRerun = issuesFor({
			output: "SFTP",
			qc: gate,
			demoteQcIoReadable: true,
		}).find((x) => x.code === RAIL);
		expect(onRerun?.level).toBe("warning");
		expect(onRerun?.message).toContain("encoding output only");
	});

	/**
	 * ONE issue per IO, not one per rendition — the `seen` de-dup (review M7,
	 * which survived because nothing exercised a multi-rendition plan).
	 *
	 * Both renditions share the same unreadable output, so without the de-dup
	 * an operator sees the same sentence twice for one problem, and a
	 * three-rung ladder says it three times.
	 */
	it("reports one issue per IO, however many renditions ride it", () => {
		const hits = issuesFor({ output: "SFTP", twoRenditions: true }).filter(
			(x) => x.code === RAIL,
		);
		expect(hits).toHaveLength(1);
	});

	it("names the reason and the cost, not just 'unsupported'", () => {
		const issue = issuesFor({ output: "SFTP" }).find((x) => x.code === RAIL);
		expect(issue?.message).toContain("encoding output only");
		expect(issue?.message).toContain("bill");
	});
});
