import { INTERNAL_HEVC_V2_BCF_VERSION } from "@bitovp/core";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { messagesFor, translate } from "@/lib/i18n";
import { renderLocalized as render } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import {
	evaluatePlanDocument,
	evaluateWizardState,
	PlanPreview,
} from "./plan-preview";

const completeState: WizardState = {
	name: "h264-aac-fmp4-fixed-bitrate-hls-aws",
	accountId: "00000000-0000-4000-8000-00000000000a",
	cloudRegion: "AWS_AP_NORTHEAST_1",
	encoderVersion: "STABLE",
	inputFiles: [
		{
			key: "main",
			inputKey: "main",
			kind: "S3" as const,
			credentialId: "00000000-0000-4000-8000-000000000001",
			bucket: "sample-input-bucket",
			path: "sintel/Sintel.2010.1080p.mkv",
			name: "Test S3 Input",
		},
	],
	additionalOutputs: [],
	output: {
		credentialId: "00000000-0000-4000-8000-000000000002",
		kind: "S3",
		bucket: "sample-output-bucket",
		basePath: "output/h264-aac-fmp4-fixed-bitrate-hls-aws/",
		publicRead: true,
		name: "Test S3 Output",
	},
	videos: [
		{ height: 360, bitrate: 300_000 },
		{ height: 540, bitrate: 600_000 },
	],
	audios: [
		{ bitrate: 128_000, rate: 48_000 },
		{ bitrate: 64_000, rate: 44_100 },
	],
	audioGuard: false,
	manifests: { hls: true, dash: false },
	timing: "JUST_IN_TIME",
};

