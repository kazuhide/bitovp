/**
 * `verify job <id>` — run the verification engine against a job that already exists.
 *
 * This is phase A's payoff and phase B's foundation: no encoding is submitted, nothing
 * is written, and the only inputs are a job row and the bucket it wrote to. It is also
 * the honest first test of the whole design, because it can be pointed at the jobs
 * whose problems were found by hand and asked to find them mechanically.
 *
 * Read-only against storage. Downloads into a temp dir and removes it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	EncodingPlan,
	ExpectedArtefacts,
	PerTitleActualPopulations,
	PerTitleProviderResult,
	PerTitleResultsView,
	PooledMetrics,
	QcVerdict,
} from "@bitovp/core";
import {
	cipherFromEnv,
	compileExpectedArtefacts,
	encodingPlanSchema,
	perTitleActualPopulations,
	perTitleActualVideoFamilies,
	perTitleResultsView,
	perTitleRungDirsFromSnapshot,
	planHasPerTitle,
	stepLogSchema,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import {
	autoTriggerKey,
	createCredentialStore,
	createPrismaClient,
} from "@bitovp/db";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { createBrowserForCredential } from "@bitovp/storage";
import { makeEngineDeps, probeFile } from "./adapters";
import type { VerificationReport } from "./engine";
import {
	appendCheck,
	perTitleUnverifiedChecks,
	verifyArtefacts,
} from "./engine";

/**
 * Where a plan input/output can be BROWSED, or why it cannot be.
 *
 * The plan's input/output unions are not uniformly browsable, and the typechecker said
 * so before this ever ran: `bucket` exists on the S3-family members, Azure names a
 * `container`, and HTTPS/SFTP have no container at all (HTTPS has no credential
 * either). A verifier that assumed a bucket would have crashed on the two HTTPS
 * fixtures; naming the reason turns those into an honest SKIP instead.
 */
type Browsable =
	| { ok: true; bucket: string; credentialId: string }
	| { ok: false; reason: string };

/**
 * Every DIRECTORY this plan can write into, as a pattern with its runtime holes
 * intact — the population half of `makeForeignKeyFilter`.
 *
 * Directories, not file names, and that distinction is the whole fix (ledger
 * #252). Which FILES a run writes is partly decided by the provider AFTER the
 * plan is compiled — a per-title ladder's HLS variant playlists are named from
 * the chosen rung (`CREATE_HLS_PER_TITLE_VARIANTS`, `uriTemplate:
 * video_{avgBitrate}.m3u8`), and `hlsChildEntries` deliberately omits them
 * because "their URIs are resolved at run time". WHERE it writes is decided by
 * the plan and only by the plan, so it is knowable in advance for every family.
 *
 * `hlsChildFiles` contributes only its DIRECTORY part: a child URI may be nested
 * (`rendition.hlsMedia.uri` is operator-settable), and that subdirectory is a
 * place the run writes even though the file inside it may be named at run time.
 */
function declaredDirPatterns(
	expected: Pick<
		ExpectedArtefacts,
		"muxings" | "manifests" | "thumbnails" | "sprites"
	> & {
		drm?: { dir?: { pattern: string } }[];
		qc?: { mirrors: { dir: { pattern: string } }[] };
	},
): string[] {
	const dirs = [
		...expected.muxings.map((m) => m.dir.pattern),
		// A DRM'd muxing has no destination of its own and reaches storage through
		// its DRM rows — all four muxings of `pertitle-h264-mp4-smooth-drm-on-aws`
		// carry an empty `dir`, so the DRM rows ARE that plan's whole population.
		...(expected.drm ?? []).map((d) => d.dir?.pattern),
		...expected.manifests.flatMap((m) => [
			m.dir.pattern,
			...(m.hlsChildFiles ?? []).map((f) =>
				f.includes("/")
					? `${m.dir.pattern}${f.slice(0, f.lastIndexOf("/"))}/`
					: m.dir.pattern,
			),
		]),
		...(expected.qc?.mirrors ?? []).map((m) => m.dir.pattern),
		...expected.thumbnails.map((t) => t.dir.pattern),
		...expected.sprites.map((sp) => sp.dir.pattern),
	].filter((d): d is string => d !== undefined && d !== "");
	return [...new Set(dirs.map((d) => (d.endsWith("/") ? d : `${d}/`)))];
}

/** A directory pattern → a regex matching every KEY that sits DIRECTLY in it. */
function directoryMemberMatcher(pattern: string): RegExp {
	// `{uuid}`/`{bitrate}`/`%number%` are runtime expansions, not literals — the same
	// two substitutions the engine's own `patternToRegExp` makes. Two spellings of one
	// rule disagreeing is how the original `--strict-prefix` bug happened.
	const dir = pattern
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replace(/%[a-zA-Z]+%/g, "[^/]+")
		.replace(/\\\{[a-zA-Z]+\\\}/g, "[^/]+");
	return new RegExp(`^${dir}[^/]+$`);
}

