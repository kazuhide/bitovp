import { describe, expect, it } from "vitest";
import {
	AKAMAI_MSL_VERSION_BEHAVIOR,
	checkAkamaiMslConstraints,
} from "./akamai-msl-constraint";

/** Verify format and encoding-kind checks use the shared version rules. */

type Output = {
	key: string;
	kind: string;
	streamFormat?: string;
	mslVersion?: string;
	credentialId?: string;
};

function issuesFor(opts: {
	encodingKind: "LIVE" | "VOD";
	output: Output;
	/** Rail 3b: `undefined` is the CLIENT context and must stay silent. */
	credentialHasPublishingAuth?: ReadonlySet<string>;
}): string[] {
	return checkAkamaiMslConstraints({
		encodingKind: opts.encodingKind,
		credentialHasPublishingAuth: opts.credentialHasPublishingAuth,
		outputs: [opts.output],
		// Empty topology: the C31 muxing/manifest arms fire too, and these arms
		// filter by CODE rather than asserting the issue list is empty — a
		// bare `toHaveLength` here would be asserting something else.
		muxings: [],
		manifests: [],
	}).map((i) => i.code);
}

const MSL5_CMAF: Output = {
	key: "msl",
	kind: "AKAMAI_MSL",
	streamFormat: "CMAF",
	mslVersion: "MSL5",
};

describe("rail 6 — MSL5 is a LIVE output", () => {
	it("refuses an MSL5 output on a VOD plan", () => {
		const codes = issuesFor({ encodingKind: "VOD", output: MSL5_CMAF });
		expect(codes).toContain("MSL_VERSION_ENCODING_KIND");
	});

	it("allows the same output on a LIVE plan", () => {
		const codes = issuesFor({ encodingKind: "LIVE", output: MSL5_CMAF });
		expect(codes).not.toContain("MSL_VERSION_ENCODING_KIND");
	});

	it("leaves MSL4 alone on VOD — the union carries it for a reason", () => {
		// `AKAMAI_MSL` is a member of the VOD output union and the VOD compiler
		// emits its op, because MSL4 legitimately appears there. A rail that
		// refused every MSL output on VOD would break that.
		const codes = issuesFor({
			encodingKind: "VOD",
			output: { ...MSL5_CMAF, mslVersion: "MSL4", streamFormat: "HLS" },
		});
		expect(codes).not.toContain("MSL_VERSION_ENCODING_KIND");
	});
});

/**
 * RAIL 1 LIVED HERE AND IS GONE — refuted by the vendor's own E2E suite
 * (2026-08-27). It asserted `MSL5 ⇒ streamFormat ∈ {HLS, CMAF}` at ERROR level,
 * from an upstream ticket citation this repo could not open.
 *
 * `bitmovin-java-internal` PR #4768 (EN-15384) provisions THREE MSL5 streams —
 * DASH 20001603, HLS 20001602, CMAF 20001601 — and exercises the DASH one at
 * seven test sites, including `startAndIngestWithDashAndAkamaiMSL5_shouldSucceed`,
 * which starts a live encoding with a DASH manifest and fetches `index.mpd`
 * back off the MSL5 origin. MSL5 supports DASH.
 *
 * So the rail would have refused, at submit and at error level, a configuration
 * the vendor verifies end to end. That is the failure mode rail 4's own
 * justification names — "an allowlist is a bug with a date" — committed on
 * rail 1 because I treated a ticket citation as measured.
 *
 * `streamFormats` went with it rather than being corrected to all three: both
 * versions would then carry the same value, which is the inert-property problem
 * `publishingAuth` was fixed for one commit earlier.
 */

const MSL5_LIVE = { encodingKind: "LIVE" } as const;
const CRED = "cred-1";
const MSL5_WITH_CRED: Output = { ...MSL5_CMAF, credentialId: CRED };