describe("evaluateWizardState (plan preview state)", () => {
	it.each([
		"ja",
		"en",
	] as const)("blocks shared clear OnDemand MP4 with separate-plan guidance in %s", (locale) => {
		const plan = buildPlan(completeState);
		const firstMuxing = plan.muxings[0];
		const output = plan.outputs[0];
		if (!firstMuxing || !output) throw Error("fixture");
		plan.muxings = plan.muxings.map((muxing) => ({
			key: muxing.key,
			kind: "MP4",
			streamKey: muxing.streamKey,
			filename: `${muxing.key}.mp4`,
			fragmentDuration: 2000,
			manifestType: "DASH_ON_DEMAND",
			destination: muxing.destination,
		}));
		plan.drm = [
			{
				key: "test-cenc",
				kind: "CENC",
				muxingKey: firstMuxing.key,
				credentialId: "00000000-0000-4000-8000-000000000003",
				kid: "0123456789abcdef0123456789abcdef",
				destination: { outputKey: output.key, path: "encrypted" },
			},
		];
		plan.manifests = [
			{
				key: "clear",
				kind: "DASH",
				name: "Clear OnDemand",
				manifestName: "clear.mpd",
				profile: "ON_DEMAND",
				destination: { outputKey: output.key, path: "" },
			},
		];
		const evaluation = evaluatePlanDocument(plan);
		if (!evaluation.ok) throw Error("parseable fixture");
		expect(evaluation.opCount).toBe(0);
		expect(evaluation.issues).toContainEqual(
			expect.objectContaining({
				code: "PLAN_DASH_ONDEMAND_CLEAR_DRM",
				level: "error",
			}),
		);
		render(<PlanPreview evaluation={evaluation} />, locale);
		expect(
			screen.getByText(
				locale === "ja"
					? /暗号化の有無でエンコード設定を分け/
					: /For clear OnDemand DASH/,
			),
		).toBeInTheDocument();
	});
	it("accepts imported GenericS3 with either provider and keeps its raw document", () => {
		const raw = buildPlan({
			...completeState,
			cloudRegion: "AUTO",
			inputFiles: completeState.inputFiles.map((f) => ({
				...f,
				kind: "GENERIC_S3",
			})),
			output: { ...completeState.output, kind: "GENERIC_S3" },
		});
		const before = JSON.stringify(raw);
		const ids = [
			...completeState.inputFiles.map((f) => f.credentialId),
			completeState.output.credentialId,
		];
		for (const provider of ["AKAMAI_OBJECT_STORAGE", "AWS_S3"] as const) {
			const evaluation = evaluatePlanDocument(raw, undefined, {
				credentialProviders: new Map(ids.map((id) => [id, provider])),
			});
			if (!evaluation.ok) throw Error("parseable fixture");
			expect(evaluation.issues.some((i) => i.level === "error")).toBe(false);
			expect(evaluation.ops.length > 0).toBe(true);
		}
		expect(JSON.stringify(raw)).toBe(before);
	});
	it("compiles AWS storage and region without deployment restrictions", () => {
		const evaluation = evaluateWizardState(completeState);
		if (!evaluation.ok) throw Error("parseable fixture");
		expect(evaluation.issues.some((i) => i.level === "error")).toBe(false);
		expect(evaluation.ops.length).toBeGreaterThan(0);
	});
	it.each([
		"ja",
		"en",
	] as const)("mixed-codec guidance does not recommend adding a mode to presets in %s", (locale) => {
		const evaluation = evaluateWizardState({
			...completeState,
			videos: [
				{ height: 360, bitrate: 300000 },
				{ codec: "H265", height: 540, bitrate: 600000 },
			],
		});
		if (!evaluation.ok) throw Error("parseable fixture");
		expect(evaluation.opCount).toBe(0);
		render(<PlanPreview evaluation={evaluation} />, locale);
		expect(
			screen.getByText(
				locale === "ja"
					? /プリセットなしの明示設定/
					: /explicit settings without presets/,
			),
		).toBeInTheDocument();
	});
	it.each([
		"ja",
		"en",
	] as const)("rejects imported preset/START conflicts with guidance in %s", (locale) => {
		const plan = buildPlan(completeState);
		const evaluation = evaluatePlanDocument({
			...plan,
			generation: { ...plan.generation, encodingMode: "THREE_PASS" },
		});
		if (!evaluation.ok) throw Error("parseable fixture");
		expect(evaluation.opCount).toBe(0);
		render(<PlanPreview evaluation={evaluation} />, locale);
		expect(
			screen.getByText(
				locale === "ja"
					? /画質プリセットを使う場合/
					: /When using a quality preset/,
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Copy preview/ }),
		).not.toBeInTheDocument();
	});
	it("omits a stale START mode when wizard codec presets own the mode", () => {
		const evaluation = evaluateWizardState({
			...completeState,
			startOptions: { encodingMode: "THREE_PASS" },
		});
		if (!evaluation.ok) throw Error("parseable fixture");
		expect(
			evaluation.issues.filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(evaluation.opCount).toBeGreaterThan(0);
		const start = evaluation.ops.find((op) => op.kind === "START_ENCODING");
		expect(start).toBeDefined();
		expect(start?.payload).not.toHaveProperty("encodingMode");
	});
	it("localizes the zod sentence when a translator is threaded (ledger #79c)", () => {
		// The FORM layer passes t; the builder maps zod's default too_small on
		// the empty name ("Too small: …>=1 characters") through zerr.zRequired.
		// Without the translator the same state keeps English — the standing
		// server-side policy, and the mutation "drop the translate param" turns
		// the first expectation into the second and goes RED.
		const broken = { ...completeState, name: "" };
		const ja = messagesFor("ja");
		const evalJa = evaluateWizardState(broken, (key, values) =>
			translate(ja, key, values),
		);
		if (evalJa.ok) {
			throw new Error("empty name must fail the schema");
		}
		expect(evalJa.zodMessage).toContain("必須です");
		const evalRaw = evaluateWizardState(broken);
		if (evalRaw.ok) {
			throw new Error("empty name must fail the schema");
		}
		expect(evalRaw.zodMessage).not.toContain("必須です");
	});

	it("reports incomplete for the empty default state", () => {
		const evaluation = evaluateWizardState(DEFAULT_WIZARD_STATE);
		expect(evaluation.ok).toBe(false);
	});

	it("compiles the fixture-equivalent state to 24 operations with no issues", () => {
		const evaluation = evaluateWizardState(completeState);
		if (!evaluation.ok) {
			throw new Error("expected a valid plan");
		}
		expect(evaluation.issues).toEqual([]);
		expect(evaluation.opCount).toBe(24);
	});

	it("blocks duplicate-identity renditions with a friendly message", () => {
		const evaluation = evaluateWizardState({
			...completeState,
			// Same height AND same bitrate — irreducibly duplicate identity.
			videos: [
				{ height: 1080, bitrate: 4_000_000 },
				{ height: 1080, bitrate: 4_000_000 },
			],
		});
		if (!evaluation.ok) {
			throw new Error("expected a parseable plan");
		}
		expect(evaluation.issues.some((i) => i.code === "PLAN_DUPLICATE_KEY")).toBe(
			true,
		);
		expect(evaluation.opCount).toBe(0);
		render(<PlanPreview evaluation={evaluation} />);
		expect(screen.getByText("blocked")).toBeInTheDocument();
		expect(
			screen.getAllByText(/same height AND bitrate/).length,
		).toBeGreaterThan(0);
		// A blocked plan must not offer an exportable Template YAML.
		expect(screen.getByTestId("plan-yaml").textContent).toContain(
			"fix the validation errors",
		);
		expect(
			screen.queryByRole("button", { name: "Copy preview" }),
		).not.toBeInTheDocument();
	});

	it("uniquifies same-height multi-bitrate ladders instead of blocking", () => {
		const evaluation = evaluateWizardState({
			...completeState,
			videos: [
				{ height: 1080, bitrate: 4_000_000 },
				{ height: 1080, bitrate: 8_000_000 },
			],
		});
		if (!evaluation.ok) {
			throw new Error("expected a valid plan");
		}
		expect(evaluation.issues).toEqual([]);
		expect(evaluation.opCount).toBeGreaterThan(0);
	});

	it("evaluates half-filled P2 sections without throwing (zod-safe partials)", () => {
		// Every freshly-added row starts with empty required fields — the
		// preview must degrade to a zodMessage, never crash the wizard.
		const evaluation = evaluateWizardState({
			...completeState,
			sources: {
				tracks: [
					{ key: "", inputFile: "", selectionMode: "AUTO", position: 0 },
				],
				fileStreams: [{ key: "vtt-1", inputFile: "" }],
				dolbyStreams: [
					{ kind: "ATMOS", key: "", inputFile: "", inputFormat: "DAMF" },
				],
				encodings: [{ key: "enc1", name: "" }],
				keyframes: [{ key: "", time: 0 }],
			},
			videos: [
				{
					height: 1080,
					bitrate: null,
					codec: "H265",
					h265: {
						dolbyVisionMetadata: {
							profile: "HEV1_08",
							metadataSource: "INPUT_STREAM",
						},
					},
					extras: {
						mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
						nexguard: { credentialId: "", watermarkType: "OTT", preset: "" },
						hlsMedia: { groupId: "", name: "", uri: "" },
					},
					muxing: { kind: "MP4" },
				},
			],
			subtitles: [{ source: "" }],
			drm: [{ kind: "CENC", muxingKey: "", credentialId: "", kid: "" }],
			manifests: {
				hls: true,
				dash: false,
				extra: [{ kind: "SMOOTH", key: "" }],
			},
			startOptions: {
				perTitle: { h265: { autoRepresentations: true } },
				aiSceneAnalysis: { filename: "", path: "" },
			},
		});
		expect(evaluation.ok).toBe(false);
		if (evaluation.ok) {
			throw new Error("expected a zod-incomplete evaluation");
		}
		expect(evaluation.zodMessage.length).toBeGreaterThan(0);
		render(<PlanPreview evaluation={evaluation} />);
		expect(screen.getByText("incomplete")).toBeInTheDocument();
	});
});

