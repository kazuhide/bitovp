import { LIVE_EVIDENCE_VERSION } from "@bitovp/core";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/messages/en";
import { ja } from "@/lib/i18n/messages/ja";
import { renderLocalized } from "@/test/render";
import { RunDetail } from "./[id]/run-detail";
import type { VerificationRunDetail, VerificationRunSummary } from "./types";
import { RunTable } from "./verification-client";

/**
 * The release-evidence screens. Rendered from fixture rows, on
 * purpose: a detail view that can only be SEEN by paying for an encode is the
 * shape this whole feature exists to stop repeating.
 */

const SUMMARY: VerificationRunSummary = {
	id: "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11",
	runId: "2026-08-29T10-00-00-000-abcdef",
	kind: "VOD",
	status: "SEALED",
	startedAt: "2026-08-29T10:00:00.000Z",
	finishedAt: "2026-08-29T10:30:00.000Z",
	commit: "abcdef0123456789",
	drift: false,
	counts: { PASS: 23, WARN: 6, FAIL: 0, SKIP: 44, INVALID: 0 },
	sealed: true,
	bitmovinAccountId: null,
};

const DETAIL: VerificationRunDetail = {
	...SUMMARY,
	bitmovinAccountId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
	checkoutLatestMigration: "20260829120000_verification_run",
	dbLatestMigration: "20260828150000_vmaf_result_provenance",
	drift: true,
	baseUrlOrigin: "https://ovp.example.com",
	actor: "token:tok-1",
	sourceObject: "bbb-short.mov",
	sourceIdentity: "etag=abc;size=42",
	resumedFromId: "11111111-1111-4111-8111-111111111111",
	resumedFrom: {
		id: "11111111-1111-4111-8111-111111111111",
		runId: "2026-08-28T09-00-00-000-aaaaaa",
		status: "SEALED",
		retentionUntil: "2026-11-26T09:30:01.000Z",
	},
	resumeDecision: {
		decision: "ACCEPTED",
		reason: "DB, report, seal, fingerprint and scenario evidence agree",
	},
	outcomes: [
		{
			scenario: "h264-hls",
			verdict: "PASS",
			reason: "17 checks passed",
			jobId: "job-1",
			encodingId: "enc-1",
			planSha256: "0123456789abcdef0123",
			checks: { passed: 17, failed: 0 },
		},
		{
			scenario: "vp9-webm-fixed-dash",
			verdict: "FAIL",
			reason: "manifest missing",
		},
	],
	providerReadback: { "enc-1": "CANCELED", "enc-2": "FINISHED" },
	cleanup: [
		{
			scenario: "h264-hls",
			jobId: "job-1",
			status: "CANCELED",
			cancelHttp: 202,
			terminal: true,
			localTerminal: true,
			providerTerminal: true,
			encodingIds: ["enc-1"],
		},
	],
	reportPath: "verify-runs/2026-08-29T10-00-00-000-abcdef/report.json",
	reportSha256: "deadbeefcafe",
	seal: "hmac-sha256:0011223344",
	sealAlgorithm: "HMAC_SHA256",
	sealKeyId: "release-2026-08",
	evidenceVersion: 1,
	evidenceManifest: { version: 1, scenarios: [] },
	retentionUntil: "2026-11-27T10:30:01.000Z",
	sealedAt: "2026-08-29T10:30:01.000Z",
	error: null,
};

describe("the verification-run list", () => {
	it("links each run to its detail page and shows its verdict counts", () => {
		renderLocalized(<RunTable items={[SUMMARY]} />);
		const link = screen.getByRole("link", {
			name: "2026-08-29T10-00-00-000-abcdef",
		});
		expect(link).toHaveAttribute(
			"href",
			"/verification/3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11",
		);
		expect(screen.getByText("SEALED")).toBeInTheDocument();
		expect(screen.getByText("PASS 23")).toBeInTheDocument();
		expect(screen.getByText("SKIP 44")).toBeInTheDocument();
		// A zero count is noise in a list of five verdicts.
		expect(screen.queryByText("FAIL 0")).toBeNull();
	});

	/**
	 * The two states a reader must never miss: a run that produced no seal, and
	 * one whose checkout and database were on different migrations.
	 */
	it("flags an unsealed run and a drifted one", () => {
		renderLocalized(
			<RunTable
				items={[{ ...SUMMARY, status: "RUNNING", sealed: false, drift: true }]}
			/>,
		);
		expect(screen.getByText(en.verification.notSealed)).toBeInTheDocument();
		expect(screen.getByText(en.verification.drift)).toBeInTheDocument();
	});

	it("does not flag a sealed, undrifted run", () => {
		renderLocalized(<RunTable items={[SUMMARY]} />);
		expect(screen.queryByText(en.verification.notSealed)).toBeNull();
		expect(screen.queryByText(en.verification.drift)).toBeNull();
	});

	it("says so when nothing has been recorded", () => {
		renderLocalized(<RunTable items={[]} />);
		expect(screen.getByText(en.verification.noRuns)).toBeInTheDocument();
	});
});