describe("rail 3b — an MSL5 output whose credential has no Digest pair", () => {
	/**
	 * F3's own hole, reopened one trigger over by F3's own fix. Deriving
	 * `enabled` from credential presence closes "the operator left the checkbox
	 * off"; it does not close "the vault half is empty" — and that state is
	 * harder to notice, because removing the checkbox removed the affordance
	 * that would have shown it.
	 */
	it("warns when the credential is not in the resolved set", () => {
		const codes = issuesFor({
			...MSL5_LIVE,
			output: MSL5_WITH_CRED,
			credentialHasPublishingAuth: new Set<string>(),
		});
		expect(codes).toContain("MSL_PUBLISHING_AUTH_ABSENT");
	});

	it("is quiet when the credential DOES carry a pair", () => {
		const codes = issuesFor({
			...MSL5_LIVE,
			output: MSL5_WITH_CRED,
			credentialHasPublishingAuth: new Set([CRED]),
		});
		expect(codes).not.toContain("MSL_PUBLISHING_AUTH_ABSENT");
	});

	/**
	 * The CLIENT context. `undefined` is not "no credentials have pairs" — it
	 * is "I cannot read the vault", and a browser warning about vault material
	 * it cannot see is the inverted-divergence failure this repo already paid
	 * for once with the MSL5 gate's client seam.
	 */
	it("says NOTHING when the set is undefined — a client preview cannot know", () => {
		const codes = issuesFor({ ...MSL5_LIVE, output: MSL5_WITH_CRED });
		expect(codes).not.toContain("MSL_PUBLISHING_AUTH_ABSENT");
	});

	/**
	 * DERIVED from the anchor, not from `mslVersion === "MSL5"`. MSL4 FORBIDS
	 * the field — the vendor throws "The MSL5-only field
	 * publishingAuthentication cannot be set on MSL4 outputs" — so warning that
	 * an MSL4 credential lacks one would tell an operator to add something the
	 * API rejects.
	 */
	it("never warns about MSL4, which FORBIDS the field", () => {
		const codes = issuesFor({
			...MSL5_LIVE,
			output: { ...MSL5_WITH_CRED, mslVersion: "MSL4" },
			credentialHasPublishingAuth: new Set<string>(),
		});
		expect(codes).not.toContain("MSL_PUBLISHING_AUTH_ABSENT");
	});

	it("is a WARNING — an unauthenticated publish is legal, just rarely intended", () => {
		const issue = checkAkamaiMslConstraints({
			encodingKind: "LIVE",
			credentialHasPublishingAuth: new Set<string>(),
			outputs: [MSL5_WITH_CRED],
			muxings: [],
			manifests: [],
		}).find((i) => i.code === "MSL_PUBLISHING_AUTH_ABSENT");
		expect(issue?.level).toBe("warning");
		expect(issue?.message).toContain("UNAUTHENTICATED");
		// Points at the credential, because that is where the fix is.
		expect(issue?.path).toContain("credentialId");
	});
});