describe("PlanPreview", () => {
	it("defaults to the Encoding Template YAML view with op count", () => {
		render(<PlanPreview evaluation={evaluateWizardState(completeState)} />);
		expect(screen.getByText("24 operations")).toBeInTheDocument();
		const yaml = screen.getByTestId("plan-yaml").textContent ?? "";
		expect(yaml).toContain("metadata:");
		expect(yaml).toContain("name: h264-aac-fmp4-fixed-bitrate-hls-aws");
		expect(yaml).toContain("$/configurations/video/h264/v360");
		// Vault secrets stay placeholders.
		expect(yaml).toContain("{{INPUT_MAIN_ACCESS_KEY}}");
	});

	it("switches to the canonical Plan JSON tab", async () => {
		const { default: userEvent } = await import("@testing-library/user-event");
		const user = userEvent.setup();
		render(<PlanPreview evaluation={evaluateWizardState(completeState)} />);
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(screen.getByTestId("plan-json").textContent).toContain(
			'"name": "h264-aac-fmp4-fixed-bitrate-hls-aws"',
		);
	});

	it("renders the incomplete state without a document", () => {
		render(
			<PlanPreview evaluation={evaluateWizardState(DEFAULT_WIZARD_STATE)} />,
		);
		expect(screen.getByText("incomplete")).toBeInTheDocument();
	});
});

