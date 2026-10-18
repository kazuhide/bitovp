import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { renderWithQuery } from "@/test/render";
import { MuxingsSection } from "./muxings-section";

/**
 * : the wizard's QC section is flag-gated and the provider's own
 * default is OFF (a fresh deployment). These cases were written for the QC
 * surface, so they render with it ON; qc-section.test carries the two-state
 * pin for OFF.
 */
function render(
	node: React.ReactElement,
	locale: "en" | "ja" = "en",
	qcVmaf = true,
) {
	return renderWithQuery(
		<FeatureFlagsProvider flags={{ qcVmaf }}>{node}</FeatureFlagsProvider>,
		locale,
	);
}

import type { WizardState } from "./build-plan";
import {
	csvToPoolIds,
	EncodingOptionsSection,
	ManifestSection,
} from "./wizard-sections";

/**
 * P5 PR-2 wizard controls:
 *  - Encoding-options step: "Labels & infrastructure" (Encoding.labels tags +
 *    Cloud Connect pinning) and "Start options (advanced)" (tweaks
 *    audioVideoSyncMode + handleVariableInputFps).
 *  - Manifests step: per-HLS/DASH-manifest "Start placement" select (preview
 *    manifests), JIT-only and never for SMOOTH.
 * These guard the state patches (the buildPlan emission is pinned by
 * build-plan.test.ts) and the visibility rules.
 */

const baseState: WizardState = {
	name: "infra-ops-ui",
	accountId: "00000000-0000-4000-8000-00000000000a",
	cloudRegion: "AWS_AP_NORTHEAST_1",
	encoderVersion: "STABLE",
	inputFiles: [
		{
			key: "main",
			inputKey: "main",
			kind: "S3" as const,
			credentialId: "00000000-0000-4000-8000-000000000001",
			bucket: "in",
			path: "src.mkv",
			name: "S3 Input",
		},
	],
	additionalOutputs: [],
	output: {
		credentialId: "00000000-0000-4000-8000-000000000002",
		kind: "S3",
		bucket: "out",
		basePath: "output/infra-ops-ui/",
		publicRead: true,
		name: "S3 Output",
	},
	videos: [{ height: 360, bitrate: 300_000 }],
	audios: [{ bitrate: 64_000, rate: 44_100 }],
	audioGuard: false,
	manifests: { hls: true, dash: true },
	timing: "JUST_IN_TIME",
};

describe("EncodingOptionsSection — Labels & infrastructure", () => {
	it("typing labels patches a trimmed, empty-dropped string[]", () => {
		const onPatch = vi.fn();
		render(<EncodingOptionsSection state={baseState} onPatch={onPatch} />);
		fireEvent.change(screen.getByLabelText("Labels"), {
			target: { value: " campaign-a ,, uhd , " },
		});
		expect(onPatch).toHaveBeenCalledWith({ labels: ["campaign-a", "uhd"] });
	});

	it("clearing the labels input patches labels: undefined (no plan key)", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{ ...baseState, labels: ["campaign-a"] }}
				onPatch={onPatch}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Labels"), {
			target: { value: "" },
		});
		expect(onPatch).toHaveBeenCalledWith({ labels: undefined });
	});

	it("typing an infrastructure id patches the pair AND auto-switches the region to EXTERNAL (C18)", () => {
		const onPatch = vi.fn();
		render(<EncodingOptionsSection state={baseState} onPatch={onPatch} />);
		fireEvent.change(screen.getByLabelText("Infrastructure id"), {
			target: { value: "00000000-0000-4000-8000-0000000000aa" },
		});
		// Half-filled stays in state (the preview rails it loudly) — never a
		// silent drop of what the user typed. The top-level region flips to
		// EXTERNAL in the same patch (Cloud Connect contract, C18).
		expect(onPatch).toHaveBeenCalledWith({
			infrastructure: {
				infrastructureId: "00000000-0000-4000-8000-0000000000aa",
				cloudRegion: "",
			},
			cloudRegion: "EXTERNAL",
		});
	});

	it("does not re-patch the region when it is already EXTERNAL", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{ ...baseState, cloudRegion: "EXTERNAL" }}
				onPatch={onPatch}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Infrastructure id"), {
			target: { value: "abc" },
		});
		expect(onPatch).toHaveBeenCalledWith({
			infrastructure: { infrastructureId: "abc", cloudRegion: "" },
		});
	});

	it("clearing BOTH infrastructure fields collapses to undefined", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{
					...baseState,
					infrastructure: { infrastructureId: "abc", cloudRegion: "" },
				}}
				onPatch={onPatch}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Infrastructure id"), {
			target: { value: "" },
		});
		expect(onPatch).toHaveBeenCalledWith({ infrastructure: undefined });
	});
});