describe("the verification-run detail", () => {
	it("renders the fingerprint, including the drift verdict in words", () => {
		renderLocalized(<RunDetail run={DETAIL} />);
		const section = screen.getByLabelText(en.verification.fingerprint);
		expect(within(section).getByText("abcdef0123456789")).toBeInTheDocument();
		expect(
			within(section).getByText("20260829120000_verification_run"),
		).toBeInTheDocument();
		expect(
			within(section).getByText("20260828150000_vmaf_result_provenance"),
		).toBeInTheDocument();
		expect(
			within(section).getByText(en.verification.driftYes),
		).toBeInTheDocument();
		expect(within(section).getByText("token:tok-1")).toBeInTheDocument();
		expect(
			within(section).getByText("https://ovp.example.com"),
		).toBeInTheDocument();
		expect(
			within(section).getByText("2026-08-28T09-00-00-000-aaaaaa"),
		).toHaveAttribute(
			"href",
			"/verification/11111111-1111-4111-8111-111111111111",
		);
		expect(within(section).getByText(/ACCEPTED:/)).toBeInTheDocument();
	});

	/** A NAME says nothing about bytes, so both are shown. */
	it("renders the source object AND the identity of its bytes", () => {
		renderLocalized(<RunDetail run={DETAIL} />);
		const section = screen.getByLabelText(en.verification.source);
		expect(within(section).getByText("bbb-short.mov")).toBeInTheDocument();
		expect(within(section).getByText("etag=abc;size=42")).toBeInTheDocument();
	});

	it("says the identity was not recorded rather than showing an empty cell", () => {
		renderLocalized(<RunDetail run={{ ...DETAIL, sourceIdentity: null }} />);
		const section = screen.getByLabelText(en.verification.source);
		expect(
			within(section).getByText(en.verification.sourceIdentityUnknown),
		).toBeInTheDocument();
	});

	it("renders one row per scenario, linking the encoding id to its job", () => {
		renderLocalized(<RunDetail run={DETAIL} />);
		const section = screen.getByLabelText(en.verification.scenarios);
		expect(within(section).getByText("h264-hls")).toBeInTheDocument();
		expect(
			within(section).getByText("vp9-webm-fixed-dash"),
		).toBeInTheDocument();
		expect(within(section).getByText("PASS")).toBeInTheDocument();
		expect(within(section).getByText("FAIL")).toBeInTheDocument();
		expect(within(section).getByText("manifest missing")).toBeInTheDocument();
		expect(within(section).getByText("passed 17")).toBeInTheDocument();
		// The plan digest is shown short — it is a comparison key, not an id.
		expect(within(section).getByText("0123456789ab")).toBeInTheDocument();
		expect(
			within(section).getByRole("link", { name: "enc-1" }),
		).toHaveAttribute("href", "/vod/jobs/job-1");
	});

	/**
	 * An encoding id with no job row behind it must NOT become a dead link to
	 * `/vod/jobs/undefined` — it stays a copyable value.
	 */
	it("leaves an encoding id without a job unlinked", () => {
		renderLocalized(
			<RunDetail
				run={{
					...DETAIL,
					outcomes: [
						{ scenario: "orphan", verdict: "INVALID", encodingId: "enc-9" },
					],
				}}
			/>,
		);
		const section = screen.getByLabelText(en.verification.scenarios);
		expect(within(section).queryByRole("link", { name: "enc-9" })).toBeNull();
		expect(within(section).getByText("enc-9")).toBeInTheDocument();
	});

	it("renders the provider readback as encoding id → provider status", () => {
		renderLocalized(<RunDetail run={DETAIL} />);
		const section = screen.getByLabelText(en.verification.providerReadback);
		expect(within(section).getByText("enc-1")).toBeInTheDocument();
		expect(within(section).getByText("CANCELED")).toBeInTheDocument();
		expect(within(section).getByText("enc-2")).toBeInTheDocument();
		expect(within(section).getByText("FINISHED")).toBeInTheDocument();
	});

	it("renders the cleanup entries and the seal", () => {
		renderLocalized(<RunDetail run={DETAIL} />);
		const cleanup = screen.getByLabelText(en.verification.cleanup);
		expect(within(cleanup).getByText("h264-hls")).toBeInTheDocument();
		expect(
			within(cleanup).getByRole("link", { name: en.verification.viewJob }),
		).toHaveAttribute("href", "/vod/jobs/job-1");
		const seal = screen.getByLabelText(en.verification.seal);
		expect(
			within(seal).getByText(
				"verify-runs/2026-08-29T10-00-00-000-abcdef/report.json",
			),
		).toBeInTheDocument();
		expect(
			within(seal).getByText("hmac-sha256:0011223344"),
		).toBeInTheDocument();
		expect(within(seal).getByText("deadbeefcafe")).toBeInTheDocument();
		expect(within(seal).getByText("HMAC_SHA256")).toBeInTheDocument();
		expect(within(seal).getByText("release-2026-08")).toBeInTheDocument();
		expect(
			within(seal).getByText("2026-11-27T10:30:01.000Z"),
		).toBeInTheDocument();
	});

	it("says a run that abandoned nothing abandoned nothing, in both sections", () => {
		renderLocalized(
			<RunDetail run={{ ...DETAIL, cleanup: null, providerReadback: null }} />,
		);
		expect(
			screen.getByText(en.verification.noProviderReadback),
		).toBeInTheDocument();
		expect(screen.getByText(en.verification.noCleanup)).toBeInTheDocument();
	});

	/**
	 * The Live/MSL evidence card (audit 5c3d97ca BLOCKER-4, EV-02): one entry
	 * per output leg with the SAME completeness verdict the harness sealed on,
	 * and — for an incomplete leg — the elements it lacks, so a reader sees why
	 * a live PASS was refused instead of a bare INVALID.
	 */
	const legTuple = (progression: string) => ({
		version: LIVE_EVIDENCE_VERSION,
		scenario: "live-akamai-msl-storage",
		outputLeg: "hls@mirror-1",
		manifestKey: "hls",
		outputKey: "mirror-1",
		kind: "HLS" as const,
		role: "EDGE" as const,
		build: {
			commit: "abcdef0123456789",
			image: `worker@sha256:${"c".repeat(64)}`,
			planSha256: "a".repeat(64),
		},
		source: {
			location: "verify-in/bbb-short.mov",
			etag: "abc",
			size: 42,
			sha256: "b".repeat(64),
		},
		channel: {
			channelId: "chan-1",
			liveChannelRunId: "run-1",
			providerEncodingId: "enc-1",
			providerStreamIds: { video: "stream-1" },
			providerOutputIds: { "mirror-1": "output-1" },
			requiredProviderStreamKeys: ["video"],
			requiredProviderOutputKeys: ["mirror-1"],
		},
		output: { prefix: "verify/RUN1/live-akamai-msl-storage/" },
		topology: {
			expectedChildCount: 1,
			expectedChildIds: ["video_4500000.m3u8"],
		},
		children: [
			{
				id: "video_4500000.m3u8",
				requiresInit: false,
				listed: 5,
				media: [
					{ key: "seg-10.ts", bytes: 400_000, sha256: "s".repeat(64) },
					{ key: "seg-11.ts", bytes: 410_000, sha256: "t".repeat(64) },
				],
				missing: [],
			},
		],
		probes: [
			{
				at: "2026-08-30T10:00:00.000Z",
				children: [
					{
						id: "video_4500000.m3u8",
						mediaSequence: 10,
						served: ["seg-10.ts"],
					},
				],
			},
			{
				at: "2026-08-30T10:00:12.000Z",
				children: [
					{
						id: "video_4500000.m3u8",
						mediaSequence: progression.startsWith("video") ? 12 : 10,
						served: [
							progression.startsWith("video") ? "seg-12.ts" : "seg-10.ts",
						],
					},
				],
			},
		],
		progression: {
			observed: progression.startsWith("video"),
			detail: progression,
		},
		providerTerminal: {
			confirmed: true,
			encodingId: "enc-1",
			status: "STOPPED",
			observedAt: "2026-08-30T10:01:00.000Z",
			detail: "STOPPED, error null",
		},
		cleanup: {
			clean: true,
			queueDrained: true,
			processGone: true,
			storageRetained: true,
			tokenCleanup: {
				required: false,
				confirmed: true,
				detail: "not required",
			},
		},
		complete: progression.startsWith("video"),
		missing: progression.startsWith("video")
			? []
			: [`progression: ${progression}`],
	});

	it("renders one live-evidence card per output leg with its completeness, airing, probes, media and missing elements", () => {
		renderLocalized(
			<RunDetail
				run={{
					...DETAIL,
					liveEvidence: [
						{
							id: "e-1",
							scenario: "live-akamai-msl-storage",
							liveChannelRunId: "run-1",
							outputLeg: "hls@mirror-1",
							version: LIVE_EVIDENCE_VERSION,
							complete: true,
							missing: [],
							tuple: legTuple("video_4500000.m3u8: media sequence 10 → 12"),
							createdAt: "2026-08-30T10:01:00.000Z",
						},
						{
							id: "e-2",
							scenario: "live-akamai-msl-storage",
							liveChannelRunId: "run-1",
							outputLeg: "dash@mirror-1",
							version: LIVE_EVIDENCE_VERSION,
							complete: false,
							missing: ["progression: identical media served at both probes"],
							tuple: {
								...legTuple("identical media served at both probes"),
								outputLeg: "dash@mirror-1",
								kind: "DASH",
							},
							createdAt: "2026-08-30T10:01:00.000Z",
						},
					],
				}}
			/>,
		);
		const section = screen.getByLabelText(en.verification.liveEvidence);
		expect(within(section).getByText("hls@mirror-1")).toBeInTheDocument();
		expect(within(section).getByText("dash@mirror-1")).toBeInTheDocument();
		expect(
			within(section).getByText(en.verification.evidenceComplete),
		).toBeInTheDocument();
		expect(
			within(section).getByText(en.verification.evidenceIncomplete),
		).toBeInTheDocument();
		expect(within(section).getAllByText("run-1")).toHaveLength(2);
		// Media witnessed: 2 segments, 810,000 bytes — from the tuple, not a summary.
		expect(within(section).getAllByText("2 (810000 B)")).toHaveLength(2);
		expect(
			within(section).getByText("video_4500000.m3u8: media sequence 10 → 12"),
		).toBeInTheDocument();
		// The incomplete leg names the element it lacks.
		expect(
			within(section).getByText(
				"progression: identical media served at both probes",
			),
		).toBeInTheDocument();
	});

	it("says so when no live evidence was recorded, and has the heading in Japanese", () => {
		renderLocalized(<RunDetail run={{ ...DETAIL, liveEvidence: null }} />);
		expect(
			screen.getByText(en.verification.noLiveEvidence),
		).toBeInTheDocument();
		renderLocalized(<RunDetail run={DETAIL} />, "ja");
		expect(
			screen.getByLabelText(ja.verification.liveEvidence),
		).toBeInTheDocument();
		expect(
			screen.getByText(ja.verification.noLiveEvidence),
		).toBeInTheDocument();
	});

	it("shows an INCOMPLETE run's recorded reason", () => {
		renderLocalized(
			<RunDetail
				run={{ ...DETAIL, status: "INCOMPLETE", error: "preflight exploded" }}
			/>,
		);
		expect(screen.getByText("INCOMPLETE")).toBeInTheDocument();
		expect(screen.getByText("preflight exploded")).toBeInTheDocument();
	});

	/** The screen has to exist in Japanese, not merely typecheck. */
	it("renders its section headings from the ja catalogue", () => {
		renderLocalized(<RunDetail run={DETAIL} />, "ja");
		for (const heading of [
			ja.verification.fingerprint,
			ja.verification.source,
			ja.verification.scenarios,
			ja.verification.providerReadback,
			ja.verification.cleanup,
			ja.verification.seal,
		]) {
			expect(screen.getByLabelText(heading)).toBeInTheDocument();
		}
		// Enum values stay verbatim in both locales — the operator reads the
		// same word here, in a step log and in Bitmovin's own dashboard.
		expect(screen.getByText("SEALED")).toBeInTheDocument();
		expect(screen.getByText("PASS")).toBeInTheDocument();
	});
});