/**
 * Is this object FOREIGN — written by something other than this job?
 *
 * WHERE and WHEN, never WHAT IT IS CALLED . Two independent tests:
 *
 *   timestamp   written BEFORE the job row existed: pre-existing debris. Catches
 *               stale segments with IDENTICAL names — the 100 `seg_*.ts` files a
 *               June run left in a shared prefix, which is the incident
 *               `--strict-prefix` exists for and which no name test can see.
 *   place       the key sits in no directory this plan can write into. Catches a
 *               stranger dropped beside the output, at any depth, whatever it is
 *               called.
 *
 * The rule this REPLACES was "the basename matches no name the plan declares",
 * and it was structurally unable to be right. A verifier that decides membership
 * by name has to enumerate every name the run will produce, and a run produces
 * names the plan does not contain: the manifest generator resolves a per-title
 * ladder's variant playlists from the rungs the encoder chose. So the same false
 * FAIL kept coming back with a different family each time — media playlists and
 * QC mirrors , subtitle playlists
 * (review-325 I1), and finally the billed re-audit run B
 * `pertitle-h264-fmp4-ts-dash-hls-on-aws`, whose report was 481 PASS and one FAIL:
 * "objects under this plan's prefixes that this run did not write — 6". Those six
 * were its own `video_<avgBitrate>.m3u8` variant playlists. An allowlist of names
 * is a bug with a date; a directory is not, because C4 forces the run-time part of
 * a per-title path into a placeholder the plan itself carries.
 *
 * What the change gives up, deliberately: an object written INSIDE this job's
 * window, DIRECTLY in a directory the plan writes to, under any name, is no longer
 * foreign. Nothing in a listing can separate that from a rung the encoder named at
 * run time, and calling a run's own bytes someone else's is the failure this fix
 * exists to end — a false FAIL on a correct billed encode costs more than a missed
 * concurrent stranger, which the timestamp arm still catches whenever it predates us.
 *
 * `observedDirs` narrows nothing and only ADDS: directories the run demonstrably
 * wrote into, from the per-title capture snapshot (`perTitleRungDirsFromSnapshot`).
 * It is superset-safe on purpose — the snapshot records no output key, and whether
 * a dual-leg ladder's capture names BOTH legs' muxings is unmeasured, so it may
 * never be used to shrink the declared set.
 *
 * Exported, and the test imports THIS — it used to be a closure inside `verifyJob`
 * that the test re-implemented, so five mutations to the real one (including
 * deleting the timestamp arm, i.e. the entire fix) survived the whole suite (review
 * catch). A copy of the logic pins nothing.
 *
 * The matchers are built ONCE per job, not per key: the closure rebuilt them inside
 * itself, which on the ledger's 606-object prefix meant thousands of regex
 * compilations.
 */
export function makeForeignKeyFilter(
	expected: Pick<
		ExpectedArtefacts,
		"muxings" | "manifests" | "thumbnails" | "sprites"
	> & {
		drm?: { dir?: { pattern: string } }[];
		qc?: { mirrors: { dir: { pattern: string } }[] };
	},
	jobCreatedAt: Date,
	observedDirs: readonly string[] = [],
): (key: string, entry?: { lastModified?: string }) => boolean {
	const matchers = [
		...declaredDirPatterns(expected),
		...observedDirs.map((d) => (d.endsWith("/") ? d : `${d}/`)),
	].map(directoryMemberMatcher);
	const bornAt = jobCreatedAt.getTime();
	return (key, entry) => {
		const stamp = entry?.lastModified;
		if (stamp !== undefined) {
			const written = Date.parse(stamp);
			if (Number.isFinite(written) && written < bornAt) {
				return true;
			}
		}
		return !matchers.some((rx) => rx.test(key));
	};
}

/**
 * The hygiene checks that can only be known after the run, appended to a finished report.
 *
 * Extracted from `verifyJob` and exported because it is where the exit-code bug lived and
 * nothing could reach it: `verifyJob` needs a database, credentials and a bucket, so a
 * reviewer's five mutations to this logic — including never pushing the truncation check
 * at all, and downgrading it to WARN — every one survived the suite.
 *
 * The truncation verdict is FAIL, not WARN, and that is load-bearing rather than
 * stylistic: a bounded listing that stopped early means the report does NOT cover the
 * output it names, so "PASS with a note" is exactly the reassuring number this harness
 * exists to stop producing (design §5/§8). Everything goes through `appendCheck` so the
 * FAIL count — which `main` returns as the process exit code — moves with it.
 */
export function addHygieneChecks(
	report: VerificationReport,
	found: { truncations: string[]; unbrowsable: string[]; notes: string[] },
): void {
	if (found.truncations.length > 0) {
		appendCheck(report, {
			id: "hygiene:listing-truncated",
			area: "hygiene",
			verdict: "FAIL",
			detail: `listing stopped at its bound for ${found.truncations.join(", ")} — artefacts beyond that were NOT examined, so this report does not cover the whole output`,
		});
	}
	for (const reason of found.unbrowsable) {
		// A location we cannot open is a named SKIP, never an absent check.
		appendCheck(report, {
			id: "hygiene:unbrowsable-output",
			area: "hygiene",
			verdict: "SKIP",
			detail: reason,
		});
	}
	for (const note of found.notes) {
		appendCheck(report, {
			id: "note",
			area: "hygiene",
			verdict: "SKIP",
			detail: note,
		});
	}
}

/**
 * The directories one job's per-title capture recorded, or `[]` when there is no
 * capture to read.
 *
 * `[]` on EVERY failure path, and that is load-bearing rather than defensive: the
 * observed set only ever ADDS to what the plan declares (`makeForeignKeyFilter`),
 * so an absent, failed or unparseable capture costs the verifier nothing. Making
 * it throw would turn a job whose capture step failed — which the report already
 * says elsewhere — into a job that cannot be verified at all.
 */