describe("EncodingOptionsSection — Start options (advanced)", () => {
	it("offers the three tweak modes plus (default) and patches startOptions", () => {
		const onPatch = vi.fn();
		render(<EncodingOptionsSection state={baseState} onPatch={onPatch} />);
		const select = screen.getByLabelText(
			"Audio/video sync mode",
		) as HTMLSelectElement;
		expect([...select.options].map((o) => o.value)).toEqual([
			"",
			"STANDARD",
			"RESYNC_AT_START",
			"RESYNC_AT_START_AND_END",
		]);
		fireEvent.change(select, { target: { value: "RESYNC_AT_START" } });
		expect(onPatch).toHaveBeenCalledWith({
			startOptions: { audioVideoSyncMode: "RESYNC_AT_START" },
		});
	});

	it("selecting (default) clears audioVideoSyncMode back to undefined", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{
					...baseState,
					startOptions: { audioVideoSyncMode: "STANDARD" },
				}}
				onPatch={onPatch}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Audio/video sync mode"), {
			target: { value: "" },
		});
		expect(onPatch).toHaveBeenCalledWith({
			startOptions: { audioVideoSyncMode: undefined },
		});
	});

	it("checking Handle variable input FPS patches true; unchecking unsets", () => {
		const onPatch = vi.fn();
		const { rerender } = render(
			<EncodingOptionsSection state={baseState} onPatch={onPatch} />,
		);
		fireEvent.click(screen.getByLabelText("Handle variable input FPS"));
		expect(onPatch).toHaveBeenCalledWith({
			startOptions: { handleVariableInputFps: true },
		});
		rerender(
			<EncodingOptionsSection
				state={{ ...baseState, startOptions: { handleVariableInputFps: true } }}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByLabelText("Handle variable input FPS"));
		// Unchecked = unset (no plan key), not an explicit false.
		expect(onPatch).toHaveBeenLastCalledWith({
			startOptions: { handleVariableInputFps: undefined },
		});
	});
});

