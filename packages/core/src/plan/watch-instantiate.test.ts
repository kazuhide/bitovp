import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { providersForIoKind } from "../credentials/io-kind-providers";
import { compilePlan } from "./compiler";
import { planInputSchema } from "./schema";
import {
	instantiateWatchPlan,
	isWatchSubstitutableInputKind,
	renderWatchOutputPrefix,
	watchSelfIntersectionIssues,
	watchTemplateIssues,
} from "./watch-instantiate";

/**
 *  PR2 — instantiation over a REAL golden preset body (the
 * ladder-panel lesson): substitution targets, the structural destination
 * rebase (every outputKey+path shape in the plan, not an enumerated
 * list), template rendering, and the exactly-one-input refusal.
 */

const TEMPLATE = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"__fixtures__/fixed-bitrate-dash-hls-streamcondition-on-aws.plan.json",
		),
		"utf8",
	),
) as Record<string, unknown> & {
	bitmovin: Record<string, unknown>;
	inputs: unknown[];
};
// Presets carry account-less bodies; instantiation must survive that and
// the submit pipeline later refuses account-less plans on its own.
const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000ab";
TEMPLATE.bitmovin = { ...TEMPLATE.bitmovin, accountId: ACCOUNT_ID };

const RULE = {
	name: "mezzanine-drop",
	bucket: "customer-hot-folder",
	credentialId: "00000000-0000-4000-8000-0000000000cd",
	outputPrefixTemplate: "watch/{rule}/{date}/{basename}-{uuid}",
	labels: ["mezz"],
};
const NOW = new Date("2026-08-13T12:00:00Z");
const UUID = "0f0f0f0f";

function instantiate(objectKey = "drops/show-101.mp4") {
	return instantiateWatchPlan({
		presetBody: TEMPLATE,
		objectKey,
		rule: RULE,
		now: NOW,
		uuid: UUID,
	});
}

describe("renderWatchOutputPrefix", () => {
	it("renders every documented token", () => {
		expect(
			renderWatchOutputPrefix("out/{rule}/{date}/{basename}.{ext}/{uuid}", {
				objectKey: "a/b/Show.Episode.MXF",
				ruleName: "r1",
				now: NOW,
				uuid: "u-1",
			}),
		).toBe("out/r1/2026-08-13/Show.Episode.mxf/u-1");
	});

	it("an extensionless key keeps its whole name and an empty ext", () => {
		expect(
			renderWatchOutputPrefix("{basename}/{ext}", {
				objectKey: "raw/master",
				ruleName: "r",
				now: NOW,
				uuid: "u",
			}),
		).toBe("master");
	});
});