describe("segment naming is version-scoped — MSL4 and MSL5 are different languages", () => {
	/**
	 * From the vendor's merged E2E suite, not from a document: PR #4768's MSL4
	 * and MSL5 live tests differ on exactly this line.
	 *
	 *   MSL4:  segment-{rand_chars:10}-%number%.m4s
	 *   MSL5:  $RepresentationID$_$Number$.m4s
	 *
	 * Before this, one pattern was applied to every MSL output, so an MSL5 plan
	 * using the vendor's own naming COULD NOT BE AUTHORED. These arms are the
	 * cross pair — each version's naming against the other version's rail —
	 * because a single-version test passes with the scoping removed.
	 */
	const withNaming = (mslVersion: string, naming: string) =>
		checkAkamaiMslConstraints({
			encodingKind: "LIVE",
			credentialHasPublishingAuth: undefined,
			outputs: [
				{
					key: "origin",
					kind: "AKAMAI_MSL",
					streamFormat: "CMAF",
					mslVersion,
				},
			],
			muxings: [
				{
					key: "v1080",
					kind: "FMP4",
					destination: { outputKey: "origin" },
					segmentNaming: naming,
					// Conforming for both versions unless an arm overrides it, so
					// the media arms below are not reading the init arm's issue.
					initSegmentName: "$RepresentationID$_init.mp4",
				},
			],
			// CMAF wants both; supplying them keeps this focused on naming.
			manifests: [
				{ kind: "HLS", destination: { outputKey: "origin" } },
				{ kind: "DASH", destination: { outputKey: "origin" } },
			],
		}).filter((i) => /segmentNaming/.test(i.path ?? ""));

	const MSL4_NAMING = "seg-{rand_chars:8}-%number%.m4s";
	const MSL5_NAMING = "$RepresentationID$_$Number$.m4s";

	it("accepts each version's OWN naming", () => {
		expect(withNaming("MSL4", MSL4_NAMING)).toEqual([]);
		expect(withNaming("MSL5", MSL5_NAMING)).toEqual([]);
	});

	it("objects to each version's naming under the OTHER version", () => {
		// The cross pair. Remove the scoping and one of these two goes green
		// while the other stays red, whichever way the single pattern falls.
		expect(withNaming("MSL4", MSL5_NAMING)).not.toEqual([]);
		expect(withNaming("MSL5", MSL4_NAMING)).not.toEqual([]);
	});

	/**
	 * Severity tracks the STRENGTH OF EVIDENCE, not the tidiness of the rule.
	 * MSL4's pattern comes from four arms run against the live API where the
	 * refusal was WATCHED (`live/start` 400 code 2025). For MSL5 we have one
	 * shape observed ACCEPTED and no refusal observed — which does not license
	 * refusing everything else.
	 */
	/**
	 * ERROR ON BOTH — and this arm asserted `warning` for MSL5 for one commit,
	 * pinning a rationale that the cited commit's own body refutes (review of
	 * PR #319). Its body:
	 *
	 *   "the MSL4-style {rand_chars} naming was rejected with error 2025 on
	 *    live start"
	 *
	 * Same code, same endpoint as MSL4's four-arm measurement. The cost was
	 * concrete: an MSL5 plan carrying MSL4's grammar passed the submit gate,
	 * because `planHasErrors` blocks on `error` only, and would have died
	 * thirty ops later at `live/start`.
	 */
	it("is an ERROR on BOTH versions — both refusals were watched at code 2025", () => {
		expect(withNaming("MSL4", MSL5_NAMING)[0]?.level).toBe("error");
		expect(withNaming("MSL5", MSL4_NAMING)[0]?.level).toBe("error");
	});

	/**
	 * CONTAINMENT, not equality — the second half of the same review finding.
	 * The vendor's sentence is "media segment names CONTAINING
	 * $RepresentationID$ and $Number$"; I encoded equality against one literal,
	 * so a conforming name with a prefix or a directory was warned about.
	 *
	 * These are the two shapes review measured being wrongly refused. They are
	 * the arm that stops the rule being re-narrowed to a literal.
	 */
	it.each([
		"video_$RepresentationID$_$Number$.m4s",
		"$RepresentationID$/$Number$.m4s",
	])("accepts %s — the rule is CONTAINMENT of both tokens", (naming) => {
		expect(withNaming("MSL5", naming)).toEqual([]);
	});

	it("still refuses an MSL5 name missing EITHER token", () => {
		// One token each, so neither passes by the other's presence.
		expect(withNaming("MSL5", "$RepresentationID$_init.m4s")).not.toEqual([]);
		expect(withNaming("MSL5", "seg_$Number$.m4s")).not.toEqual([]);
	});

	it("suggests the right shape for the version it is talking about", () => {
		expect(withNaming("MSL5", MSL4_NAMING)[0]?.message).toContain(
			"$RepresentationID$_$Number$.m4s",
		);
		expect(withNaming("MSL4", MSL5_NAMING)[0]?.message).toContain("rand_chars");
	});

	it("still objects to the SCHEMA DEFAULT under both versions", () => {
		// `seg_%number%.ts` is what the schema fills in, and it is the arm that
		// returned 400 code 2025 on MSL4. Nothing observed says MSL5 accepts it
		// either, so neither version stays quiet about it.
		expect(withNaming("MSL4", "seg_%number%.m4s")).not.toEqual([]);
		expect(withNaming("MSL5", "seg_%number%.m4s")).not.toEqual([]);
	});
});

