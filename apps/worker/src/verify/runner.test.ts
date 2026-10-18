import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	collectDestinationPaths,
	compileExpectedArtefacts,
	DEFAULT_VMAF_MODEL,
	encodingPlanSchema,
} from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { BitmovinCallError } from "../orchestrator/ops/shared";
import { ensureTerminal, resumeEligibility } from "./harness-rails";
import { capabilitiesFor, sourcesOf } from "./preflight";
import type { RunReport } from "./runner";
import {
	breakerTripReason,
	cancelAndStopVerificationEncodings,
	collectRunFingerprint,
	encodingIsGone,
	failedJobOutcome,
	formatRunReport,
	loadResumePasses,
	memoizeSuccessfulAsync,
	mergeVerificationProviderResources,
	paidLiveRewrite,
	planIdentitySha256,
	planSourceIdentity,
	providerWord,
	readVerificationProviderEncodingStatus,
	resolveLiveVerificationIntentCleanup,
	rewriteForRun,
	stopAndReadLiveVerificationProviders,
	verificationProviderDiscoveryStability,
	vodIntentResourceSets,
} from "./runner";
import { prepareLiveScenarioForRun, runLiveScenario } from "./runner-live";

describe("paid live encoder version wiring", () => {
	it.each([
		"2.285.0",
		undefined,
	])("forwards %s through the paid create and agrees with dry preparation", async (liveEncoderVersion) => {
		const plan = JSON.parse(
			readFileSync(
				join(
					import.meta.dirname,
					"../../../../packages/core/src/live/__fixtures__/live-static-ingest.plan.json",
				),
				"utf8",
			),
		);
		const rewrite = paidLiveRewrite(
			{
				runId: "version-regression",
				outputBucket: "verify-out",
				liveEncoderVersion,
			},
			"live-static-ingest",
			{
				bitmovinAccountId: "33333333-3333-4333-8333-333333333333",
				credentialId: "22222222-2222-4222-8222-222222222222",
			},
		);
		const api = vi.fn(async () => ({
			status: 400,
			json: { error: "stop at create boundary" },
		}));
		await runLiveScenario(
			{
				api,
				readText: async () => "",
				listAll: async () => [],
				sleep: async () => {},
				now: () => 0,
			},
			{
				plan,
				scenario: "live-static-ingest",
				rewrite,
				feedSeconds: 45,
				startTimeoutSec: 60,
			},
		);
		expect(api).toHaveBeenCalledTimes(1);
		const call = api.mock.calls[0] as unknown as [
			string,
			{
				method: string;
				body: { plan: { bitmovin: { encoderVersion: string } } };
			},
		];
		expect(call[0]).toBe("/api/live-channels");
		expect(call[1].method).toBe("POST");
		expect(call[1].body.plan.bitmovin.encoderVersion).toBe(
			liveEncoderVersion ?? "STABLE",
		);
		const dry = prepareLiveScenarioForRun({
			plan,
			rewrite: {
				...rewrite,
				...(liveEncoderVersion ? { encoderVersion: liveEncoderVersion } : {}),
			},
			feedSeconds: 45,
			startTimeoutSec: 60,
		});
		expect(call[1].body.plan.bitmovin.encoderVersion).toBe(
			dry.submitted.bitmovin.encoderVersion,
		);
	});
});

/**
 * The rewrite is the runner's most dangerous function: if it points a scenario at the
 * wrong bucket or mangles a destination, every downstream check verifies the wrong
 * place and reports green. So it is exercised against the WHOLE corpus, not a sample —
 * 66 plans in, 66 valid namespaced plans out, each still compiling to expectations.
 */

const FIXTURES = join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"packages",
	"core",
	"src",
	"plan",
	"__fixtures__",
);

const CRED = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const OPTIONS = {
	credentialId: CRED,
	inputBucket: "verify-in",
	outputBucket: "verify-out",
	sourceObject: "bbb-short.mov",
	prefix: "verify/RUN1/scenario/",
	bitmovinAccountId: ACCOUNT,
};

const planFiles = readdirSync(FIXTURES)
	.filter((f) => f.endsWith(".plan.json"))
	.sort();

const plans = planFiles.map((file) => ({
	name: file.replace(".plan.json", ""),
	plan: encodingPlanSchema.parse(
		JSON.parse(readFileSync(join(FIXTURES, file), "utf8")),
	),
}));

/**
 * The corpus splits in two, and the split is the point.
 *
 * `rewriteForRun` REFUSES to point a typed source or a Dolby master at the single staged
 * mezzanine, because doing so submits an encoding that cannot succeed — REAL-VOD-4 billed for
 * seven of them. So the corpus-wide properties below run over the plans the rewrite accepts,
 * and the refusal itself is asserted separately, per fixture, with the capability named.
 *
 * Derived from the plan structure rather than a hand-kept list: a new Dolby or subtitle fixture
 * lands on the correct side of this split the day it is added.
 */
const gated = plans.filter(
	({ plan }) =>
		(plan.dolbyStreams ?? []).length > 0 ||
		(plan.fileStreams ?? []).some(
			(f) => "fileType" in f && typeof f.fileType === "string",
		),
);
const rewritable = plans.filter((p) => !gated.includes(p));