describe("instantiateWatchPlan", () => {
	it("substitutes the input, every ingest path, the name and the labels", () => {
		const result = instantiate();
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.plan.inputs[0]).toMatchObject({
			bucket: "customer-hot-folder",
			credentialId: RULE.credentialId,
		});
		for (const stream of result.plan.ingest) {
			expect(stream.inputPath).toBe("drops/show-101.mp4");
		}
		expect(result.plan.name).toBe("show-101.mp4");
		expect(result.plan.bitmovin.labels).toEqual([
			"mezz",
			"watch:mezzanine-drop",
		]);
	});

	it("REBASES every destination path under the rendered prefix — structurally", () => {
		const result = instantiate();
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const prefix = `watch/mezzanine-drop/2026-08-13/show-101-${UUID}`;
		expect(result.outputPrefix).toBe(prefix);
		// Walk the INSTANTIATED plan the same structural way and demand
		// every destination now starts with the prefix — zero exceptions,
		// so a site the rebase missed fails here by construction.
		const destinations: string[] = [];
		const walk = (node: unknown) => {
			if (Array.isArray(node)) {
				for (const item of node) {
					walk(item);
				}
				return;
			}
			if (typeof node !== "object" || node === null) {
				return;
			}
			const record = node as Record<string, unknown>;
			if (
				typeof record.outputKey === "string" &&
				typeof record.path === "string"
			) {
				destinations.push(record.path);
			}
			for (const value of Object.values(record)) {
				walk(value);
			}
		};
		walk(result.plan);
		expect(destinations.length).toBeGreaterThan(2);
		for (const path of destinations) {
			expect(path.startsWith(`${prefix}/`)).toBe(true);
		}
	});

	it("the instantiated plan COMPILES — substitution cannot mint a dud", () => {
		const result = instantiate();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(compilePlan(result.plan).length).toBeGreaterThan(5);
		}
	});

	it("a changed object key changes ONLY the expected fields", () => {
		const a = instantiate("drops/a.mp4");
		const b = instantiate("drops/b.mp4");
		if (!(a.ok && b.ok)) {
			throw new Error("both must instantiate");
		}
		expect(a.plan.name).toBe("a.mp4");
		expect(b.plan.name).toBe("b.mp4");
		expect(a.plan.ingest[0]?.inputPath).toBe("drops/a.mp4");
		expect(b.plan.ingest[0]?.inputPath).toBe("drops/b.mp4");
	});

	it("refuses a multi-input template (no unambiguous substitution target)", () => {
		const twoInputs = {
			...TEMPLATE,
			inputs: [
				...(TEMPLATE.inputs as object[]),
				{
					key: "second",
					kind: "S3",
					credentialId: RULE.credentialId,
					bucket: "other",
				},
			],
		};
		const issues = watchTemplateIssues(twoInputs);
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({ code: "INPUT_COUNT" });
		const result = instantiateWatchPlan({
			presetBody: twoInputs,
			objectKey: "x.mp4",
			rule: RULE,
			now: NOW,
			uuid: UUID,
		});
		expect(result.ok).toBe(false);
	});

	it("refuses a non-plan body", () => {
		expect(watchTemplateIssues({ nope: 1 })).toMatchObject([
			{ code: "NOT_A_PLAN" },
		]);
	});
});

/**
 * Audit f63f76b F63-RUN-002 — a rule whose preset writes back into the folder
 * it watches. The sweep enumerates the watched prefix recursively, so the
 * encoder's own outputs are discovered as new sources and encoded again; the
 * uniquifying token in outputPrefixTemplate means each generation gets a fresh
 * prefix, so nothing overwrites and the loop multiplies instead of converging.
 * Every generation is billable and nothing bounded the total.
 */