export async function readPerTitleRungDirs(
	prisma: AppPrismaClient,
	encodingJobId: string,
): Promise<string[]> {
	return perTitleRungDirsOf(await readPerTitleView(prisma, encodingJobId));
}

/**
 * ONE read of the two fat JSON columns → the job's per-title results view, for
 * every reader `verifyJob` has (row 284): the rung directories the strict-prefix
 * filter consumes, and the RESULT codec families the per-title manifest check
 * consumes. `absent` on every failure path, for the reason `readPerTitleRungDirs`
 * gives — an unreadable capture must degrade to "unknown", never to "empty".
 */
export async function readPerTitleView(
	prisma: AppPrismaClient,
	encodingJobId: string,
): Promise<PerTitleResultsView> {
	return (await readPerTitleEvidence(prisma, encodingJobId)).view;
}

/** RESULT capture plus the provider output identities needed to bind its legs. */
export async function readPerTitleEvidence(
	prisma: AppPrismaClient,
	encodingJobId: string,
): Promise<{
	view: PerTitleResultsView;
	providerOutputIds: Record<string, string>;
}> {
	const row = await prisma.encodingJob.findUnique({
		where: { id: encodingJobId },
		select: { stepLog: true, snapshots: true },
	});
	if (!row) {
		return { view: { origin: "absent" }, providerOutputIds: {} };
	}
	const parsedLog = stepLogSchema.safeParse(row.stepLog);
	const providerOutputIds = parsedLog.success
		? Object.fromEntries(
				parsedLog.data.flatMap((entry) =>
					entry.status === "DONE" &&
					entry.step.startsWith("output:") &&
					entry.resourceId
						? [[entry.step.slice("output:".length), entry.resourceId] as const]
						: [],
				),
			)
		: {};
	return {
		view: perTitleResultsView({
			stepLog: row.stepLog,
			snapshots: row.snapshots,
		}),
		providerOutputIds,
	};
}

/** The directories a captured ladder wrote into, or `[]` when nothing was captured. */
export function perTitleRungDirsOf(view: PerTitleResultsView): string[] {
	return view.origin === "step" || view.origin === "snapshot"
		? perTitleRungDirsFromSnapshot(view.snapshot)
		: [];
}

/** The AUTO measurement row as `verifyJob` reads it — or null when none exists. */
export type AutoVmafRow = {
	status: string;
	error: string | null;
	model: string;
	gateVerdict: unknown;
	results: { renditionRef: unknown; pooled: unknown; provenance: unknown }[];
} | null;

/** The AUTO row for one encoding job — never a lab-manual re-run . */
export async function readAutoVmaf(
	prisma: AppPrismaClient,
	encodingJobId: string,
): Promise<AutoVmafRow> {
	return prisma.vmafJob.findFirst({
		where: { encodingJobId, triggerKey: autoTriggerKey(encodingJobId) },
		orderBy: { createdAt: "desc" },
		select: {
			status: true,
			error: true,
			model: true,
			gateVerdict: true,
			results: {
				select: { renditionRef: true, pooled: true, provenance: true },
			},
		},
	});
}

function providerResultFromProvenance(
	value: unknown,
): PerTitleProviderResult | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const providerResult = (value as { providerResult?: unknown }).providerResult;
	if (
		typeof providerResult !== "object" ||
		providerResult === null ||
		Array.isArray(providerResult)
	) {
		return undefined;
	}
	const candidate = providerResult as Record<string, unknown>;
	if (
		!["streamId", "muxingId", "outputId", "resolvedPath"].every(
			(field) =>
				typeof candidate[field] === "string" &&
				(candidate[field] as string).length > 0,
		)
	) {
		return undefined;
	}
	return {
		streamId: candidate.streamId as string,
		muxingId: candidate.muxingId as string,
		outputId: candidate.outputId as string,
		resolvedPath: candidate.resolvedPath as string,
	};
}

function sameProviderResult(
	a: PerTitleProviderResult,
	b: PerTitleProviderResult,
): boolean {
	return (
		a.streamId === b.streamId &&
		a.muxingId === b.muxingId &&
		a.outputId === b.outputId &&
		a.resolvedPath === b.resolvedPath
	);
}

function providerResultKey(value: PerTitleProviderResult): string {
	return JSON.stringify([
		value.streamId,
		value.muxingId,
		value.outputId,
		value.resolvedPath,
	]);
}

/**
 * The QC MEASUREMENT, joined to the report .
 *
 * The verifier checked that every QC mirror EXISTED and never asked whether anything
 * scored it: the paid runner carried zero references to `VmafJob`, so a plan with
 * `qc.vmaf` whose measurement ERRORed — or never ran, or produced 0 results, as the real
 * Live A/E and per-title runs did — passed with `qc:mirror:*` green. A mirror is billed
 * encoder output; a mirror nobody scored is the expensive way to verify nothing.
 *
 * The join is to the AUTO row (`vod-auto:<id>`), which is the measurement that gated
 * delivery — a lab-manual re-run on the same job is a different row with its own verdict
 * (#198) and must not stand in for it. Population is EXACT: one result per expected
 * mirror rendition, by key, no extras and no duplicates; a per-title rendition is one
 * key with ≥1 rung (its exact rung count is the CAPTURED ladder's, HIGH-10, not this
 * check's). Every verdict here goes through `appendCheck` so `main`'s exit code and
 * the runner's scenario verdict move with it.
 *
 * Extracted and exported for the reason `addHygieneChecks` was: `verifyJob` needs a
 * database, credentials and a bucket, so a rule left inline there is a rule nothing can
 * reach. The call site is pinned by shape in job-qc-join.test.ts — the only pin the
 * function's dependencies allow, and named as such.
 */