describe("rewriteForRun — over the whole corpus", () => {
	it("has a corpus to rewrite, so a broken read cannot pass over nothing", () => {
		// 70→71 on 2026-08-28: `vp9-webm-fixed-dash` (audit 893eb66 CRITICAL-2).
		// 71→72 same day: `mixed-codec-dash-hls` .
		expect(plans.length).toBe(72);
		// Both sides non-empty, or one of the two suites below is silently testing nothing.
		expect(gated.length, "fixtures the rewrite must refuse").toBe(22);
		// 48→49: `vp9-webm-fixed-dash` has a plain output prefix, so it is
		// namespaceable like every other fixed-ladder fixture.
		expect(rewritable.length, "fixtures the rewrite may namespace").toBe(50);
	});

	it("refuses every gated fixture, naming the capability that would unblock it", () => {
		for (const { name, plan } of gated) {
			let message = "";
			try {
				rewriteForRun(plan, OPTIONS);
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}
			expect(message, `${name} must be refused`).toMatch(/refusing to rewrite/);
			expect(message, `${name} must name what is missing`).toMatch(
				/DOLBY_ASSETS|TYPED_SOURCE_ASSETS/,
			);
			// And it must name the substitution it declined, or the reader cannot tell which
			// asset to stage.
			expect(message, `${name} must name the mezzanine`).toContain(
				OPTIONS.sourceObject,
			);
		}
	});

	it("produces a schema-valid plan for every fixture", () => {
		// `rewriteForRun` re-parses through encodingPlanSchema, so a throw here means a
		// rewrite that would have been submitted as an invalid plan.
		for (const { name, plan } of rewritable) {
			expect(() => rewriteForRun(plan, OPTIONS), name).not.toThrow();
		}
	});

	it("repoints S3-kind io only, and leaves other providers as authored", () => {
		/**
		 * The old assertion was "every credential is replaced", and it was WRONG — it pinned a
		 * C10 violation. `generic-s3-akamai-io` failed its first real run with
		 * `needs an Akamai/OCI/GenericS3 credential but got provider "AWS_S3"`, because the
		 * rewrite overwrote its GenericS3 credential with the S3 one. GCS and Azure would do
		 * the same the moment their capabilities are satisfied.
		 *
		 * A rewrite may only repoint a credential at one of the SAME provider family. Other
		 * kinds stay as authored and are gated by their capability — which is why the test
		 * that asserted otherwise had to change rather than the code.
		 */
		const S3 = new Set(["S3", "S3_ROLE"]);
		let repointed = 0;
		let preserved = 0;
		for (const { name, plan } of rewritable) {
			const out = rewriteForRun(plan, OPTIONS);
			for (const io of [...out.inputs, ...out.outputs]) {
				if (!("credentialId" in io)) {
					continue;
				}
				const original = [...plan.inputs, ...plan.outputs].find(
					(x) => x.key === io.key,
				);
				if (S3.has(io.kind)) {
					expect(io.credentialId, `${name}/${io.key}`).toBe(CRED);
					repointed++;
				} else {
					expect(
						io.credentialId,
						`${name}/${io.key} is ${io.kind}, so C10 forbids repointing it at an S3 credential`,
					).toBe(
						(original as { credentialId?: string } | undefined)?.credentialId,
					);
					preserved++;
				}
			}
		}
		// Both populations must be non-empty, or this asserts nothing about the distinction.
		expect(repointed, "S3-kind io repointed").toBeGreaterThan(50);
		expect(preserved, "non-S3 io left alone").toBeGreaterThan(0);
	});

	const GCS_TARGET = {
		inputCredentialId: "44444444-4444-4444-8444-444444444444",
		outputCredentialId: "55555555-5555-4555-8555-555555555555",
		inputBucket: "gcs-in",
		outputBucket: "gcs-out",
	};

	it("repoints a GCS-kind OUTPUT (its OWN direction), S3 sibling unaffected (ledger #90)", () => {
		// multi-output-s3-gcs's GCS MIRROR kept the fixture placeholder credential and failed
		// its real run with "Storage credential no longer exists" — the exact omission the
		// GenericS3 comment predicted for GCS. WITHOUT a gcs target it stays as authored (the
		// S3-only test above); WITH one it repoints, like every other family. Distinct in/out
		// ids pin the OUTPUT to its OWN direction (review-290 Sug3), so a direction swap reds.
		const mixed = plans.find((p) => p.name === "multi-output-s3-gcs");
		expect(mixed, "multi-output-s3-gcs fixture present").toBeDefined();
		const out = rewriteForRun((mixed as (typeof plans)[number]).plan, {
			...OPTIONS,
			gcs: GCS_TARGET,
		});
		const gcsOut = out.outputs.find((o) => o.kind === "GCS") as
			| { credentialId?: string; bucket?: string }
			| undefined;
		// The OUTPUT direction's credential, not the input one.
		expect(gcsOut?.credentialId, "GCS output → outputCredentialId").toBe(
			GCS_TARGET.outputCredentialId,
		);
		expect(gcsOut?.bucket, "GCS output bucket repointed").toBe("gcs-out");
		// The S3 sibling in the SAME plan still repoints to the S3 credential —
		// families are independent (this is what the placeholder bug got wrong).
		const s3Out = out.outputs.find((o) => o.kind === "S3") as
			| { credentialId?: string }
			| undefined;
		expect(s3Out?.credentialId, "S3 sibling still repointed").toBe(CRED);
	});

	it("does NOT repoint a GCS_SERVICE_ACCOUNT io even with a GCS target — kind is exact (review-290 I2)", () => {
		// The C10-class failure this whole comment lineage exists to prevent: a GCS target must
		// touch ONLY the HMAC `GCS` family, never `GCS_SERVICE_ACCOUNT`. gcs-service-account-io
		// is GCS_SERVICE_ACCOUNT in/out; with a gcs target present, every io must keep its
		// AUTHORED credential and bucket, or it would die at exec-io.ts's provider assert.
		const sa = plans.find((p) => p.name === "gcs-service-account-io");
		expect(sa, "gcs-service-account-io fixture present").toBeDefined();
		const plan = (sa as (typeof plans)[number]).plan;
		const out = rewriteForRun(plan, { ...OPTIONS, gcs: GCS_TARGET });
		const authored = new Map(
			[...plan.inputs, ...plan.outputs].map((io) => [
				io.key,
				io as { credentialId?: string; bucket?: string },
			]),
		);
		let checked = 0;
		for (const io of [...out.inputs, ...out.outputs] as {
			key: string;
			kind: string;
			credentialId?: string;
			bucket?: string;
		}[]) {
			const orig = authored.get(io.key);
			expect(
				io.credentialId,
				`${io.key} (${io.kind}) credential as authored`,
			).toBe(orig?.credentialId);
			expect(io.bucket, `${io.key} (${io.kind}) bucket as authored`).toBe(
				orig?.bucket,
			);
			checked++;
		}
		expect(checked, "gcs-service-account-io has io to check").toBeGreaterThan(
			0,
		);
	});

	it("repoints buckets for S3 kinds only", () => {
		for (const { name, plan } of rewritable) {
			const out = rewriteForRun(plan, OPTIONS);
			for (const io of [...out.inputs, ...out.outputs]) {
				if (!("bucket" in io) || io.kind !== "S3") {
					continue;
				}
				const expected = out.inputs.some((i) => i.key === io.key)
					? "verify-in"
					: "verify-out";
				expect(io.bucket, `${name}/${io.key}`).toBe(expected);
			}
		}
	});

	it("moves EVERY destination under the run namespace — population from the structural walk, not a hand list", () => {
		// review-284 N1a: this test used to iterate the same five-key hand
		// list the implementation abandoned — its population was narrower
		// than the code's, and it skipped exactly the sites the hand list
		// had broken (aiSceneAnalysis.assetDescription and the Kantar
		// report destination wrote OUTSIDE the run namespace across runs).
		// collectDestinationPaths is the walker's own census: revert the
		// implementation to a hand list and the missed sites fail HERE.
		for (const { name, plan } of rewritable) {
			const paths = collectDestinationPaths(rewriteForRun(plan, OPTIONS));
			expect(paths.length, name).toBeGreaterThan(0);
			for (const path of paths) {
				expect(path, name).toMatch(/^verify\/RUN1\/scenario\//);
			}
		}
	});

	it("keeps the internal structure of every destination path", () => {
		// The namespace is a PREFIX, not a replacement: per-rendition folders, the
		// `{uuid}`/`{bitrate}` placeholders C4 requires, and the `qc/` suffix all have to
		// survive, or the expectations and the artefacts stop agreeing.
		for (const { name, plan } of rewritable) {
			const out = rewriteForRun(plan, OPTIONS);
			for (const [before, after] of plan.muxings.map(
				(m, i) =>
					[m.destination?.path, out.muxings[i]?.destination?.path] as const,
			)) {
				if (before === undefined || after === undefined) {
					continue;
				}
				expect(after, name).toBe(
					`verify/RUN1/scenario/${before.replace(/^\/+/, "")}`,
				);
			}
		}
	});

	it("preserves the {uuid}/{bitrate} placeholders per-title needs (C4)", () => {
		const perTitle = plans.filter(({ plan }) =>
			plan.muxings.some((m) =>
				/\{uuid\}|\{bitrate\}/.test(m.destination?.path ?? ""),
			),
		);
		// If this drops to zero the assertion has stopped testing anything.
		expect(perTitle.length).toBeGreaterThan(0);
		for (const { name, plan } of perTitle) {
			const out = rewriteForRun(plan, OPTIONS);
			const templated = out.muxings.filter((m) =>
				/\{uuid\}|\{bitrate\}/.test(m.destination?.path ?? ""),
			);
			expect(templated.length, name).toBe(
				plan.muxings.filter((m) =>
					/\{uuid\}|\{bitrate\}/.test(m.destination?.path ?? ""),
				).length,
			);
		}
	});

	it("repoints every source object", () => {
		for (const { name, plan } of rewritable) {
			const out = rewriteForRun(plan, OPTIONS);
			for (const s of out.ingest ?? []) {
				expect(s.inputPath, name).toBe("bbb-short.mov");
			}
			expect(sourcesOf(out), name).toEqual(["bbb-short.mov"]);
		}
	});

	it("still compiles to at least one expected artefact after rewriting", () => {
		/**
		 * A rewrite that quietly emptied a plan would sail through the run and report a green
		 * scenario that verified nothing at all.
		 *
		 * QC mirrors count as artefacts, because for a `qc.only` plan they are the ONLY ones:
		 * the compiler emits no delivery muxings for it by design, so `vmaf-only-h264` has zero
		 * muxings and zero manifests and one mirror MP4. Excluding it here would have been the
		 * easy move and the wrong one — it is a scenario whose artefacts exist and are checked.
		 */
		for (const { name, plan } of rewritable) {
			const out = rewriteForRun(plan, OPTIONS);
			const expected = compileExpectedArtefacts(out);
			expect(
				expected.muxings.length +
					expected.manifests.length +
					(expected.qc?.mirrors.length ?? 0),
				name,
			).toBeGreaterThan(0);
		}
	});

	it("leaves the input plan untouched", () => {
		// structuredClone, not mutation: the caller reuses the fixture for the report.
		const { plan } = plans[0] as {
			plan: ReturnType<typeof encodingPlanSchema.parse>;
		};
		const before = JSON.stringify(plan);
		rewriteForRun(plan, OPTIONS);
		expect(JSON.stringify(plan)).toBe(before);
	});

	it("does not rewrite by string substitution — a path containing the bucket name survives", () => {
		// A `JSON.stringify` + replace implementation would corrupt any path that happens
		// to contain the old bucket name. This proves the walk is structural.
		const base = plans.find(({ plan }) => plan.muxings[0]?.destination) as {
			plan: ReturnType<typeof encodingPlanSchema.parse>;
		};
		const tricky = structuredClone(base.plan);
		const dest = tricky.muxings[0]?.destination;
		if (dest) {
			dest.path = "output/ap-northeast-1-output-archive/video/";
		}
		const out = rewriteForRun(tricky, OPTIONS);
		expect(out.muxings[0]?.destination?.path).toBe(
			"verify/RUN1/scenario/output/ap-northeast-1-output-archive/video/",
		);
	});
});

describe("capabilitiesFor — derived from the plan, never the filename", () => {
	it("classifies every fixture without throwing", () => {
		for (const { name, plan } of rewritable) {
			expect(() => capabilitiesFor(plan, name), name).not.toThrow();
		}
	});

	it("requires AKAMAI for the GENERIC_S3 fixture and a SERVICE ACCOUNT for the GCS one", () => {
		const akamai = plans.find((p) => p.name === "generic-s3-akamai-io");
		const gcs = plans.find((p) => p.name === "gcs-service-account-io");
		expect(akamai && capabilitiesFor(akamai.plan, akamai.name)).toContain(
			"AKAMAI",
		);
		// Not `GCS`: the registered GCS credentials are HMAC and cannot satisfy a
		// service-account plan, so collapsing the two counted this scenario runnable when
		// it is not. `preflight.test.ts` owns the full statement of that.
		expect(gcs && capabilitiesFor(gcs.plan, gcs.name)).toContain(
			"GCS_SERVICE_ACCOUNT",
		);
	});

	it("puts every dolby fixture with placeholder sources behind DOLBY_ASSETS", () => {
		const dolby = plans.filter(
			({ name, plan }) =>
				/dolby/i.test(name) &&
				sourcesOf(plan).some((s) => /<INSERT|<REDACTED/i.test(s)),
		);
		expect(dolby.length).toBeGreaterThan(0);
		for (const { name, plan } of dolby) {
			expect(capabilitiesFor(plan, name), name).toContain("DOLBY_ASSETS");
		}
	});

	it("gates the SolLevante dolby fixtures too — public is not the same as staged", () => {
		/**
		 * This test used to assert the opposite, and a real run proved it wrong.
		 *
		 * It read: "does NOT gate the SolLevante dolby fixtures, whose sources are public …
		 * If this regresses, five runnable scenarios silently become SKIPs." The premise was
		 * that a publicly fetchable asset is an asset the run has — but the rewrite points
		 * every source at the ONE mezzanine the run stages, and the bootstrap that would stage
		 * the Dolby masters is deferred (DOLBY_ASSETS' own reason string says so: "the owner
		 * supplies these (design D3, deferred)").
		 *
		 * So REAL-VOD-4 ran those five as "runnable" and Bitmovin answered:
		 *
		 *   Could not find audio file reference in Dolby Atmos Master File
		 *   big_buck_bunny_1080p_h264_short.mov
		 *
		 * Five billed encodings that could not succeed, each reported as a product FAIL. The
		 * old assertion had it exactly backwards: they were never runnable, and calling them
		 * so cost money and produced a wrong verdict.
		 *
		 * The distinction it was reaching for is real, but it belongs to SATISFACTION, not to
		 * NEED. A Dolby plan needs Dolby masters whatever their provenance; whether that need
		 * is met depends on whether they are staged. Put the publicness where it can do some
		 * good — in `capabilitiesFor`'s satisfaction step, once a bootstrap actually fetches
		 * them — and these scenarios light up with no change here.
		 */
		const publicDolby = plans.filter(
			({ name, plan }) =>
				/dolby/i.test(name) &&
				sourcesOf(plan).every((s) => !/<INSERT|<REDACTED/i.test(s)),
		);
		expect(publicDolby.length).toBeGreaterThan(0);
		for (const { name, plan } of publicDolby) {
			expect(capabilitiesFor(plan, name), name).toContain("DOLBY_ASSETS");
		}
	});
});

describe("formatRunReport", () => {
	const report: RunReport = {
		runId: "RUN1",
		startedAt: "2026-08-09T00:00:00.000Z",
		finishedAt: "2026-08-09T01:00:00.000Z",
		fingerprint: {
			commit: "test",
			checkoutLatestMigration: "m",
			dbLatestMigration: "m",
			drift: false,
		},
		preflight: [],
		outcomes: [
			{ scenario: "a", verdict: "PASS", reason: "12 check(s) passed" },
			{ scenario: "b", verdict: "FAIL", reason: "muxing:x: expected | got" },
			{ scenario: "c", verdict: "SKIP", reason: "blocked by AZURE" },
			{ scenario: "d", verdict: "INVALID", reason: "harness error: boom" },
		],
		counts: { PASS: 1, WARN: 0, FAIL: 1, SKIP: 1, INVALID: 1 },
	};

	it("lists every scenario, including the skipped and the invalid", () => {
		const md = formatRunReport(report);
		for (const name of ["a", "b", "c", "d"]) {
			expect(md).toContain(`| ${name} |`);
		}
	});

	it("escapes a pipe in a reason so the table cannot be broken by a detail", () => {
		expect(formatRunReport(report)).toContain("muxing:x: expected \\| got");
	});

	it("states that a SKIP names its resource and an INVALID is not product-green", () => {
		const md = formatRunReport(report);
		expect(md).toContain("names the resource");
		expect(md).toContain("never product-green");
	});
});

describe("run report honesty", () => {
	it("never emits a SKIP whose reason is empty or trails an empty list", () => {
		// The first real run printed "blocked by " for scenarios excluded by --only:
		// useless, and untrue, since a filter is not a missing resource. This pins the
		// promise the design makes — every SKIP names what would open it.
		const report: RunReport = {
			runId: "R",
			startedAt: "a",
			finishedAt: "b",
			fingerprint: {
				commit: "test",
				checkoutLatestMigration: "m",
				dbLatestMigration: "m",
				drift: false,
			},
			preflight: [],
			outcomes: [
				{ scenario: "x", verdict: "SKIP", reason: "not selected by --only y" },
				{ scenario: "y", verdict: "PASS", reason: "3 check(s) passed" },
			],
			counts: { PASS: 1, WARN: 0, FAIL: 0, SKIP: 1, INVALID: 0 },
		};
		const md = formatRunReport(report);
		expect(md).not.toMatch(/blocked by \s*\|/);
		for (const o of report.outcomes) {
			expect(o.reason.trim(), o.scenario).not.toBe("");
			expect(o.reason.trim(), o.scenario).not.toMatch(/\bby$/);
		}
	});
});

describe("the run report covers every scenario", () => {
	it("prints a total that matches the corpus, not a shrunken one", () => {
		// `formatRunReport` prints `total ${outcomes.length}`. A partition that stopped
		// being total would print a smaller, entirely plausible number over a population
		// that had quietly shrunk — the exact shape this project keeps rediscovering, and
		// the reason `runner.ts` now throws rather than reporting on a subset. Review
		// suggestion, taken before merge because it costs one comparison.
		const report: RunReport = {
			runId: "R",
			startedAt: "a",
			finishedAt: "b",
			fingerprint: {
				commit: "test",
				checkoutLatestMigration: "m",
				dbLatestMigration: "m",
				drift: false,
			},
			preflight: [],
			outcomes: plans.map((p) => ({
				scenario: p.name,
				verdict: "PASS" as const,
				reason: "1 check(s) passed",
			})),
			counts: { PASS: plans.length, WARN: 0, FAIL: 0, SKIP: 0, INVALID: 0 },
		};
		const md = formatRunReport(report);
		expect(md).toContain(`total ${plans.length}`);
		// And the corpus itself is pinned, so this cannot pass over a shrunken list.
		// 70→71 on 2026-08-28: `vp9-webm-fixed-dash` (audit 893eb66 CRITICAL-2).
		// 71→72 same day: `mixed-codec-dash-hls` .
		expect(plans.length).toBe(72);
	});
});

describe("the live tier is opt-in, and says so", () => {
	it("keeps live out of the attempted set unless asked", () => {
		// The phase-B filter was `kind === "VOD"`, which silently defeated the phase-C
		// dispatch: live scenarios never reached it, landed in the skipped complement, and
		// were reported as `not selected by --only ` with nothing after it — the dishonest
		// shape design §3 forbids and this file already fixed once. The dry run made it
		// visible immediately; this pins the rule that replaced it.
		const scenarios = [
			{ name: "vod-a", kind: "VOD" as const },
			{ name: "live-a", kind: "LIVE" as const },
		];
		const attempted = (wantsLive: boolean) =>
			scenarios
				.filter((s) => s.kind === "VOD" || (s.kind === "LIVE" && wantsLive))
				.map((s) => s.name);
		expect(attempted(false)).toEqual(["vod-a"]);
		expect(attempted(true)).toEqual(["vod-a", "live-a"]);
	});

	it("never reports a live SKIP as an --only exclusion", () => {
		// The reason a reader gets has to be the true one: a live scenario left out because
		// the run did not ask for live was not excluded by a filter.
		const report: RunReport = {
			runId: "R",
			startedAt: "a",
			finishedAt: "b",
			fingerprint: {
				commit: "test",
				checkoutLatestMigration: "m",
				dbLatestMigration: "m",
				drift: false,
			},
			preflight: [],
			outcomes: [
				{
					scenario: "live-rtmp-simple",
					verdict: "SKIP",
					reason:
						"live scenarios are opt-in: pass --live-feed-seconds, since each costs encoder minutes",
				},
			],
			counts: { PASS: 0, WARN: 0, FAIL: 0, SKIP: 1, INVALID: 0 },
		};
		const md = formatRunReport(report);
		expect(md).not.toMatch(/not selected by --only\s*\|/);
		expect(md).toContain("--live-feed-seconds");
	});
});

describe("GenericS3 io repoints to the Akamai family, never to S3", () => {
	/**
	 * The other half of the C10 fix.
	 *
	 * Not clobbering GenericS3 with the S3 credential was correct and shipped; pointing it at
	 * the RIGHT credential was left undone, so `generic-s3-akamai-io` kept the fixture's
	 * placeholder id and failed a real run with `Storage credential no longer exists` — a
	 * product-shaped message for a harness omission. The Akamai credentials were registered the
	 * whole time.
	 */
	/**
	 * Two credentials, because two are registered. Distinct ids so a test can prove the input io
	 * gets the READ credential — using one id for both would make the assertion unfalsifiable.
	 */
	const AKAMAI = {
		inputCredentialId: "44444444-4444-4444-8444-444444444444",
		outputCredentialId: "55555555-5555-4555-8555-555555555555",
		inputBucket: "akamai-in",
		outputBucket: "akamai-out",
	};

	function genericIo(plan: ReturnType<typeof rewriteForRun>) {
		return [...plan.inputs, ...plan.outputs].filter(
			(io) => io.kind === "GENERIC_S3",
		) as { kind: string; credentialId?: string; bucket?: string }[];
	}

	it("points the Akamai fixture's io at the Akamai credential and buckets", () => {
		const plan = plans.find((p) => p.name === "generic-s3-akamai-io")?.plan;
		expect(plan, "the fixture must exist").toBeDefined();
		const out = rewriteForRun(plan as NonNullable<typeof plan>, {
			...OPTIONS,
			genericS3: AKAMAI,
		});
		const io = genericIo(out);
		expect(io.length, "the fixture must have GenericS3 io").toBeGreaterThan(0);
		for (const x of io) {
			// And never the S3 credential — the violation this whole rule exists to stop.
			expect(x.credentialId).not.toBe(OPTIONS.credentialId);
			expect([AKAMAI.inputCredentialId, AKAMAI.outputCredentialId]).toContain(
				x.credentialId,
			);
			expect([AKAMAI.inputBucket, AKAMAI.outputBucket]).toContain(x.bucket);
			expect(x.bucket).not.toBe(OPTIONS.inputBucket);
			expect(x.bucket).not.toBe(OPTIONS.outputBucket);
		}
		// The direction has to match the credential: reading with the write key pair is not what
		// an operator configures, and it was the shortcut the first version shipped.
		const genericInputs = out.inputs.filter((x) => x.kind === "GENERIC_S3") as {
			credentialId?: string;
			bucket?: string;
		}[];
		const genericOutputs = out.outputs.filter(
			(x) => x.kind === "GENERIC_S3",
		) as { credentialId?: string; bucket?: string }[];
		for (const x of genericInputs) {
			expect(x.credentialId, "input io reads with the INPUT credential").toBe(
				AKAMAI.inputCredentialId,
			);
			expect(x.bucket).toBe(AKAMAI.inputBucket);
		}
		for (const x of genericOutputs) {
			expect(
				x.credentialId,
				"output io writes with the OUTPUT credential",
			).toBe(AKAMAI.outputCredentialId);
			expect(x.bucket).toBe(AKAMAI.outputBucket);
		}
	});

	it("leaves GenericS3 io exactly as authored when no Akamai credential is registered", () => {
		/**
		 * The complement, and the honest behaviour: with no target, the io must NOT be rewritten
		 * to something wrong. The capability gate then reports it, rather than the encoder
		 * failing on a credential from the wrong family.
		 */
		const plan = plans.find((p) => p.name === "generic-s3-akamai-io")?.plan;
		const before = genericIo(
			structuredClone(plan) as NonNullable<typeof plan>,
		).map((x) => `${x.credentialId}/${x.bucket}`);
		const out = rewriteForRun(plan as NonNullable<typeof plan>, OPTIONS);
		expect(genericIo(out).map((x) => `${x.credentialId}/${x.bucket}`)).toEqual(
			before,
		);
	});

	it("still repoints the S3 io in the same plan", () => {
		// The Akamai fixture also has S3-kind io; giving GenericS3 its own target must not have
		// stopped the S3 half being namespaced.
		const plan = plans.find((p) => p.name === "generic-s3-akamai-io")?.plan;
		const out = rewriteForRun(plan as NonNullable<typeof plan>, {
			...OPTIONS,
			genericS3: AKAMAI,
		});
		// This fixture's S3-kind io is plain `S3`; the schema's union here carries no
		// `S3_ROLE`, so testing for it would be a comparison TypeScript can prove impossible.
		const s3 = [...out.inputs, ...out.outputs].filter(
			(io) => io.kind === "S3",
		) as { credentialId?: string }[];
		for (const x of s3) {
			expect(x.credentialId).toBe(OPTIONS.credentialId);
		}
	});
});

describe("rewriteForRun — vmafModel override", () => {
	/**
	 * Every VMAF run to date used `vmaf_v0.6.1`, a libvmaf BUILT-IN reached through
	 * `model=version=`. The "VMAF v1" models (`vmaf_v1.0.16_*`) are NOT built in and
	 * only load from a FILE, so the `model=path=` branch had never executed against
	 * a real encode. This override makes it reachable without forking a fixture.
	 *
	 * The first version of this flag was wired into the option type and the CLI and
	 * NOT into the call site, so a real run silently measured v0.6.1 while reporting
	 * success — which is why the call site is asserted here and not just the helper.
	 */
	const OPTS = {
		credentialId: "11111111-1111-4111-8111-111111111111",
		inputBucket: "in",
		outputBucket: "out",
		sourceObject: "input/src.mkv",
		prefix: "verify/RUN/vmaf/",
	};

	function vmafPlan() {
		return encodingPlanSchema.parse(
			JSON.parse(
				readFileSync(join(FIXTURES, "vmaf-only-h264.plan.json"), "utf8"),
			),
		);
	}

	it("replaces qc.model on a VMAF-measuring plan", () => {
		const out = rewriteForRun(vmafPlan(), {
			...OPTS,
			vmafModel: "vmaf_v1.0.16_3d0h",
		});
		expect(out.qc?.model).toBe("vmaf_v1.0.16_3d0h");
		expect(out.qc?.vmaf).toBe(true);
	});

	it("leaves the fixture's own model alone when not asked", () => {
		// The fixture omits `qc.model`, so this is the SCHEMA default coming
		// through — follow the constant (owner changed it to VMAF v1 on
		// 2026-08-16); the literal lives in core's own value pin.
		expect(rewriteForRun(vmafPlan(), OPTS).qc?.model).toBe(DEFAULT_VMAF_MODEL);
	});

	it("does not add a qc block to a plan that measures nothing", () => {
		// Adding one would change what the scenario verifies — a VMAF pass on a
		// delivery scenario is a different (and much slower) run.
		const plan = encodingPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(FIXTURES, "fixed-bitrate-hls-on-aws.plan.json"),
					"utf8",
				),
			),
		);
		expect(plan.qc).toBeUndefined();
		const out = rewriteForRun(plan, {
			...OPTS,
			vmafModel: "vmaf_v1.0.16_3d0h",
		});
		expect(out.qc).toBeUndefined();
	});
});