describe("the Operations tab — the rail shows WHAT will be sent, not how many", () => {
	it("says 'fix the validation errors' on a blocked plan — not an empty list", async () => {
		// ok-but-blocked (duplicate-identity renditions): ops = [], and the tab
		// must say WHY it is empty (review-170 S3; the badge path is pinned
		// elsewhere — this is the panel's own empty state).
		const evaluation = evaluateWizardState({
			...completeState,
			videos: [
				{ height: 1080, bitrate: 4_000_000 },
				{ height: 1080, bitrate: 4_000_000 },
			],
		});
		if (!evaluation.ok) {
			throw new Error("duplicate renditions still parse — they block later");
		}
		render(<PlanPreview evaluation={evaluation} />);
		await userEvent.click(screen.getByRole("button", { name: "Operations" }));
		expect(
			screen.getByText(/fix the validation errors above to compile/i),
		).toBeTruthy();
	});

	it("lists every compiled op in order, with step id and kind", async () => {
		// ux inventory #80-1: the rail computed the full op list and kept only
		// its LENGTH, while the live sibling rendered the list. The count badge
		// is a summary; this is the payload.
		const evaluation = evaluateWizardState(completeState);
		if (!evaluation.ok) {
			throw new Error("fixture state must evaluate");
		}
		render(<PlanPreview evaluation={evaluation} />);
		await userEvent.click(screen.getByRole("button", { name: "Operations" }));
		const panel = screen.getByTestId("plan-ops");
		const rows = panel.querySelectorAll("li");
		expect(rows.length).toBe(evaluation.opCount);
		// Order is the compiler's — row 1 carries op 1's step id and kind. The
		// guards are NON-vacuous by construction (review-170 S1/S2): the first
		// op is asserted to exist, so `toContain("")` can never self-vacuate,
		// and the near-meaningless `toContain("1")` is gone (the kill under the
		// reversal mutation always came from the step-id assertion).
		const first = evaluation.ops[0];
		if (!first) {
			throw new Error("fixture must compile at least one op");
		}
		expect(rows[0]?.textContent).toContain(first.step);
		expect(rows[0]?.textContent).toContain(first.kind);
	});

	it("opens an op's PAYLOAD from its kind — the list no longer stops at step+kind (#80 S4)", async () => {
		const evaluation = evaluateWizardState(completeState);
		if (!evaluation.ok) {
			throw new Error("fixture state must evaluate");
		}
		render(<PlanPreview evaluation={evaluation} />);
		await userEvent.click(screen.getByRole("button", { name: "Operations" }));
		const first = evaluation.ops[0];
		if (!first) {
			throw new Error("fixture must compile at least one op");
		}
		// A payload field VALUE that appears nowhere in the row summary — its
		// visibility can only come from the opened popover. The first op of the
		// wizard fixture is an input create carrying the bucket/host config; a
		// fixture whose first payload were empty would make this vacuous, so
		// assert it has at least one distinctive string value first.
		const distinctive = Object.values(first.payload).find(
			(v): v is string => typeof v === "string" && v.length > 3,
		);
		if (!distinctive) {
			throw new Error(
				"fixture's first op payload has no distinctive string — pick a later op",
			);
		}
		expect(screen.queryByText(new RegExp(distinctive))).toBeNull();
		// Kinds repeat across ops — the FIRST row's trigger is the first match.
		const [trigger] = screen.getAllByRole("button", { name: first.kind });
		if (!trigger) {
			throw new Error("no popover trigger rendered for the first op");
		}
		await userEvent.click(trigger);
		const panel = screen.getByRole("dialog", {
			name: `Step ${first.step} — operation payload`,
		});
		expect(panel.textContent).toContain(distinctive);
		expect(panel.textContent).toContain('"payload"');
	});
});

it("keeps internal HEVCv2 plans exportable as JSON without invoking public YAML generation", async () => {
	const evaluation = evaluateWizardState({
		...completeState,
		videos: [{ codec: "H265V2", height: 360, bitrate: 300_000 }],
		internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
	});
	if (!evaluation.ok) throw new Error("valid internal fixture");
	expect(evaluation.issues).toEqual([]);
	render(<PlanPreview evaluation={evaluation} />);
	expect(screen.getByTestId("plan-yaml")).toHaveTextContent(
		"Save this HEVCv2 plan as JSON",
	);
	await userEvent.click(screen.getByRole("button", { name: "Plan JSON" }));
	expect(screen.getByTestId("plan-json")).toHaveTextContent(
		INTERNAL_HEVC_V2_BCF_VERSION,
	);
});