export function addQcMeasurementChecks(
	report: VerificationReport,
	found: {
		expected: Pick<ExpectedArtefacts, "qc" | "muxings">;
		/** `plan.qc.gate`, when the plan carries one. */
		gate: unknown;
		job: { status: string; qcOverriddenAt: Date | null };
		/** Actual RESULT/QC units; present for every per-title verification. */
		perTitlePopulations?: PerTitleActualPopulations;
		vmaf: AutoVmafRow;
	},
): void {
	const qc = found.expected.qc;
	if (!qc) {
		return;
	}
	const { vmaf } = found;
	if (!vmaf) {
		appendCheck(report, {
			id: "qc:measurement",
			area: "qc",
			verdict: "FAIL",
			detail:
				"no AUTO VmafJob for this job — the trigger never fired or QC/VMAF is off, so the QC mirrors were encoded and nothing scored them",
		});
		return;
	}
	if (vmaf.status !== "FINISHED") {
		appendCheck(report, {
			id: "qc:measurement",
			area: "qc",
			verdict: "FAIL",
			detail:
				vmaf.status === "ERROR"
					? `AUTO VmafJob ERROR — ${vmaf.error ?? "no error recorded"}`
					: `AUTO VmafJob still ${vmaf.status} at verify time — a report cannot vouch for a measurement that has not finished; re-verify after it does`,
		});
		return;
	}
	appendCheck(report, {
		id: "qc:measurement",
		area: "qc",
		verdict: "PASS",
		detail: `AUTO VmafJob FINISHED (model ${vmaf.model}, ${vmaf.results.length} result row(s))`,
	});

	// ---- population: exactly the mirrors / provider RESULT units ----------------
	const renditionKeys = qc.mirrors.map((m) => m.renditionKey);
	const perTitleKeys = new Set(
		renditionKeys.filter((key) =>
			found.expected.muxings.some((m) => m.renditionKey === key && m.perTitle),
		),
	);
	if (perTitleKeys.size > 0 && found.perTitlePopulations === undefined) {
		const measuredRenditions = new Set(
			vmaf.results.flatMap((row) => {
				const ref = row.renditionRef as { renditionKey?: unknown } | null;
				return typeof ref?.renditionKey === "string" ? [ref.renditionKey] : [];
			}),
		);
		const plainlyMissing = renditionKeys.filter(
			(key) => !measuredRenditions.has(key),
		);
		appendCheck(report, {
			id: "qc:results",
			area: "qc",
			verdict: plainlyMissing.length > 0 ? "FAIL" : "SKIP",
			detail:
				plainlyMissing.length > 0
					? `unmeasured: ${plainlyMissing.join(", ")}; UNVERIFIED per-title QC population: no exact provider RESULT/output population was supplied`
					: "UNVERIFIED per-title QC population: no exact provider RESULT/output population was supplied",
		});
	} else if (
		found.perTitlePopulations !== undefined &&
		found.perTitlePopulations.status !== "complete"
	) {
		appendCheck(report, {
			id: "qc:results",
			area: "qc",
			verdict: "SKIP",
			detail: `UNVERIFIED per-title QC population: ${found.perTitlePopulations.reason}`,
		});
	} else {
		const exactPopulation =
			found.perTitlePopulations?.status === "complete"
				? found.perTitlePopulations
				: undefined;
		const exactPerTitle = exactPopulation !== undefined;
		const exactPopulationProblems: string[] = [];
		if (exactPopulation !== undefined && perTitleKeys.size > 0) {
			const resultCounts = new Map<string, number>();
			for (const result of exactPopulation.results) {
				resultCounts.set(
					result.streamId,
					(resultCounts.get(result.streamId) ?? 0) + 1,
				);
			}
			const qcByStream = new Map<string, typeof exactPopulation.qc>();
			for (const unit of exactPopulation.qc) {
				qcByStream.set(unit.streamId, [
					...(qcByStream.get(unit.streamId) ?? []),
					unit,
				]);
			}
			if (exactPopulation.results.length === 0) {
				exactPopulationProblems.push("empty provider RESULT population");
			}
			for (const [streamId, count] of resultCounts) {
				if (count !== 1) {
					exactPopulationProblems.push(
						`provider RESULT ${streamId} occurs ${count} times`,
					);
					continue;
				}
				const result = exactPopulation.results.find(
					(candidate) => candidate.streamId === streamId,
				);
				if (result?.templateRendition === undefined) {
					exactPopulationProblems.push(
						`unattributed provider RESULT ${streamId}`,
					);
				} else if (!perTitleKeys.has(result.templateRendition)) {
					exactPopulationProblems.push(
						`provider RESULT ${streamId} names unknown template ${result.templateRendition}`,
					);
				}
				const units = qcByStream.get(streamId) ?? [];
				if (units.length !== 1) {
					exactPopulationProblems.push(
						`provider RESULT ${streamId} has ${units.length} QC population rows`,
					);
				} else if (units[0]?.templateRendition !== result?.templateRendition) {
					exactPopulationProblems.push(
						`provider RESULT ${streamId} and its QC unit disagree on template identity`,
					);
				}
			}
			for (const streamId of qcByStream.keys()) {
				if (!resultCounts.has(streamId)) {
					exactPopulationProblems.push(
						`QC population row ${streamId} has no provider RESULT`,
					);
				}
			}
		}
		const expectedKeys = exactPerTitle
			? [
					...renditionKeys.filter((key) => !perTitleKeys.has(key)),
					...exactPopulation.qc.flatMap((unit) =>
						unit.templateRendition !== undefined &&
						perTitleKeys.has(unit.templateRendition)
							? [`${unit.templateRendition}:${unit.variant}`]
							: [],
					),
				]
			: renditionKeys;
		const counts = new Map<string, number>();
		for (const row of vmaf.results) {
			const ref = row.renditionRef as {
				renditionKey?: unknown;
				perTitleVariant?: unknown;
			} | null;
			const renditionKey =
				typeof ref?.renditionKey === "string" ? ref.renditionKey : "(unkeyed)";
			const key =
				exactPerTitle &&
				perTitleKeys.has(renditionKey) &&
				typeof ref?.perTitleVariant === "string"
					? `${renditionKey}:${ref.perTitleVariant}`
					: renditionKey;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		const expectedSet = new Set(expectedKeys);
		const missing = [...expectedSet].filter((key) => !counts.has(key));
		const extra = [...counts.keys()].filter((key) => !expectedSet.has(key));
		const duplicated = [...expectedSet].filter(
			(key) =>
				(counts.get(key) ?? 0) > 1 && (exactPerTitle || !perTitleKeys.has(key)),
		);
		const expectedDuplicates = expectedKeys.filter(
			(key, index) => expectedKeys.indexOf(key) !== index,
		);
		const provenanceProblems: string[] = [];
		if (exactPopulation !== undefined && perTitleKeys.size > 0) {
			const unitsByKey = new Map<string, (typeof exactPopulation.qc)[number]>(
				exactPopulation.qc.flatMap((unit) =>
					unit.templateRendition !== undefined &&
					perTitleKeys.has(unit.templateRendition)
						? [[`${unit.templateRendition}:${unit.variant}`, unit] as const]
						: [],
				),
			);
			const usedProviderResults = new Map<string, string>();
			for (const row of vmaf.results) {
				const ref = row.renditionRef as {
					renditionKey?: unknown;
					perTitleVariant?: unknown;
				} | null;
				if (
					typeof ref?.renditionKey !== "string" ||
					!perTitleKeys.has(ref.renditionKey) ||
					typeof ref.perTitleVariant !== "string"
				) {
					continue;
				}
				const resultKey = `${ref.renditionKey}:${ref.perTitleVariant}`;
				const unit = unitsByKey.get(resultKey);
				if (unit === undefined) {
					continue;
				}
				const providerResult = providerResultFromProvenance(row.provenance);
				if (providerResult === undefined) {
					provenanceProblems.push(
						`${resultKey} is missing exact provider RESULT provenance`,
					);
					continue;
				}
				if (
					!unit.mirrors.some((mirror) =>
						sameProviderResult(providerResult, mirror),
					)
				) {
					provenanceProblems.push(
						`${resultKey} provenance does not match its provider QC mirror`,
					);
					continue;
				}
				const identityKey = providerResultKey(providerResult);
				const first = usedProviderResults.get(identityKey);
				if (first !== undefined) {
					provenanceProblems.push(
						`${resultKey} reuses the exact provider QC mirror already claimed by ${first}`,
					);
				} else {
					usedProviderResults.set(identityKey, resultKey);
				}
			}
		}
		const problems = [
			...exactPopulationProblems,
			...provenanceProblems,
			...(missing.length ? [`unmeasured: ${missing.join(", ")}`] : []),
			...(extra.length ? [`not in the plan: ${extra.join(", ")}`] : []),
			...(duplicated.length
				? [`measured more than once: ${duplicated.join(", ")}`]
				: []),
			...(expectedDuplicates.length
				? [
						`provider QC unit repeated: ${[...new Set(expectedDuplicates)].join(", ")}`,
					]
				: []),
		];
		const tally = [...expectedSet]
			.map((key) =>
				!exactPerTitle && perTitleKeys.has(key)
					? `${key}×${counts.get(key) ?? 0} rung(s)`
					: `${key}×${counts.get(key) ?? 0}`,
			)
			.join(", ");
		appendCheck(report, {
			id: "qc:results",
			area: "qc",
			verdict: problems.length === 0 ? "PASS" : "FAIL",
			detail:
				problems.length === 0
					? exactPerTitle
						? `exact provider RESULT/QC unit set — ${tally}`
						: `one result per QC mirror rendition — ${tally}${perTitleKeys.size ? " (per-title rung counts are the captured ladder's, not checked here)" : ""}`
					: `${problems.join("; ")} — expected ${[...expectedSet].join(", ")}; found ${tally}`,
		});
	}

	// ---- scores: a FINISHED row with no usable number is the Live A/E shape -----
	if (vmaf.results.length > 0) {
		const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
		const bad = vmaf.results.flatMap((row, i) => {
			const pooled = row.pooled as Partial<PooledMetrics> | null;
			const ref = row.renditionRef as { renditionKey?: unknown } | null;
			const label =
				typeof ref?.renditionKey === "string" ? ref.renditionKey : `#${i}`;
			const faults: string[] = [];
			if (!finite(pooled?.mean)) {
				faults.push("no finite VMAF mean");
			}
			if (qc.psnr && !finite(pooled?.psnr?.mean)) {
				faults.push("no finite PSNR mean");
			}
			return faults.length ? [`${label}: ${faults.join(", ")}`] : [];
		});
		appendCheck(report, {
			id: "qc:scores",
			area: "qc",
			verdict: bad.length === 0 ? "PASS" : "FAIL",
			detail:
				bad.length === 0
					? `every result carries a finite VMAF mean${qc.psnr ? " and PSNR mean" : ""}`
					: bad.join("; "),
		});
	}

	// ---- model: only when the plan pinned one ------------------------------------
	if (qc.model !== undefined) {
		appendCheck(report, {
			id: "qc:model",
			area: "qc",
			verdict: vmaf.model === qc.model ? "PASS" : "FAIL",
			detail: `scored with ${vmaf.model} — the plan pinned ${qc.model}`,
		});
	}

	// ---- gate: the verdict must exist, and delivery must agree with it ------------
	if (found.gate !== undefined) {
		const verdict = vmaf.gateVerdict as QcVerdict | null;
		if (!verdict || typeof verdict.pass !== "boolean") {
			appendCheck(report, {
				id: "qc:gate",
				area: "qc",
				verdict: "FAIL",
				detail:
					"the plan carries qc.gate and the FINISHED measurement has no gateVerdict — nothing decided delivery",
			});
		} else if (verdict.pass) {
			appendCheck(report, {
				id: "qc:gate",
				area: "qc",
				verdict: "PASS",
				detail: `gate PASSED (${verdict.ruleResults.length} rule(s))`,
			});
		} else if (found.job.qcOverriddenAt) {
			appendCheck(report, {
				id: "qc:gate",
				area: "qc",
				verdict: "WARN",
				detail: `gate FAILED and delivery was FORCED past it (override at ${found.job.qcOverriddenAt.toISOString()})`,
			});
		} else {
			const blocked = found.job.status === "QC_FAILED";
			appendCheck(report, {
				id: "qc:gate",
				area: "qc",
				verdict: blocked ? "PASS" : "FAIL",
				detail: blocked
					? "gate FAILED and delivery is blocked (QC_FAILED)"
					: `gate FAILED but the job is ${found.job.status} with no override — delivery escaped the gate`,
			});
		}
	}
}

/**
 * The process exit code for a finished report, and why it is non-zero.
 *
 * Extracted from `main`, which needs a database and credentials — so a reviewer's
 * mutation deleting the zero-PASS guard survived the whole suite. An exit code is this
 * CLI's entire contract with the nightly job; it should not be the least reachable line
 * in the file.
 *
 * A report with NO PASS verified nothing, whatever its FAIL count says: every DRM row
 * SKIPping, or an output that could not be opened at all, used to exit 0 and read as
 * green. Design §5 calls that INVALID, and INVALID is never product-green.
 */
export function exitCodeFor(report: VerificationReport): {
	code: number;
	invalid?: string;
} {
	if (report.counts.PASS === 0) {
		return {
			code: Math.max(1, report.failed),
			invalid:
				"no check PASSed — this report verified nothing, which is not a pass",
		};
	}
	if (report.failed === 0) {
		const unverified = perTitleUnverifiedChecks(report);
		if (unverified.length > 0) {
			return {
				code: 1,
				invalid: `per-title evidence is UNVERIFIED — ${unverified
					.map((check) => `${check.id}: ${check.detail}`)
					.join("; ")}`,
			};
		}
	}
	/**
	 * A PASS built mostly on SKIPs is the shape that survives every other floor.
	 *
	 * The zero-PASS rule catches a report that verified NOTHING. It says nothing about one
	 * that verified three things and skipped twelve — and none of the other floors fire when
	 * *some* checks evaluated, which a reviewer identified as the most likely remaining
	 * place for a false green now that real artefacts are arriving.
	 *
	 * Not a FAIL: a legitimately capability-limited run has real SKIPs, and failing those
	 * would be the false-red mistake this project has made repeatedly. It is reported, and
	 * the caller decides — which is what `invalid` already means here.
	 */
	const evaluated = report.counts.PASS + report.counts.FAIL;
	if (evaluated > 0 && report.counts.SKIP > evaluated * 2) {
		return {
			code: report.failed,
			invalid: `${report.counts.SKIP} checks SKIPped against ${evaluated} evaluated — this report is mostly absences, so read it as "what could be checked" rather than as a verdict on the output`,
		};
	}
	return { code: report.failed };
}

export function browsable(
	entry:
		| EncodingPlan["outputs"][number]
		| EncodingPlan["inputs"][number]
		| undefined,
	role: string,
): Browsable {
	if (!entry) {
		return { ok: false, reason: `${role} is not declared in the plan` };
	}
	if ("bucket" in entry && "credentialId" in entry) {
		return { ok: true, bucket: entry.bucket, credentialId: entry.credentialId };
	}
	if ("container" in entry && "credentialId" in entry) {
		return {
			ok: true,
			bucket: entry.container,
			credentialId: entry.credentialId,
		};
	}
	return {
		ok: false,
		reason: `${role} is a ${entry.kind} location, which has no browsable container`,
	};
}

export type VerifyJobOptions = {
	prisma: AppPrismaClient;
	ffprobePath: string;
	/** Job id, or a unique prefix of one. */
	jobIdPrefix: string;
	/**
	 * When true, an object is FOREIGN if it was written before this job's creation time
	 * OR sits in no directory this plan can write into — see `makeForeignKeyFilter`.
	 *
	 * This exists because a real output prefix was found holding another run's
	 * manifests and fifty-odd segments from six weeks earlier. Verifying a historical
	 * job against a shared prefix without this reports another run's files as evidence.
	 */
	excludeOlderThanJob?: boolean;
	log?: (line: string) => void;
};

export type VerifyJobResult = {
	jobId: string;
	jobName: string;
	status: string;
	report: VerificationReport;
	/** Facts about the source, so the report can state what it compared against. */
	reference?: {
		durationSec?: number;
		fps?: number;
		nbFrames?: number;
		videoDurationSec?: number;
	};
};

/** Resolve a plan output/input key to a live browser + bucket. */
async function browserFor(
	prisma: AppPrismaClient,
	credentialId: string,
): Promise<ObjectStorageBrowser> {
	const credentials = createCredentialStore(prisma, cipherFromEnv());
	const row = await credentials.get(credentialId);
	if (!row) {
		throw new Error(`credential ${credentialId} no longer exists`);
	}
	return createBrowserForCredential({
		provider: row.provider,
		config: (row.config ?? {}) as Record<string, unknown>,
		secret: JSON.parse(await credentials.revealSecret(credentialId)) as Record<
			string,
			string
		>,
	});
}

export async function verifyJob(
	options: VerifyJobOptions,
): Promise<VerifyJobResult> {
	const log = options.log ?? (() => {});
	const rows = await options.prisma.encodingJob.findMany({
		select: {
			id: true,
			name: true,
			status: true,
			plan: true,
			createdAt: true,
			qcOverriddenAt: true,
		},
		orderBy: { createdAt: "desc" },
		take: 200,
	});
	const job = rows.find((r) => r.id.startsWith(options.jobIdPrefix));
	if (!job) {
		throw new Error(
			`no EncodingJob whose id starts with "${options.jobIdPrefix}"`,
		);
	}
	const plan: EncodingPlan = encodingPlanSchema.parse(job.plan);
	const expected = compileExpectedArtefacts(plan);
	/**
	 * The job's per-title capture, read ONCE for its two consumers (row 284).
	 *
	 * Read in its OWN query: `stepLog`/`snapshots` are the two fat JSON columns,
	 * and the row above is a 200-row scan used only to resolve an id prefix. Only
	 * a per-title plan has a capture to read; a fixed-ladder verify fetches
	 * neither column — a query whose result nothing reads is not a cheap query.
	 *
	 * Two consumers, and they gate differently:
	 *  - the RESULT codec families feed the per-title manifest's three-way family
	 *    check on EVERY per-title verify (an absent capture makes that check an
	 *    explicit UNVERIFIED, never a PASS);
	 *  - the rung directories feed `makeForeignKeyFilter`, which is built solely
	 *    under `excludeOlderThanJob`. Attribution is NOT required (
	 *    abstains on any ladder with two templates of one codec, which is most
	 *    of them) — `perTitleRungDirsFromSnapshot` reads the resolved output
	 *    paths directly.
	 */
	const perTitleEvidence = planHasPerTitle(plan)
		? await readPerTitleEvidence(options.prisma, job.id)
		: undefined;
	const perTitleView = perTitleEvidence?.view;
	const observedRungDirs =
		perTitleView !== undefined && options.excludeOlderThanJob === true
			? perTitleRungDirsOf(perTitleView)
			: [];
	const perTitleActual =
		perTitleView !== undefined
			? perTitleActualVideoFamilies(perTitleView)
			: undefined;
	const perTitlePopulations =
		perTitleView !== undefined
			? perTitleActualPopulations(perTitleView)
			: undefined;
	const scratch = await mkdtemp(join(tmpdir(), "verify-job-"));

	try {
		// ---- one browser per plan output ---------------------------------------
		const outputs = new Map<
			string,
			{ bucket: string; browser: ObjectStorageBrowser }
		>();
		const unbrowsable: string[] = [];
		for (const outputKey of expected.outputKeys) {
			const where = browsable(
				plan.outputs.find((o) => o.key === outputKey),
				`output "${outputKey}"`,
			);
			if (!where.ok) {
				unbrowsable.push(where.reason);
				continue;
			}
			outputs.set(outputKey, {
				bucket: where.bucket,
				browser: await browserFor(options.prisma, where.credentialId),
			});
		}

		// ---- reference facts, so segment counts and fps mean something ----------
		let reference: VerifyJobResult["reference"];
		const ingest = plan.ingest?.[0];
		const where = browsable(
			plan.inputs.find((i) => i.key === ingest?.inputKey),
			"the reference input",
		);
		if (ingest && where.ok) {
			try {
				const browser = await browserFor(options.prisma, where.credentialId);
				if (browser.getObject) {
					const { createWriteStream } = await import("node:fs");
					const { pipeline } = await import("node:stream/promises");
					const refPath = join(scratch, "reference");
					await pipeline(
						await browser.getObject({
							bucket: where.bucket,
							key: ingest.inputPath,
						}),
						createWriteStream(refPath),
					);
					const probed = await probeFile(options.ffprobePath, refPath);
					reference = {
						...(probed.durationSec !== undefined
							? { durationSec: probed.durationSec }
							: {}),
						// The VIDEO stream's own length, which is what a video muxing's segment
						// count must divide — see `outputDurationSec` in engine.ts.
						...(probed.videoDurationSec !== undefined
							? { videoDurationSec: probed.videoDurationSec }
							: {}),
						...(probed.fps !== undefined ? { fps: probed.fps } : {}),
						...(probed.nbFrames !== undefined
							? { nbFrames: probed.nbFrames }
							: {}),
					};
					log(
						`reference ${ingest.inputPath}: ${probed.width}x${probed.height} ${probed.videoCodec} ${probed.fps?.toFixed(3)}fps ${probed.nbFrames} frames — container ${probed.durationSec?.toFixed(2)}s, video ${probed.videoDurationSec?.toFixed(2) ?? "?"}s`,
					);
				}
			} catch (err) {
				// A missing source is worth reporting, not worth aborting: every artefact
				// check that does not need a duration still runs.
				log(
					`reference unavailable (${err instanceof Error ? err.message : String(err)}) — duration-derived checks will SKIP`,
				);
			}
		}

		const truncations: string[] = [];
		const deps = makeEngineDeps({
			outputFor: (outputKey) => {
				const hit = outputs.get(outputKey);
				if (!hit) {
					throw new Error(`plan output "${outputKey}" has no credential`);
				}
				return hit;
			},
			scratchDir: scratch,
			ffprobePath: options.ffprobePath,
			...(reference ? { reference } : {}),
			...(options.excludeOlderThanJob
				? {
						foreignKeyFilter: makeForeignKeyFilter(
							expected,
							job.createdAt,
							observedRungDirs,
						),
					}
				: {}),
			onTruncated: (outputKey, prefix) => {
				truncations.push(`${outputKey}:${prefix}`);
			},
		});
		// The third witness of the per-title family comparison (row 284) rides
		// beside the I/O seam, exactly as `reference` does.
		if (perTitleActual !== undefined) {
			deps.perTitleActual = perTitleActual;
		}
		if (perTitlePopulations !== undefined && perTitleEvidence !== undefined) {
			deps.perTitlePopulations = perTitlePopulations;
			deps.providerOutputIds = perTitleEvidence.providerOutputIds;
		}

		const report = await verifyArtefacts(expected, deps);
		addHygieneChecks(report, {
			truncations,
			unbrowsable,
			notes: expected.notes,
		});
		// : the measurement, joined — read only when the plan asked for one.
		if (expected.qc) {
			addQcMeasurementChecks(report, {
				expected,
				gate: plan.qc?.gate,
				job: { status: String(job.status), qcOverriddenAt: job.qcOverriddenAt },
				...(perTitlePopulations ? { perTitlePopulations } : {}),
				vmaf: await readAutoVmaf(options.prisma, job.id),
			});
		}

		return {
			jobId: job.id,
			jobName: job.name,
			status: String(job.status),
			report,
			...(reference ? { reference } : {}),
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Human-readable report, grouped by verdict so failures are not buried. */
export function formatReport(result: VerifyJobResult): string {
	const lines: string[] = [
		`job ${result.jobId}  "${result.jobName}"  status=${result.status}`,
	];
	if (result.reference) {
		lines.push(
			`reference: ${result.reference.durationSec?.toFixed(2)}s @ ${result.reference.fps?.toFixed(3)}fps (${result.reference.nbFrames} frames)`,
		);
	}
	lines.push("");
	for (const verdict of ["FAIL", "WARN", "SKIP", "PASS"] as const) {
		const hits = result.report.checks.filter((c) => c.verdict === verdict);
		if (hits.length === 0) {
			continue;
		}
		lines.push(`--- ${verdict} (${hits.length})`);
		for (const c of hits) {
			lines.push(`  ${c.id.padEnd(34)} ${c.detail}`);
		}
		lines.push("");
	}
	const { PASS, WARN, FAIL, SKIP } = result.report.counts;
	lines.push(`PASS ${PASS}  WARN ${WARN}  FAIL ${FAIL}  SKIP ${SKIP}`);
	return lines.join("\n");
}

/** CLI entry: `tsx src/verify/job.ts <jobId> [--strict-prefix]`. */
export async function main(argv: string[]): Promise<number> {
	const jobIdPrefix = argv[0];
	if (!jobIdPrefix) {
		console.error(
			"usage: verify job <encodingJobId|prefix> [--strict-prefix]\n\n" +
				"  --strict-prefix  treat as FOREIGN any object written BEFORE this job, or\n" +
				"                   sitting in no directory the plan can write into. WHERE\n" +
				"                   and WHEN, never what a file is called: the run names its\n" +
				"                   own per-title artefacts and no static list of names can\n" +
				"                   contain them (ledger #252).\n" +
				"                   Foreign objects FAIL (design §8).",
		);
		return 2;
	}
	const prisma = createPrismaClient(process.env.DATABASE_URL);
	try {
		const result = await verifyJob({
			prisma,
			ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
			jobIdPrefix,
			excludeOlderThanJob: argv.includes("--strict-prefix"),
			log: (line) => console.log(`[verify] ${line}`),
		});
		console.log(formatReport(result));
		const { code, invalid } = exitCodeFor(result.report);
		if (invalid) {
			console.error(`INVALID: ${invalid}`);
		}
		return code;
	} finally {
		await prisma.$disconnect();
	}
}