describe("dryRunArtefactCount (E2E 2026-08-14, I-05)", () => {
	it("counts QC mirrors — a vmaf-only plan is NOT 'no expected artefacts'", async () => {
		const { dryRunArtefactCount } = await import("./runner");
		const vmafOnly = plans.find((p) => p.name === "vmaf-only-h264");
		if (!vmafOnly) {
			throw new Error("vmaf-only-h264 fixture missing");
		}
		const rewritten = rewriteForRun(vmafOnly.plan, OPTIONS);
		const expected = compileExpectedArtefacts(rewritten);
		// The exact misjudgement: zero delivery muxings, zero manifests…
		expect(expected.muxings.length).toBe(0);
		expect(expected.manifests.length).toBe(0);
		// …but real mirrors, so the dry-run verdict must be PASS-able.
		expect(expected.qc?.mirrorRenditionKeys.length ?? 0).toBeGreaterThan(0);
		expect(dryRunArtefactCount(expected)).toBeGreaterThan(0);
	});

	it("a delivery plan still counts its muxings + manifests", async () => {
		const { dryRunArtefactCount } = await import("./runner");
		const hls = plans.find((p) => p.name === "fixed-bitrate-hls-on-aws");
		if (!hls) {
			throw new Error("fixture missing");
		}
		const expected = compileExpectedArtefacts(rewriteForRun(hls.plan, OPTIONS));
		expect(dryRunArtefactCount(expected)).toBe(
			expected.muxings.length + expected.manifests.length,
		);
	});
});