describe("ManifestSection — Start placement (JIT preview manifests)", () => {
	it("shows one placement select per primary HLS/DASH manifest under JIT", async () => {
		render(<ManifestSection state={baseState} onPatch={vi.fn()} />);
		const selects = screen.getAllByLabelText(
			"Start placement",
		) as HTMLSelectElement[];
		expect(selects).toHaveLength(2);
		// (c): the explicit-VOD twin was compiler-identical to the
		// default and is gone — three options now.
		expect([...(selects[0]?.options ?? [])].map((o) => o.value)).toEqual([
			"",
			"PREVIEW",
			"VOD_AND_PREVIEW",
		]);
		// #129: the Preview explainer lives behind the click-to-open help now
		// — absent until the trigger is clicked, present after. Pins the
		// overlay, not just the copy's existence.
		expect(
			screen.queryByText(
				"Preview = watch-while-encoding manifest lists on the start request",
			),
		).not.toBeInTheDocument();
		const helpButtons = screen.getAllByRole("button", {
			name: /more information/i,
		});
		expect(helpButtons.length).toBeGreaterThan(0);
		await userEvent.click(helpButtons[0] as HTMLElement);
		expect(
			screen.getAllByText(
				"Preview = watch-while-encoding manifest lists on the start request",
			).length,
		).toBeGreaterThan(0);
	});

	it("hides the placement selects for POST_ENCODING timing", () => {
		render(
			<ManifestSection
				state={{ ...baseState, timing: "POST_ENCODING" }}
				onPatch={vi.fn()}
			/>,
		);
		expect(screen.queryAllByLabelText("Start placement")).toHaveLength(0);
	});

	it("renders a placement select for extra HLS/DASH rows but never SMOOTH", () => {
		render(
			<ManifestSection
				state={{
					...baseState,
					manifests: {
						hls: false,
						dash: false,
						extra: [
							{ kind: "HLS", key: "hls1" },
							{ kind: "SMOOTH", key: "smooth1" },
						],
					},
				}}
				onPatch={vi.fn()}
			/>,
		);
		// One select for the extra HLS row; none for SMOOTH (no preview list
		// in the API) and no primaries are on.
		expect(screen.getAllByLabelText("Start placement")).toHaveLength(1);
	});

	it("selecting Preview patches the primary HLS option bag", () => {
		const onPatch = vi.fn();
		render(<ManifestSection state={baseState} onPatch={onPatch} />);
		const [hlsSelect] = screen.getAllByLabelText("Start placement");
		if (!hlsSelect) {
			throw new Error("expected the HLS placement select");
		}
		fireEvent.change(hlsSelect, { target: { value: "PREVIEW" } });
		expect(onPatch).toHaveBeenCalledWith({
			manifests: {
				...baseState.manifests,
				hlsOptions: { jitPlacement: "PREVIEW" },
			},
		});
	});

	it("selecting a placement on an extra DASH row patches that row's bag", () => {
		const onPatch = vi.fn();
		const manifests: WizardState["manifests"] = {
			hls: false,
			dash: false,
			extra: [{ kind: "DASH", key: "dash1" }],
		};
		render(
			<ManifestSection state={{ ...baseState, manifests }} onPatch={onPatch} />,
		);
		fireEvent.change(screen.getByLabelText("Start placement"), {
			target: { value: "VOD_AND_PREVIEW" },
		});
		expect(onPatch).toHaveBeenCalledWith({
			manifests: {
				...manifests,
				extra: [
					{
						kind: "DASH",
						key: "dash1",
						dash: { jitPlacement: "VOD_AND_PREVIEW" },
					},
				],
			},
		});
	});
});

/**
 * The VOD job-creation wizard is one of the two screens the owner named as still
 * English. These assert hardcoded Japanese literals, never a `t` lookup: a lookup
 * passes against any catalogue, including the English one.
 */
describe("EncodingOptionsSection — Japanese", () => {
	it("renders the collapsible section titles in Japanese", async () => {
		render(
			<EncodingOptionsSection state={baseState} onPatch={vi.fn()} />,
			"ja",
		);
		for (const label of [
			"ラベルとインフラ",
			"開始オプション(詳細設定)",
			"AI シーン解析",
			"品質管理 (VMAF)",
		]) {
			expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
		}
		for (const english of [
			"Labels & infrastructure",
			"Start options (advanced)",
			"AI Scene Analysis",
		]) {
			expect(screen.queryByText(english), english).not.toBeInTheDocument();
		}
	});

	it("localizes an OptionFieldSpec label, which lives at module scope", async () => {
		render(
			<EncodingOptionsSection state={baseState} onPatch={vi.fn()} />,
			"ja",
		);
		// The spec tables carry `labelKey`, not a string — a table left holding an
		// English literal would render it here with no other symptom.
		expect(screen.getByText("エンコーディングモード")).toBeInTheDocument();
	});
});