describe("mixed-version MSL fan-out — the RELATION, not the presence", () => {
	/**
	 * Review F8, and it is the class this file keeps relearning. The first cut
	 * asked "do two MSL outputs with different versions EXIST on this plan" and
	 * said "They share the same muxings" — false for the one dual-version
	 * topology that works.
	 *
	 * 「presence is not association」. The old test could not see the
	 * difference: its fixture passed `muxings: []`, so the field whose SHARING
	 * the rail claims to be about was empty in every arm, and the satisfiable
	 * and unsatisfiable configs were identical inputs.
	 *
	 * So both arms below carry real muxings, and the SECOND one is the arm that
	 * would have caught the defect.
	 */
	const mslOut = (key: string, mslVersion: string) => ({
		key,
		kind: "AKAMAI_MSL",
		streamFormat: "CMAF",
		mslVersion,
	});
	const bothManifests = (outputKey: string) => [
		{ kind: "HLS", destination: { outputKey } },
		{ kind: "DASH", destination: { outputKey } },
	];
	const mixedIssues = (i: Parameters<typeof checkAkamaiMslConstraints>[0]) =>
		checkAkamaiMslConstraints(i).filter((x) =>
			/writes to Akamai MSL outputs of different versions/.test(x.message),
		);

	it("BLOCKS a MIRROR, where one muxing genuinely reaches both", () => {
		// A deliveryMirror means EVERY muxing writes to the mirrored output, so
		// this single muxing carries one naming to two grammars.
		// `as const` so the tuple destructure is `string`, not `string | undefined`
		// — the both-orders loop is the assertion, so it stays a loop.
		for (const [a, b] of [
			["MSL4", "MSL5"],
			["MSL5", "MSL4"],
		] as const) {
			const issues = mixedIssues({
				encodingKind: "LIVE",
				credentialHasPublishingAuth: undefined,
				outputs: [mslOut("origin", a), mslOut("mirror-1", b)],
				muxings: [
					{
						key: "v1080",
						kind: "FMP4",
						destination: { outputKey: "origin" },
						segmentNaming: "$RepresentationID$_$Number$.m4s",
						initSegmentName: "$RepresentationID$_init.mp4",
					},
				],
				deliveryMirrors: [{ outputKey: "mirror-1" }],
				manifests: bothManifests("origin"),
			});
			// Once, not per muxing — the fix is topological.
			expect(issues.length, `${a} + ${b}`).toBe(1);
			expect(issues[0]?.level).toBe("error");
		}
	});

	/**
	 * THE ARM THAT WOULD HAVE CAUGHT IT. Two INDEPENDENT ladders to two Akamai
	 * streams, each muxing carrying its own version's grammar, nothing shared.
	 * That is how you validate MSL5 beside MSL4 before cutting over — the
	 * migration state rail 3's own reasoning is built around — and the first cut
	 * refused it at error level with a message that was false for it.
	 */
	it("PERMITS two INDEPENDENT MSL outputs of different versions", () => {
		const issues = checkAkamaiMslConstraints({
			encodingKind: "LIVE",
			credentialHasPublishingAuth: undefined,
			outputs: [mslOut("msl4", "MSL4"), mslOut("msl5", "MSL5")],
			muxings: [
				{
					key: "v4",
					kind: "FMP4",
					destination: { outputKey: "msl4" },
					segmentNaming: "seg-{rand_chars:8}-%number%.m4s",
					initSegmentName: "init.mp4",
				},
				{
					key: "v5",
					kind: "FMP4",
					destination: { outputKey: "msl5" },
					segmentNaming: "$RepresentationID$_$Number$.m4s",
					initSegmentName: "$RepresentationID$_init.mp4",
				},
			],
			manifests: [...bothManifests("msl4"), ...bothManifests("msl5")],
		});
		// No mixed-version issue AND no naming issue: the checker is otherwise
		// entirely happy with this plan, which is what made the false error so
		// misleading.
		expect(issues.filter((x) => x.level === "error")).toEqual([]);
	});

	it("says nothing when both MSL outputs are the SAME version", () => {
		// The storage-primary + MSL-mirror case this repo already ships.
		expect(
			mixedIssues({
				encodingKind: "LIVE",
				credentialHasPublishingAuth: undefined,
				outputs: [mslOut("origin", "MSL4"), mslOut("mirror-1", "MSL4")],
				muxings: [
					{
						key: "v1080",
						kind: "FMP4",
						destination: { outputKey: "origin" },
						segmentNaming: "seg-{rand_chars:8}-%number%.m4s",
						initSegmentName: "init.mp4",
					},
				],
				deliveryMirrors: [{ outputKey: "mirror-1" }],
				manifests: bothManifests("origin"),
			}),
		).toEqual([]);
	});
});