/**
 *  I-03 — the circuit breaker's pure halves. The 2026-08-14 E2E
 * burned a corpus after the FIRST start-5xx made every later submission a
 * known-doomed spend; these pin what trips and what a resume honors.
 */
describe("breakerTripReason", () => {
	it("any INVALID trips (a harness fault is never a product verdict)", () => {
		expect(
			breakerTripReason({ verdict: "INVALID", reason: "no credential" }),
		).toContain("INVALID");
	});

	it("a FAIL carrying a start 5xx trips", () => {
		expect(
			breakerTripReason({
				verdict: "FAIL",
				reason:
					"POST /encoding/encodings/x/start failed (500): An undefined error occurred (code 1004)",
			}),
		).toContain("start-5xx");
	});

	it("an unknown-outcome FAIL trips", () => {
		expect(
			breakerTripReason({
				verdict: "FAIL",
				reason: "unknown outcome after poll",
			}),
		).not.toBeNull();
	});

	it("an ordinary product FAIL does NOT trip — verdicts are the run's purpose", () => {
		expect(
			breakerTripReason({
				verdict: "FAIL",
				reason: "artefact missing: video/720p/init.mp4",
			}),
		).toBeNull();
		expect(breakerTripReason({ verdict: "PASS", reason: "" })).toBeNull();
		expect(
			breakerTripReason({ verdict: "SKIP", reason: "blocked" }),
		).toBeNull();
	});
});