describe("watchSelfIntersectionIssues", () => {
	const outBucket = (plan: Record<string, unknown>, patch: object) => ({
		...plan,
		outputs: (plan.outputs as Record<string, unknown>[]).map((o) => ({
			...o,
			...patch,
		})),
	});

	it("refuses outputs that land in the watched bucket under the watched prefix", () => {
		const rule = {
			credentialId: RULE.credentialId,
			bucket: RULE.bucket,
			prefix: "drops",
			outputPrefixTemplate: "drops/out/{basename}-{uuid}",
		};
		const preset = outBucket(TEMPLATE, {
			credentialId: RULE.credentialId,
			bucket: RULE.bucket,
		});
		const issues = watchSelfIntersectionIssues(preset, rule);
		expect(issues.length).toBeGreaterThan(0);
		expect(issues[0]).toMatchObject({ code: "SELF_INTERSECTION" });
	});

	it("refuses when the WATCHED prefix sits under the output head — the token tail can render into it", () => {
		// rule prefix `out/x/`, template `out/{basename}/` → `out/x/…` is a
		// reachable rendering, so this direction is an overlap too.
		const issues = watchSelfIntersectionIssues(
			outBucket(TEMPLATE, {
				credentialId: RULE.credentialId,
				bucket: RULE.bucket,
			}),
			{
				credentialId: RULE.credentialId,
				bucket: RULE.bucket,
				prefix: "out/x",
				outputPrefixTemplate: "out/{basename}-{uuid}",
			},
		);
		expect(issues[0]).toMatchObject({ code: "SELF_INTERSECTION" });
	});

	it("refuses an empty watched prefix against any output in the same bucket", () => {
		// prefix "" watches the WHOLE bucket, so any output into it loops.
		const issues = watchSelfIntersectionIssues(
			outBucket(TEMPLATE, {
				credentialId: RULE.credentialId,
				bucket: RULE.bucket,
			}),
			{
				credentialId: RULE.credentialId,
				bucket: RULE.bucket,
				prefix: "",
				outputPrefixTemplate: "anywhere/{uuid}",
			},
		);
		expect(issues[0]).toMatchObject({ code: "SELF_INTERSECTION" });
	});

	it("REFUSES the same bucket under a different credential — one bucket, two keys", () => {
		/**
		 * This case shipped ALLOWED, pinned by the test below reasoning "a
		 * different account". Review-299 refuted it: S3/GCS/GenericS3 bucket
		 * names are GLOBALLY unique, so the same name is the same bucket whoever
		 * opens it, and two credential rows on one bucket is ordinary practice —
		 * a read-only scan credential beside a write credential, a key rotation,
		 * two IAM users. There is no different account here, only a different key
		 * to the same door, and the loop runs exactly the same through it.
		 */
		const issues = watchSelfIntersectionIssues(
			outBucket(TEMPLATE, {
				credentialId: "00000000-0000-4000-8000-00000000beef",
				bucket: RULE.bucket,
			}),
			{
				credentialId: RULE.credentialId,
				bucket: RULE.bucket,
				prefix: "",
				outputPrefixTemplate: "anywhere/{uuid}",
			},
		);
		expect(issues[0]).toMatchObject({ code: "SELF_INTERSECTION" });
	});

	it("allows a different bucket and a disjoint prefix", () => {
		const base = {
			credentialId: RULE.credentialId,
			bucket: RULE.bucket,
			prefix: "incoming",
			outputPrefixTemplate: "outgoing/{basename}-{uuid}",
		};
		// Disjoint prefix in the SAME bucket is fine — this is the normal
		// hot-folder layout and must not be refused.
		expect(
			watchSelfIntersectionIssues(
				outBucket(TEMPLATE, {
					credentialId: RULE.credentialId,
					bucket: RULE.bucket,
				}),
				base,
			),
		).toEqual([]);
		// Same prefix, DIFFERENT bucket.
		expect(
			watchSelfIntersectionIssues(
				outBucket(TEMPLATE, {
					credentialId: RULE.credentialId,
					bucket: "somewhere-else",
				}),
				{ ...base, outputPrefixTemplate: "incoming/{uuid}" },
			),
		).toEqual([]);
		// A different bucket under a different credential is still fine — the
		// credential is not what makes it safe, the bucket name is.
		expect(
			watchSelfIntersectionIssues(
				outBucket(TEMPLATE, {
					credentialId: "00000000-0000-4000-8000-00000000beef",
					bucket: "somewhere-else",
				}),
				{ ...base, outputPrefixTemplate: "incoming/{uuid}" },
			),
		).toEqual([]);
	});

	it("does not prefix-match a sibling folder", () => {
		// `out` must not match `outtakes/` — directory semantics, not substring.
		expect(
			watchSelfIntersectionIssues(
				outBucket(TEMPLATE, {
					credentialId: RULE.credentialId,
					bucket: RULE.bucket,
				}),
				{
					credentialId: RULE.credentialId,
					bucket: RULE.bucket,
					prefix: "out",
					outputPrefixTemplate: "outtakes/{uuid}",
				},
			),
		).toEqual([]);
	});

	it("leaves NOT_A_PLAN to watchTemplateIssues rather than double-reporting", () => {
		expect(
			watchSelfIntersectionIssues(
				{ nope: 1 },
				{
					credentialId: RULE.credentialId,
					bucket: RULE.bucket,
					prefix: "",
					outputPrefixTemplate: "{uuid}",
				},
			),
		).toEqual([]);
	});
});

/**
 * Audit AA972-WATCH-001. A rule could be saved whose template input kind
 * substitution cannot target, or whose credential cannot back that kind.
 * Nothing said so at folder-configuration time: the object was claimed
 * (STABLE → SUBMITTED) and then failed, per object, with the reason buried in
 * an instantiate error or a worker credential mapping.
 */