describe("the INIT segment name is the second axis that commit moved", () => {
	/**
	 * Review of PR #319 found this unregistered: `adab58537b` changed BOTH
	 * names on every fMP4 site, and the helper swap in that diff proves they
	 * are different SDK fields.
	 *
	 *   MSL4:  init_{rand_chars:10}.mp4      MSL5:  $RepresentationID$_init.mp4
	 *
	 * `$Number$` is absent from the init form by design — an init segment has
	 * no number — so this is a DIFFERENT rule, not the media rule reapplied.
	 * I carried one axis and left the other unmentioned in the code, the design
	 * and the ledger row.
	 */
	const withInit = (mslVersion: string, initSegmentName: string) =>
		checkAkamaiMslConstraints({
			encodingKind: "LIVE",
			credentialHasPublishingAuth: undefined,
			outputs: [
				{
					key: "origin",
					kind: "AKAMAI_MSL",
					streamFormat: "CMAF",
					mslVersion,
				},
			],
			muxings: [
				{
					key: "v1080",
					kind: "FMP4",
					destination: { outputKey: "origin" },
					// Conforming for each version, so this reads the init arm only.
					segmentNaming:
						mslVersion === "MSL5"
							? "$RepresentationID$_$Number$.m4s"
							: "seg-{rand_chars:8}-%number%.m4s",
					initSegmentName,
				},
			],
			manifests: [
				{ kind: "HLS", destination: { outputKey: "origin" } },
				{ kind: "DASH", destination: { outputKey: "origin" } },
			],
		}).filter((i) => /initSegmentName/.test(i.path ?? ""));

	it("accepts the vendor's MSL5 init name", () => {
		expect(withInit("MSL5", "$RepresentationID$_init.mp4")).toEqual([]);
	});

	it("objects to the schema default on MSL5 — which the golden itself carries", () => {
		const issues = withInit("MSL5", "init.mp4");
		expect(issues).not.toEqual([]);
		/*
		 * A WARNING, and that is the whole point of separating the axes. There
		 * is no watched refusal for the INIT name on either version — the
		 * vendor changed it in the same commit without recording a 400 — so
		 * "the shape the vendor uses" is the honest strength, not "the shape
		 * the API demands". Making it an error would block the `live-akamai-msl5`
		 * golden, which carries `init.mp4`, on evidence nobody has.
		 */
		expect(issues[0]?.level).toBe("warning");
		expect(issues[0]?.message).toContain("$RepresentationID$_init.mp4");
	});

	it("says NOTHING about MSL4's init name, whatever it is", () => {
		// `init.mp4` is what every landed MSL4 golden carries and those channels
		// have started for real, so an arm firing here would contradict measured
		// production behaviour.
		expect(withInit("MSL4", "init.mp4")).toEqual([]);
		expect(withInit("MSL4", "init_{rand_chars:8}.mp4")).toEqual([]);
	});
});

describe("the rails DERIVE from the anchor — the wiring, not the rule", () => {
	/**
	 * The arm the review asked for by name. It does not assert what the rail
	 * says; it asserts that changing the RECORD changes what the rail says.
	 *
	 * Mutating a frozen-by-`as const` object needs a cast, and that is the
	 * point — production code has no reason to write here, so a test is the
	 * only thing that can prove the read is live. Restored in a `finally`, and
	 * the arm below re-asserts the original value so a failed restore fails
	 * loudly rather than leaking into the next test.
	 */

	it("a wrong publishingAuth in the Record changes rail 3b's behaviour", () => {
		const entry = AKAMAI_MSL_VERSION_BEHAVIOR.MSL4 as unknown as {
			publishingAuth: string;
		};
		const original = entry.publishingAuth;
		expect(original).toBe("FORBIDDEN");
		const msl4 = {
			...MSL5_LIVE,
			output: { ...MSL5_WITH_CRED, mslVersion: "MSL4" },
			credentialHasPublishingAuth: new Set<string>(),
		};
		try {
			// MSL4 stops forbidding it, so the pair-absent warning starts
			// applying to MSL4 too — the rail read the Record, not the version.
			entry.publishingAuth = "OPTIONAL";
			expect(issuesFor(msl4)).toContain("MSL_PUBLISHING_AUTH_ABSENT");
		} finally {
			entry.publishingAuth = original;
		}
		expect(issuesFor(msl4)).not.toContain("MSL_PUBLISHING_AUTH_ABSENT");
	});

	it("a wrong encodingKinds in the Record changes rail 6's behaviour", () => {
		const entry = AKAMAI_MSL_VERSION_BEHAVIOR.MSL5 as unknown as {
			encodingKinds: readonly string[];
		};
		const original = entry.encodingKinds;
		expect(original).toEqual(["LIVE"]);
		try {
			entry.encodingKinds = ["VOD"];
			expect(
				issuesFor({ encodingKind: "VOD", output: MSL5_CMAF }),
			).not.toContain("MSL_VERSION_ENCODING_KIND");
			expect(issuesFor({ encodingKind: "LIVE", output: MSL5_CMAF })).toContain(
				"MSL_VERSION_ENCODING_KIND",
			);
		} finally {
			entry.encodingKinds = original;
		}
		expect(AKAMAI_MSL_VERSION_BEHAVIOR.MSL5.encodingKinds).toEqual(["LIVE"]);
	});
});