describe("loadResumePasses", () => {
	it("collects PASSes keyed by scenario, valued by the prior runId", () => {
		const passes = loadResumePasses(
			JSON.stringify({
				runId: "run-1",
				outcomes: [
					{ scenario: "a", verdict: "PASS" },
					{ scenario: "b", verdict: "FAIL" },
					{ scenario: "c", verdict: "PASS" },
				],
			}),
		);
		expect(passes.get("a")).toBe("run-1");
		expect(passes.has("b")).toBe(false);
		expect(passes.size).toBe(2);
	});

	it("tolerates a minimal or empty report", () => {
		expect(loadResumePasses("{}").size).toBe(0);
	});
});

describe("planIdentitySha256 — what a verdict is a verdict OF, independent of the run (ledger #209, review-327)", () => {
	const { plan } = rewritable[0] as (typeof plans)[number];

	it("is equal across run ids, while the rewrite itself is not", () => {
		const a = { ...OPTIONS, prefix: "verify/2026-08-28T09-00-00/x/" };
		const b = { ...OPTIONS, prefix: "verify/2026-08-29T09-00-00/x/" };
		// The premise the defect rested on: the real rewrite embeds the run id
		// (job name + every destination path), so its digest never matched.
		expect(JSON.stringify(rewriteForRun(plan, a))).not.toBe(
			JSON.stringify(rewriteForRun(plan, b)),
		);
		expect(planIdentitySha256(plan, a, "x")).toBe(
			planIdentitySha256(plan, b, "x"),
		);
	});

	it("still changes with everything else the rewrite decides", () => {
		const base = planIdentitySha256(plan, OPTIONS, "x");
		expect(
			planIdentitySha256(plan, { ...OPTIONS, sourceObject: "other.mov" }, "x"),
		).not.toBe(base);
		expect(
			planIdentitySha256(plan, { ...OPTIONS, outputBucket: "other-out" }, "x"),
		).not.toBe(base);
		expect(
			planIdentitySha256(
				plan,
				{ ...OPTIONS, credentialId: "44444444-4444-4444-8444-444444444444" },
				"x",
			),
		).not.toBe(base);
	});
});

describe('collectRunFingerprint — the image\'s commit, not "unknown" (re-audit BLOCKER-3, ledger #218)', () => {
	const prisma = {
		$queryRawUnsafe: async () => [{ migration_name: "20260828150000_x" }],
	} as never;
	it("reads BITOVP_COMMIT first — the container has no .git", async () => {
		const prev = process.env.BITOVP_COMMIT;
		process.env.BITOVP_COMMIT = "abc123def";
		try {
			const fp = await collectRunFingerprint(prisma);
			expect(fp.commit).toBe("abc123def");
		} finally {
			if (prev === undefined) {
				delete process.env.BITOVP_COMMIT;
			} else {
				process.env.BITOVP_COMMIT = prev;
			}
		}
	});
	it("treats an empty or literal 'unknown' BITOVP_COMMIT as absent (falls back to git or unknown)", async () => {
		const prev = process.env.BITOVP_COMMIT;
		process.env.BITOVP_COMMIT = "unknown";
		try {
			const fp = await collectRunFingerprint(prisma);
			expect(fp.commit).not.toBe("");
			expect(fp.commit === "unknown" || /^[0-9a-f]{40}$/.test(fp.commit)).toBe(
				true,
			);
		} finally {
			if (prev === undefined) {
				delete process.env.BITOVP_COMMIT;
			} else {
				process.env.BITOVP_COMMIT = prev;
			}
		}
	});
});

/**
 * Re-audit BLOCKER-3's source identity, over the WHOLE plan (review of this
 * PR). The first cut folded `plan.ingest[0]`, which is an identity for the
 * single-source scenarios and nothing else: `concatenation-two-sources`
 * ingests two objects, so a replaced SECOND source was invisible and
 * `--resume-from` would have handed out its prior PASS.
 */
describe("planSourceIdentity — every ingest, or nothing", () => {
	const TWO = plans.find((p) => p.name === "concatenation-two-sources");
	if (!TWO) {
		throw new Error(
			"concatenation-two-sources is gone — this test's whole premise is the two-ingest fixture",
		);
	}
	const two = TWO;
	// The premise, derived from the fixture rather than asserted about it.
	it("the fixture really does ingest two distinct objects", () => {
		expect(two.plan.ingest.length).toBe(2);
		expect(new Set(two.plan.ingest.map((i) => i.inputPath)).size).toBe(2);
	});

	/** etag per object key — the shape a HEAD through the driver returns. */
	const heads =
		(etags: Record<string, string>) =>
		async (_credentialId: string, _bucket: string, key: string) =>
			etags[key] ?? "unavailable";

	const A = "path/to/your/input/part-a.mp4";
	const B = "path/to/your/input/part-b.mp4";

	it("folds both sources, and a swapped SECOND object changes the identity", async () => {
		const before = await planSourceIdentity(
			two.plan,
			heads({ [A]: 'etag="a1"', [B]: 'etag="b1"' }),
		);
		const after = await planSourceIdentity(
			two.plan,
			heads({ [A]: 'etag="a1"', [B]: 'etag="b2"' }),
		);
		expect(before).toContain('etag="a1"');
		expect(before).toContain('etag="b1"');
		expect(after).not.toBe(before);
	});

	it("and that difference is what refuses the resume", async () => {
		const fingerprint = {
			commit: "c1",
			checkoutLatestMigration: "m1",
			dbLatestMigration: "m1",
		};
		const identity = async (b: string) => ({
			planSha256: "p1",
			sourceObject: "part-a.mp4",
			sourceIdentity: await planSourceIdentity(
				two.plan,
				heads({ [A]: 'etag="a1"', [B]: b }),
			),
			bitmovinAccountId: "acct-1",
		});
		const prior = await identity('etag="b1"');
		const now = await identity('etag="b2"');
		expect(
			resumeEligibility(
				{ fingerprint, outcome: { verdict: "PASS", ...prior }, runId: "r0" },
				{ fingerprint, ...now },
			),
		).toEqual({
			honor: false,
			reason: expect.stringContaining("sourceIdentity"),
		});
		// The control: the same bytes on both sides DO resume, so the arm above
		// is measuring the second object and not some other refusal.
		expect(
			resumeEligibility(
				{ fingerprint, outcome: { verdict: "PASS", ...prior }, runId: "r0" },
				{ fingerprint, ...prior },
			),
		).toEqual({ honor: true, runId: "r0" });
	});

	it("ONE unavailable entry makes the whole plan unavailable — fail closed", async () => {
		expect(
			await planSourceIdentity(two.plan, heads({ [A]: 'etag="a1"' })),
		).toBe("unavailable");
	});

	it("a plan with no ingest, or an ingest with no HEADable input, is unavailable", async () => {
		const never = async () => "etag=x";
		expect(
			await planSourceIdentity({ ingest: [], inputs: two.plan.inputs }, never),
		).toBe("unavailable");
		expect(
			await planSourceIdentity({ ingest: two.plan.ingest, inputs: [] }, never),
		).toBe("unavailable");
	});
});