describe("SPEKE plan preview", () => {
	it("shows vault-reference Plan JSON instead of throwing while exporting a template", () => {
		const evaluation = evaluateWizardState({
			...completeState,
			videos: [{ height: 360, bitrate: 300000 }],
			audios: [],
			manifests: {
				hls: true,
				dash: true,
				hlsOptions: { drmKind: "SPEKE" },
				dashOptions: { drmKind: "SPEKE" },
			},
			drm: [
				{
					kind: "SPEKE",
					muxingKey: "v360",
					credentialId: "23456789-0123-4567-89ab-0123456789ab",
					systemIds: ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"],
				},
			],
		});
		expect(evaluation.ok).toBe(true);
		render(<PlanPreview evaluation={evaluation} />);
		expect(screen.getByTestId("plan-json").textContent).toContain(
			'"kind": "SPEKE"',
		);
		expect(
			screen.getByRole("button", { name: "Template YAML" }),
		).toBeDisabled();
	});
});

describe("OnDemand MP4 DRM template availability", () => {
	function onDemandEvaluation() {
		const base = buildPlan(completeState);
		const muxings = base.muxings.map((m) => ({
			key: m.key,
			kind: "MP4",
			streamKey: m.streamKey,
			filename: `${m.key}.mp4`,
			fragmentDuration: 2000,
			manifestType: "DASH_ON_DEMAND",
			destination: m.destination,
		}));
		const evaluation = evaluatePlanDocument({
			...base,
			muxings,
			drm: muxings.map((m) => ({
				key: `${m.key}-cenc`,
				kind: "CENC",
				muxingKey: m.key,
				credentialId: "00000000-0000-4000-8000-000000000003",
				kid: "0123456789abcdef0123456789abcdef",
				encryptionMode: "CTR",
				ivSize: "IV_8_BYTES",
				destination: { ...m.destination, path: `cenc/${m.key}` },
			})),
			manifests: [
				{
					key: "ondemand",
					kind: "DASH",
					name: "OnDemand",
					manifestName: "stream.mpd",
					profile: "ON_DEMAND",
					drmKind: "CENC",
					destination: { outputKey: base.outputs[0]?.key, path: "" },
				},
			],
			generation: { timing: "POST_ENCODING" },
		});
		if (!evaluation.ok) throw new Error("valid OnDemand fixture");
		expect(evaluation.issues).toEqual([]);
		const reps = evaluation.ops.filter(
			(op) => op.kind === "CREATE_DASH_REPRESENTATION_MP4",
		);
		expect(reps).toHaveLength(muxings.length);
		expect(reps.every((op) => !!op.refs.drmId)).toBe(true);
		return evaluation;
	}
	it.each([
		"en",
		"ja",
	] as const)("keeps execution and JSON available with an honest export reason in %s", async (locale) => {
		const evaluation = onDemandEvaluation();
		const t = (key: Parameters<typeof translate>[1]) =>
			translate(messagesFor(locale), key);
		render(<PlanPreview evaluation={evaluation} />, locale);
		expect(
			screen.getByRole("button", { name: t("wizard.templateYaml") }),
		).toBeDisabled();
		expect(
			screen.getByText(
				locale === "ja"
					? /OnDemand MP4 DRMのYAML出力は利用できません/
					: /YAML export is unavailable for OnDemand MP4 DRM/,
			),
		).toBeVisible();
		expect(screen.getByTestId("plan-json").textContent).toContain(
			'"drmKind": "CENC"',
		);
		await userEvent.click(
			screen.getByRole("button", { name: t("ui.operations") }),
		);
		expect(screen.getByTestId("plan-ops").textContent).toContain(
			"CREATE_DASH_REPRESENTATION_MP4",
		);
	});
	it("does not leave a stale YAML export when switching between supported and unsupported plans", () => {
		const safe = evaluateWizardState(completeState);
		const view = render(<PlanPreview evaluation={safe} />);
		expect(screen.getByRole("button", { name: "Template YAML" })).toBeEnabled();
		expect(screen.getByTestId("plan-yaml")).toHaveTextContent("metadata:");
		view.rerender(<PlanPreview evaluation={onDemandEvaluation()} />);
		expect(
			screen.getByRole("button", { name: "Template YAML" }),
		).toBeDisabled();
		expect(screen.getByTestId("plan-json")).toHaveTextContent(
			'"drmKind": "CENC"',
		);
		view.rerender(<PlanPreview evaluation={safe} />);
		expect(screen.getByRole("button", { name: "Template YAML" })).toBeEnabled();
		expect(screen.getByTestId("plan-yaml")).toHaveTextContent("metadata:");
		expect(
			screen.queryByText(/YAML export is unavailable for OnDemand MP4 DRM/),
		).not.toBeInTheDocument();
	});
});