describe("watch template compatibility", () => {
	const KINDS = [
		"S3",
		"HTTPS",
		"AKAMAI_NETSTORAGE",
		"AZURE",
		"GENERIC_S3",
		"GCS",
		"GCS_SERVICE_ACCOUNT",
	];

	/** Swap the template's sole input for one of `kind`, keeping it parseable. */
	function templateWithInput(kind: string): Record<string, unknown> {
		const base = {
			key: (TEMPLATE.inputs[0] as { key: string }).key,
			kind,
			name: "probe",
		};
		const shaped: Record<string, unknown> =
			kind === "HTTPS"
				? { ...base, host: "example.com" }
				: kind === "AKAMAI_NETSTORAGE"
					? { ...base, credentialId: RULE.credentialId }
					: kind === "AZURE"
						? { ...base, credentialId: RULE.credentialId, container: "c" }
						: { ...base, credentialId: RULE.credentialId, bucket: "b" };
		return { ...TEMPLATE, inputs: [shaped] };
	}

	it("agrees with what substitution can ACTUALLY produce", () => {
		/**
		 * Two instruments, and the second must NOT route through the first.
		 *
		 * The original compared the probe against `instantiateWatchPlan`, which
		 * calls `watchTemplateIssues`, which calls the probe — so
		 * `byReality ⊆ byProbe` held by construction and only false-ACCEPTS were
		 * detectable. Review proved it: mutating the probe to reject S3 and then
		 * neutralising the literal pin below left this assertion passing.
		 *
		 * The reality arm now replicates what substitution does to the input —
		 * spread the template's own input, overwrite `bucket` and
		 * `credentialId`, parse against `planInputSchema` — without consulting
		 * the guard at all, so a false-REJECT diverges too.
		 */
		const byProbe: string[] = [];
		const byReality: string[] = [];
		for (const kind of KINDS) {
			if (isWatchSubstitutableInputKind(kind)) {
				byProbe.push(kind);
			}
			const template = templateWithInput(kind);
			const soleInput = (template.inputs as Record<string, unknown>[])[0];
			const substituted = {
				...soleInput,
				bucket: RULE.bucket,
				credentialId: RULE.credentialId,
			};
			if (planInputSchema.safeParse(substituted).success) {
				byReality.push(kind);
			}
		}
		expect(byProbe).toEqual(["S3", "GENERIC_S3", "GCS", "GCS_SERVICE_ACCOUNT"]);
		expect(byReality).toEqual(byProbe);
	});

	it("and the end-to-end path agrees with both", () => {
		// Kept separate so the comparison above stays independent: this one DOES
		// go through the guard, and catches a substitution that breaks for a
		// reason the input shape alone cannot express.
		const ok = KINDS.filter(
			(kind) =>
				instantiateWatchPlan({
					presetBody: templateWithInput(kind),
					objectKey: "drops/a.mp4",
					rule: RULE,
					now: NOW,
					uuid: UUID,
				}).ok,
		);
		expect(ok).toEqual(["S3", "GENERIC_S3", "GCS", "GCS_SERVICE_ACCOUNT"]);
	});

	it("refuses the three kinds substitution cannot target, at SAVE time", () => {
		for (const kind of ["HTTPS", "AKAMAI_NETSTORAGE", "AZURE"]) {
			const issues = watchTemplateIssues(templateWithInput(kind));
			expect(issues.map((i) => i.code)).toContain("INPUT_KIND");
		}
	});

	it("refuses a credential whose provider cannot back the input kind", () => {
		const issues = watchTemplateIssues(templateWithInput("S3"), {
			credentialProvider: "AZURE_BLOB",
		});
		expect(issues.map((i) => i.code)).toEqual(["CREDENTIAL_PROVIDER"]);
		expect(issues[0]?.message).toContain("AWS_S3");
	});

	it("accepts each substitutable kind with each provider that CAN back it", () => {
		// The accept side, over the whole cross product — a guard that refused
		// everything would pass the two arms above.
		for (const kind of ["S3", "GENERIC_S3", "GCS", "GCS_SERVICE_ACCOUNT"]) {
			for (const provider of providersForIoKind(kind) ?? []) {
				expect(
					watchTemplateIssues(templateWithInput(kind), {
						credentialProvider: provider,
					}),
				).toEqual([]);
			}
		}
	});

	it("says nothing about the provider when the caller could not resolve one", () => {
		// Same rule the deployment profile's provider half follows: an unknown
		// capability must not manufacture a refusal.
		expect(watchTemplateIssues(templateWithInput("S3"))).toEqual([]);
	});
});