/**
 * The provider-terminal reading (re-audit BLOCKER-2) and how it is reported.
 * `runOne` is unreachable by any test, so the decisions live out here — the
 * same argument `vodOutcomeForReport` was extracted on (review-298).
 */
describe("encodingIsGone — the typed 404, never the prose", () => {
	/** A Bitmovin error as the SDK throws it: fields, not a message shape. */
	const sdkError = (httpStatusCode: number, shortMessage: string) => ({
		httpStatusCode,
		shortMessage,
	});

	it("a 404 from the SDK is gone", () => {
		expect(encodingIsGone(sdkError(404, "Encoding not found"))).toBe(true);
	});

	it("a 500 whose MESSAGE contains 404 is NOT gone — the direction that must never fail", () => {
		const wrapped = new BitmovinCallError(
			"GET",
			"/encoding/encodings/404/status",
			sdkError(500, "An undefined error occurred (404 upstream)"),
		);
		expect(wrapped.httpStatusCode).toBe(500);
		expect(wrapped.message).toContain("404");
		expect(encodingIsGone(wrapped)).toBe(false);
	});

	it("reads either shape — the wrapped 404 too", () => {
		expect(
			encodingIsGone(
				new BitmovinCallError("GET", "/x", sdkError(404, "Not found")),
			),
		).toBe(true);
	});

	it("a plain Error saying '404 not found' is not a status", () => {
		expect(encodingIsGone(new Error("404 not found"))).toBe(false);
		expect(encodingIsGone(undefined)).toBe(false);
	});
});

describe("providerWord / failedJobOutcome — a FAIL never closes over a live encoding", () => {
	const ended = { status: "FAILED", error: "encoding ERROR" };

	it("names every provider encoding it read", () => {
		expect(
			providerWord({
				provider: [
					{ encodingId: "aaaaaaaa-1111", status: "ERROR" },
					{ encodingId: "bbbbbbbb-2222", status: "RUNNING" },
				],
				providerTerminal: false,
			}),
		).toBe("aaaaaaaa=ERROR,bbbbbbbb=RUNNING");
	});

	it("distinguishes a missing provider identity from a failed provider read", () => {
		expect(providerWord({ provider: [], providerTerminal: false })).toBe(
			"provider identity unknown",
		);
		expect(providerWord({ providerTerminal: false })).toBe(
			"provider unreadable",
		);
		expect(providerWord({ providerTerminal: "unread" })).toBe(
			"provider unread",
		);
	});

	it("a FAILED job whose provider encoding is still RUNNING is NOT reported closed", () => {
		const outcome = failedJobOutcome(ended, {
			terminal: false,
			provider: [{ encodingId: "cccccccc-3333", status: "RUNNING" }],
			providerTerminal: false,
		});
		expect(outcome.verdict).toBe("FAIL");
		expect(outcome.reason).toContain("PROVIDER is NOT terminal");
		expect(outcome.reason).toContain("cccccccc=RUNNING");
		expect(outcome.reason).toContain("may still be billing");
	});

	it("a FAILED job whose provider agrees is the product's verdict, with the provider named", () => {
		const outcome = failedJobOutcome(ended, {
			terminal: true,
			provider: [{ encodingId: "cccccccc-3333", status: "ERROR" }],
			providerTerminal: true,
		});
		expect(outcome).toEqual({
			verdict: "FAIL",
			reason: "job FAILED: encoding ERROR (provider cccccccc=ERROR)",
		});
		// Never a breaker trip: an ordinary product FAIL is the run's purpose.
		expect(breakerTripReason(outcome)).toBeNull();
	});

	it("a job with no error text still says what it was", () => {
		expect(
			failedJobOutcome(
				{ status: "QC_FAILED", error: null },
				{ terminal: false, provider: [], providerTerminal: false },
			).reason,
		).toContain("provider identity unknown");
	});
});