describe("csvToPoolIds — the per-plan pool conversion (ledger #19)", () => {
	it("normalizes raw CSV to trimmed non-empty ids (review-176 M10)", () => {
		expect(csvToPoolIds(" pool-a , pool-b ,, ")).toEqual(["pool-a", "pool-b"]);
		expect(csvToPoolIds("")).toEqual([]);
		expect(csvToPoolIds(" , ,")).toEqual([]);
	});
});

/**
 * review-uibatch #9 — the #129 batch-3 conversions in ManifestSection,
 * pinned both directions (hidden until clicked; reachable once clicked).
 */
describe("ManifestSection — #129 help overlays", () => {
	it("the several-manifests note rides the additional-manifests ?", async () => {
		const { default: userEvent } = await import("@testing-library/user-event");
		render(<ManifestSection state={baseState} onPatch={vi.fn()} />);
		expect(
			screen.queryByText(/Several manifests of one kind are valid/i),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", {
				name: /Additional manifests — more information/i,
			}),
		);
		expect(
			await screen.findByText(/Several manifests of one kind are valid/i),
		).toBeInTheDocument();
	});

	it("the C1 timing note rides the generation-timing ?", async () => {
		const { default: userEvent } = await import("@testing-library/user-event");
		render(<ManifestSection state={baseState} onPatch={vi.fn()} />);
		expect(
			screen.queryByText(/Per-Title and multi-encoding plans/i),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", {
				name: /Generation timing — more information/i,
			}),
		);
		expect(
			await screen.findByText(/Per-Title and multi-encoding plans/i),
		).toBeInTheDocument();
	});
});

/**
 * review-uibatch #9 — the #129 batch-3 muxings intro, pinned both directions.
 * The trigger's subject is the STEP's name (review-uibatch #8: a literal
 * "Muxing" label named a section the stepper calls Packaging).
 */
describe("MuxingsSection — #129 help overlay", () => {
	it("the container-outputs intro hides behind the packaging ?", async () => {
		render(
			<MuxingsSection state={baseState} credentials={[]} onPatch={vi.fn()} />,
		);
		expect(
			screen.queryByText(/one or more container outputs per rendition/i),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: /Packaging — more information/i }),
		);
		expect(
			await screen.findByText(/container outputs per rendition/i),
		).toBeInTheDocument();
	});
});

describe("optional output defaults", () => {
	it("enables AISA with a real analysis.json filename", async () => {
		const onPatch = vi.fn();
		render(<EncodingOptionsSection state={baseState} onPatch={onPatch} />);
		const toggle = document.getElementById("wz-ai-enable");
		if (!toggle) throw new Error("AISA toggle missing");
		await userEvent.click(toggle);
		expect(
			onPatch.mock.calls.at(-1)?.[0].startOptions.aiSceneAnalysis.filename,
		).toBe("analysis.json");
	});
	it("hides generation timing without any manifests, including advanced placement", () => {
		render(
			<ManifestSection
				state={{ ...baseState, manifests: { hls: false, dash: false } }}
				onPatch={vi.fn()}
			/>,
		);
		expect(screen.queryByText("Generation timing")).toBeNull();
		expect(document.querySelector('input[name="wz-timing"]')).toBeNull();
	});
	it("retains generation timing for an additional manifest", () => {
		render(
			<ManifestSection
				state={{
					...baseState,
					manifests: {
						hls: false,
						dash: false,
						extra: [{ kind: "HLS", key: "extra" }],
					},
				}}
				onPatch={vi.fn()}
			/>,
		);
		expect(document.querySelector('input[name="wz-timing"]')).not.toBeNull();
	});
});

it("clearing a selected pool restores account inheritance rather than pinning an empty override", () => {
	const onPatch = vi.fn();
	render(
		<EncodingOptionsSection
			state={{ ...baseState, prewarmedEncoderPoolIds: ["pool-a"] }}
			onPatch={onPatch}
		/>,
	);
	fireEvent.click(screen.getByLabelText("Remove pool pool-a"));
	expect(onPatch).toHaveBeenCalledWith({ prewarmedEncoderPoolIds: undefined });
});