describe("vodIntentResourceSets — exact possible/cleaned equality", () => {
	it("retries a transient provider-context failure but reuses a successful identity scan", async () => {
		const load = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error("provider list 503"))
			.mockResolvedValueOnce("exact-context");
		const cached = memoizeSuccessfulAsync(load);
		await expect(cached()).rejects.toThrow("provider list 503");
		await expect(cached()).resolves.toBe("exact-context");
		await expect(cached()).resolves.toBe("exact-context");
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("still stops every exact provider id when the product cancel request is unavailable", async () => {
		const stopEncoding = vi.fn(async (_encodingId: string) => undefined);
		const status = await cancelAndStopVerificationEncodings({
			cancelProduct: async () => {
				throw new Error("product route unavailable");
			},
			loadProviderContext: async () => ({
				sdk: { stopEncoding },
				ids: ["enc-a", "enc-b"],
			}),
		});
		expect(status).toBe(0);
		expect(stopEncoding.mock.calls.map(([id]) => id)).toEqual([
			"enc-a",
			"enc-b",
		]);
	});

	it("stops and reads every exact-label candidate while VOD identity remains unresolved", async () => {
		const merged = mergeVerificationProviderResources(
			[],
			[],
			"encoding",
			["encoding:a"],
			["enc-unreadable", "enc-conflict"],
		);
		expect(merged).toMatchObject({
			ids: ["enc-conflict", "enc-unreadable"],
			identityComplete: false,
		});

		const stopEncoding = vi.fn(async (_encodingId: string) => undefined);
		const getEncodingStatus = vi.fn(async (_encodingId: string) => ({
			status: "FINISHED",
		}));
		const cleanup = await ensureTerminal({
			cancel: () =>
				cancelAndStopVerificationEncodings({
					cancelProduct: async () => 202,
					loadProviderContext: async () => ({
						sdk: { stopEncoding },
						ids: merged.ids,
					}),
				}),
			readStatus: async () => "CANCELED",
			readProviderStatuses: async () => {
				await Promise.all(merged.ids.map((id) => stopEncoding(id)));
				await Promise.all(merged.ids.map((id) => getEncodingStatus(id)));
				return merged.ids.map((encodingId) => ({
					encodingId,
					status: "PROVIDER_DISCOVERY_PENDING",
				}));
			},
			sleep: async () => undefined,
			now: () => 0,
			budgetMs: 0,
		});

		expect(cleanup).toMatchObject({
			terminal: false,
			localTerminal: true,
			providerTerminal: false,
		});
		expect(new Set(stopEncoding.mock.calls.map(([id]) => id))).toEqual(
			new Set(merged.ids),
		);
		expect(getEncodingStatus.mock.calls.map(([id]) => id)).toEqual(merged.ids);
		expect(
			vodIntentResourceSets(
				"job-unresolved",
				cleanup.provider,
				cleanup.localTerminal,
			),
		).toEqual({
			providerIds: merged.ids,
			possiblyCreatedKeys: [
				"local:VOD_JOB:job-unresolved",
				"provider:BITMOVIN_ENCODING:enc-conflict",
				"provider:BITMOVIN_ENCODING:enc-unreadable",
			],
			cleanedResourceKeys: ["local:VOD_JOB:job-unresolved"],
		});
	});

	it("names every provider id and cleans only resources with terminal readback", () => {
		expect(
			vodIntentResourceSets(
				"job-1",
				[
					{ encodingId: "enc-finished", status: "FINISHED" },
					{ encodingId: "enc-running", status: "RUNNING" },
				],
				true,
			),
		).toEqual({
			providerIds: ["enc-finished", "enc-running"],
			possiblyCreatedKeys: [
				"local:VOD_JOB:job-1",
				"provider:BITMOVIN_ENCODING:enc-finished",
				"provider:BITMOVIN_ENCODING:enc-running",
			],
			cleanedResourceKeys: [
				"local:VOD_JOB:job-1",
				"provider:BITMOVIN_ENCODING:enc-finished",
			],
		});
	});

	it("an empty provider projection never invents a provider identity", () => {
		expect(vodIntentResourceSets("job-2", [], true)).toEqual({
			providerIds: [],
			possiblyCreatedKeys: ["local:VOD_JOB:job-2"],
			cleanedResourceKeys: ["local:VOD_JOB:job-2"],
		});
	});

	it("closes a compensated id only after direct 404 and still includes an extra exact marker", async () => {
		const exactIdentity = {
			encodingId: "enc-extra",
			jobId: "job-1",
			step: "encoding:extra",
			name: "extra [verify run]",
			label: "bitovp-verify-deadbeef",
			verificationKey: "verify:run:scenario:VOD_JOB",
			requestSha256: "a".repeat(64),
		};
		const merged = mergeVerificationProviderResources(
			[exactIdentity],
			[
				{
					encodingId: "enc-compensated",
					step: "encoding",
					compensationDeleteSucceeded: true,
				},
			],
			"encoding",
		);
		expect(merged.ids).toEqual(["enc-compensated", "enc-extra"]);
		expect(merged.requireGoneIds).toEqual(["enc-compensated"]);
		expect(merged.identityConflict).toBe(false);

		const gone = await readVerificationProviderEncodingStatus(
			async () => {
				throw { httpStatusCode: 404, shortMessage: "gone" };
			},
			"enc-compensated",
			true,
		);
		expect(gone).toEqual({
			encodingId: "enc-compensated",
			status: "NOT_FOUND",
		});
		expect(
			vodIntentResourceSets(
				"job-1",
				[gone, { encodingId: "enc-extra", status: "FINISHED" }],
				true,
			),
		).toMatchObject({
			providerIds: ["enc-compensated", "enc-extra"],
			cleanedResourceKeys: [
				"local:VOD_JOB:job-1",
				"provider:BITMOVIN_ENCODING:enc-compensated",
				"provider:BITMOVIN_ENCODING:enc-extra",
			],
		});
	});

	it("does not call delete compensation terminal while the exact id still reads", async () => {
		const pending = await readVerificationProviderEncodingStatus(
			async () => ({ status: "STOPPED" }),
			"enc-compensated",
			true,
		);
		expect(pending).toEqual({
			encodingId: "enc-compensated",
			status: "COMPENSATION_DELETE_PENDING",
		});
		expect(
			vodIntentResourceSets("job-1", [pending], true).cleanedResourceKeys,
		).toEqual(["local:VOD_JOB:job-1"]);
		await expect(
			readVerificationProviderEncodingStatus(
				async () => ({ status: "STOPPED" }),
				"enc-compensated",
				true,
			),
		).resolves.toEqual({
			encodingId: "enc-compensated",
			status: "COMPENSATION_DELETE_PENDING",
		});
	});

	it("retries an empty provider scan instead of caching absence as a fact", () => {
		expect(() =>
			mergeVerificationProviderResources([], [], "encoding"),
		).toThrowError(
			expect.objectContaining({
				code: "VERIFICATION_PROVIDER_LOOKUP_UNKNOWN",
			}),
		);
	});

	it("retains visible ids for cost safety while a multi-encoding sibling is not yet visible", () => {
		const identity = (encodingId: string, step: string) => ({
			encodingId,
			jobId: "job-1",
			step,
			name: `${step} [verify run]`,
			label: "bitovp-verify-deadbeef",
			verificationKey: "verify:run:scenario:VOD_JOB",
			requestSha256: "a".repeat(64),
		});
		expect(
			mergeVerificationProviderResources(
				[identity("enc-a", "encoding:a")],
				[],
				"encoding",
				["encoding:a", "encoding:b"],
			),
		).toMatchObject({ ids: ["enc-a"], identityComplete: false });
		expect(
			mergeVerificationProviderResources(
				[identity("enc-a", "encoding:a"), identity("enc-b", "encoding:b")],
				[],
				"encoding",
				["encoding:a", "encoding:b"],
			).ids,
		).toEqual(["enc-a", "enc-b"]);
	});

	it("retains duplicate-step ids for cleanup but marks their identity unresolved", () => {
		const identity = (encodingId: string) => ({
			encodingId,
			jobId: "job-1",
			step: "encoding:a",
			name: "a [verify run]",
			label: "bitovp-verify-deadbeef",
			verificationKey: "verify:run:scenario:VOD_JOB",
			requestSha256: "a".repeat(64),
		});
		expect(
			mergeVerificationProviderResources(
				[identity("enc-a"), identity("enc-duplicate")],
				[],
				"encoding",
				["encoding:a"],
			),
		).toMatchObject({
			ids: ["enc-a", "enc-duplicate"],
			identityConflict: true,
		});
	});

	it("requires one stable polling interval before treating an exact id set as complete", () => {
		let now = 1_000;
		const discovery = verificationProviderDiscoveryStability(() => now);
		expect(discovery.observe(["enc-a"])).toBe(false);
		now += 9_999;
		expect(discovery.observe(["enc-a"])).toBe(false);
		now += 1;
		expect(discovery.observe(["enc-a"])).toBe(true);
		expect(discovery.observe(["enc-a", "enc-b"])).toBe(false);
		now += 10_000;
		expect(discovery.observe(["enc-a", "enc-b"])).toBe(true);
	});

	it("retains a locally recorded id for stop/readback but refuses identity closure until its marker appears", () => {
		expect(
			mergeVerificationProviderResources(
				[],
				[
					{
						encodingId: "enc-unbound",
						step: "encoding",
						compensationDeleteSucceeded: false,
					},
				],
				"encoding",
			),
		).toMatchObject({
			ids: ["enc-unbound"],
			identityComplete: false,
		});
	});
});

describe("Live verification intent cleanup — exact stable provider set", () => {
	const established = { established: true, detail: "proven" };
	const cleanProduct = {
		providerId: "enc-a",
		stopFailures: [] as string[],
		cleanup: {
			channelId: "live-1",
			providerStreamIds: {},
			providerOutputIds: {},
			productStopProjection: established,
			providerTerminal: established,
			localTerminal: established,
			feederProcessGone: established,
			hostProcessGone: established,
			queueDrained: established,
			tokenRequired: false,
			tokenCleanup: established,
			localClean: true,
			clean: true,
		},
	};

	it("does not retain a stale provider-terminal/clean claim when exact provider lookup is unreadable", async () => {
		let now = 0;
		const closure = await resolveLiveVerificationIntentCleanup({
			channelId: "live-1",
			product: cleanProduct,
			loadProviderContext: async () => {
				throw new Error("provider lookup unavailable");
			},
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});

		expect(closure.terminal).toBe(false);
		expect(closure.cleanedResourceKeys).toEqual(["local:LIVE_CHANNEL:live-1"]);
		expect(closure.readback).toMatchObject({
			cleanup: {
				localClean: true,
				providerTerminal: { established: false },
				clean: false,
			},
		});
	});

	it("normal closure discovers and stops A then a later-visible duplicate B without CLEANED", async () => {
		let now = 0;
		const stopLiveEncoding = vi.fn(async (_id: string) => undefined);
		const getEncodingStatus = vi.fn(async (_id: string) => ({
			status: "FINISHED",
		}));
		const context = (ids: string[], duplicateConflict = false) =>
			({
				sdk: { stopLiveEncoding, getEncodingStatus },
				ids,
				identities: ids.map((encodingId) => ({
					encodingId,
					jobId: "live-1",
					step: "encoding",
					name: "live encoding",
					label: "bitovp-verify-deadbeef",
					verificationKey: "verify:run:live:LIVE_CHANNEL",
					requestSha256: "a".repeat(64),
				})),
				requireGoneIds: [],
				identityConflict: duplicateConflict,
				identityComplete: !duplicateConflict,
				providerProofUncertain: false,
				row: {
					status: "STOPPED",
					bitmovinEncodingId: "enc-a",
					verificationKey: "verify:run:live:LIVE_CHANNEL",
					verificationRequestSha256: "a".repeat(64),
				},
			}) as unknown as NonNullable<
				Parameters<
					typeof resolveLiveVerificationIntentCleanup
				>[0]["initialProvider"]
			>;
		const load = vi
			.fn()
			.mockResolvedValueOnce(context(["enc-a"]))
			.mockResolvedValueOnce(context(["enc-a", "enc-b"], true))
			.mockResolvedValue(context(["enc-a", "enc-b"], true));

		const closure = await resolveLiveVerificationIntentCleanup({
			channelId: "live-1",
			product: cleanProduct,
			loadProviderContext: load,
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});

		expect(closure.terminal).toBe(false);
		expect(closure.providerIds).toEqual(["enc-a", "enc-b"]);
		expect(closure.cleanedResourceKeys).toEqual(["local:LIVE_CHANNEL:live-1"]);
		expect(closure.readback).toMatchObject({
			providerIdentityConflict: true,
			providerStatuses: [
				{ encodingId: "enc-a", status: "PROVIDER_IDENTITY_CONFLICT" },
				{ encodingId: "enc-b", status: "PROVIDER_IDENTITY_CONFLICT" },
			],
		});
		expect(stopLiveEncoding).toHaveBeenCalledWith("enc-b");
		expect(load).toHaveBeenCalledTimes(3);
	});

	it("keeps an earlier provider-proof UNKNOWN sticky across later clean scans", async () => {
		let now = 0;
		const stopLiveEncoding = vi.fn(async (_id: string) => undefined);
		const context = (uncertain: boolean) =>
			({
				sdk: {
					stopLiveEncoding,
					getEncodingStatus: async () => ({ status: "FINISHED" }),
				},
				ids: ["enc-a"],
				identities: [],
				requireGoneIds: [],
				identityConflict: false,
				identityComplete: !uncertain,
				providerProofUncertain: uncertain,
				row: {
					status: "STOPPED",
					bitmovinEncodingId: "enc-a",
					verificationKey: "verify:run:live:LIVE_CHANNEL",
					verificationRequestSha256: "a".repeat(64),
				},
			}) as unknown as NonNullable<
				Parameters<
					typeof resolveLiveVerificationIntentCleanup
				>[0]["initialProvider"]
			>;
		const load = vi
			.fn()
			.mockResolvedValueOnce(context(true))
			.mockResolvedValue(context(false));

		const closure = await resolveLiveVerificationIntentCleanup({
			channelId: "live-1",
			product: cleanProduct,
			loadProviderContext: load,
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});

		expect(closure.terminal).toBe(false);
		expect(closure.error).toContain("unproven");
		expect(closure.readback).toMatchObject({
			providerProofUncertain: true,
			providerIdentityComplete: false,
		});
	});

	it("stops and reads every exact-label candidate while Live identity remains unresolved", async () => {
		let now = 0;
		const ids = ["enc-conflict", "enc-unreadable"];
		const stopLiveEncoding = vi.fn(async (_id: string) => undefined);
		const getEncodingStatus = vi.fn(async (_id: string) => ({
			status: "FINISHED",
		}));
		const context = {
			sdk: { stopLiveEncoding, getEncodingStatus },
			ids,
			identities: [],
			requireGoneIds: [],
			identityConflict: false,
			identityComplete: false,
			providerProofUncertain: true,
			row: {
				status: "STOPPED",
				bitmovinEncodingId: "enc-conflict",
				verificationKey: "verify:run:live:LIVE_CHANNEL",
				verificationRequestSha256: "a".repeat(64),
			},
		} as unknown as NonNullable<
			Parameters<
				typeof resolveLiveVerificationIntentCleanup
			>[0]["initialProvider"]
		>;

		const closure = await resolveLiveVerificationIntentCleanup({
			channelId: "live-1",
			product: { ...cleanProduct, providerId: "enc-conflict" },
			initialProvider: context,
			loadProviderContext: async () => context,
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});

		expect(closure).toMatchObject({
			terminal: false,
			providerIds: ids,
			cleanedResourceKeys: ["local:LIVE_CHANNEL:live-1"],
			error: expect.stringContaining("unproven"),
			readback: {
				providerIdentityComplete: false,
				providerProofUncertain: true,
				providerStatuses: ids.map((encodingId) => ({
					encodingId,
					status: "PROVIDER_DISCOVERY_PENDING",
				})),
			},
		});
		expect(new Set(stopLiveEncoding.mock.calls.map(([id]) => id))).toEqual(
			new Set(ids),
		);
		expect(new Set(getEncodingStatus.mock.calls.map(([id]) => id))).toEqual(
			new Set(ids),
		);
	});

	it("joins a stable exact provider terminal readback into the persisted cleanup seal", async () => {
		let now = 0;
		const stopLiveEncoding = vi.fn(async (_id: string) => undefined);
		const getEncodingStatus = vi.fn(async (_id: string) => ({
			status: "FINISHED",
		}));
		const context = {
			sdk: { stopLiveEncoding, getEncodingStatus },
			ids: ["enc-a"],
			identities: [],
			requireGoneIds: [],
			identityConflict: false,
			identityComplete: true,
			providerProofUncertain: false,
			row: {
				status: "STOPPED",
				bitmovinEncodingId: "enc-a",
				verificationKey: "verify:run:live:LIVE_CHANNEL",
				verificationRequestSha256: "a".repeat(64),
			},
		} as unknown as NonNullable<
			Parameters<
				typeof resolveLiveVerificationIntentCleanup
			>[0]["initialProvider"]
		>;

		const closure = await resolveLiveVerificationIntentCleanup({
			channelId: "live-1",
			product: cleanProduct,
			initialProvider: context,
			loadProviderContext: async () => context,
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});

		expect(closure.terminal).toBe(true);
		expect(closure.readback).toMatchObject({
			cleanup: {
				localClean: true,
				providerTerminal: { established: true },
				clean: true,
			},
			providerStatuses: [{ encodingId: "enc-a", status: "FINISHED" }],
		});
	});

	it("treats a redundant product stop 409 as CLEANED only after terminal readback and exact resource-set equality", async () => {
		let now = 0;
		const context = {
			sdk: {
				stopLiveEncoding: vi.fn(async (_id: string) => undefined),
				getEncodingStatus: vi.fn(async (_id: string) => ({
					status: "FINISHED",
				})),
			},
			ids: ["enc-a"],
			identities: [],
			requireGoneIds: [],
			identityConflict: false,
			identityComplete: true,
			providerProofUncertain: false,
			row: {
				status: "STOPPED",
				bitmovinEncodingId: "enc-a",
				verificationKey: "verify:run:live:LIVE_CHANNEL",
				verificationRequestSha256: "a".repeat(64),
			},
		} as unknown as NonNullable<
			Parameters<
				typeof resolveLiveVerificationIntentCleanup
			>[0]["initialProvider"]
		>;
		const redundant409 = "channel live-1 refused the stop: HTTP 409";
		const closure = await resolveLiveVerificationIntentCleanup({
			channelId: "live-1",
			product: { ...cleanProduct, stopFailures: [redundant409] },
			initialProvider: context,
			loadProviderContext: async () => context,
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});

		expect(closure.terminal).toBe(true);
		expect(closure.error).toBeUndefined();
		expect(closure.possiblyCreatedKeys).toEqual(closure.cleanedResourceKeys);
		expect(closure.readback).toMatchObject({
			stopFailures: [redundant409],
			redundantStopFailures: [redundant409],
			cleanup: { clean: true },
		});
	});

	it("retries both direct stop and status after one transient provider failure", async () => {
		let now = 0;
		const stopLiveEncoding = vi
			.fn()
			.mockRejectedValueOnce(new Error("stop 503"))
			.mockResolvedValue(undefined);
		const getEncodingStatus = vi
			.fn()
			.mockRejectedValueOnce(new Error("status 503"))
			.mockResolvedValue({ status: "FINISHED" });

		const statuses = await stopAndReadLiveVerificationProviders(
			{ stopLiveEncoding, getEncodingStatus } as unknown as Parameters<
				typeof stopAndReadLiveVerificationProviders
			>[0],
			["enc-a"],
			{
				now: () => now,
				sleep: async (ms) => {
					now += ms;
				},
			},
		);

		expect(statuses).toEqual([{ encodingId: "enc-a", status: "FINISHED" }]);
		expect(stopLiveEncoding).toHaveBeenCalledTimes(2);
		expect(getEncodingStatus).toHaveBeenCalledTimes(2);
	});
});
