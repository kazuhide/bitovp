import { DEFAULT_VMAF_MODEL } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { renderWithQuery } from "@/test/render";

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
import { evaluateWizardState, PlanPreview } from "./plan-preview";
import { EncodingOptionsSection, ManifestSection } from "./wizard-sections";

/**
 * The VOD wizard QC toggle  — a "Quality control (VMAF)"
 * section in the Encoding-options step that drives plan.qc. These guard:
 *  - the toggle renders and reveals model + PSNR only when VMAF is on,
 *  - it patches the wizard's qc state with the Per-Title/AISA prune shape,
 *  - the Review-step plan-JSON preview (compiled ops + plan doc) reflects qc.
 */

const baseState: WizardState = {
	name: "qc-ui",
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
		basePath: "output/qc-ui/",
		publicRead: true,
		name: "S3 Output",
	},
	videos: [
		{ height: 360, bitrate: 300_000 },
		{ height: 540, bitrate: 600_000 },
	],
	audios: [{ bitrate: 64_000, rate: 44_100 }],
	audioGuard: false,
	manifests: { hls: true, dash: false },
	timing: "POST_ENCODING",
};

describe("EncodingOptionsSection — Quality control (VMAF)", () => {
	it("renders the VMAF toggle, hiding model + PSNR until it is on", () => {
		render(<EncodingOptionsSection state={baseState} onPatch={vi.fn()} />);
		expect(
			screen.getByLabelText("Run VMAF QC after encoding"),
		).toBeInTheDocument();
		// Off by default ⇒ no model select, no PSNR toggle yet.
		expect(screen.queryByLabelText("VMAF model")).not.toBeInTheDocument();
		expect(
			screen.queryByLabelText("Also compute PSNR"),
		).not.toBeInTheDocument();
	});

	it("enabling VMAF patches qc:{vmaf:true} (default model, psnr off)", () => {
		const onPatch = vi.fn();
		render(<EncodingOptionsSection state={baseState} onPatch={onPatch} />);
		fireEvent.click(screen.getByLabelText("Run VMAF QC after encoding"));
		expect(onPatch).toHaveBeenCalledWith({
			qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: false },
		});
	});

	it("reveals the model select and PSNR toggle once VMAF is on", () => {
		render(
			<EncodingOptionsSection
				state={{
					...baseState,
					qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: false },
				}}
				onPatch={vi.fn()}
			/>,
		);
		const model = screen.getByLabelText("VMAF model") as HTMLSelectElement;
		expect(model).toBeInTheDocument();
		// The bundled models are offered: the v0.6.1 built-ins + ALL EIGHT VMAF v1
		// (vmaf_v1.0.16_*) models loaded by file from the Docker worker. Four of the
		// eight were added on 2026-08-11 after every bundled model was measured
		// scoring through the product ;
		// before that only vmaf_v1.0.16_3d0h had ever produced a score. The `float_`
		// variants are deliberately absent — ~4.4x the scoring time for ~0.02 of
		// score. `vmaf-models.test.ts` separately checks each entry against the
		// image's own model manifest.
		expect([...model.options].map((o) => o.value)).toEqual([
			"vmaf_v0.6.1",
			"vmaf_v0.6.1neg",
			"vmaf_4k_v0.6.1",
			"vmaf_v1.0.16_1d5h_2160",
			"vmaf_v1.0.16_3d0h",
			"vmaf_v1.0.16_3d0h_2160",
			"vmaf_v1.0.16_5d0h",
			"vmaf_v1.0.16_hfr_1d5h_2160",
			"vmaf_v1.0.16_hfr_3d0h",
			"vmaf_v1.0.16_hfr_3d0h_2160",
			"vmaf_v1.0.16_hfr_5d0h",
		]);
		expect(screen.getByLabelText("Also compute PSNR")).toBeInTheDocument();
	});

	it("selecting a model patches qc.model", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{
					...baseState,
					qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: false },
				}}
				onPatch={onPatch}
			/>,
		);
		fireEvent.change(screen.getByLabelText("VMAF model"), {
			target: { value: "vmaf_4k_v0.6.1" },
		});
		expect(onPatch).toHaveBeenCalledWith({
			qc: { vmaf: true, model: "vmaf_4k_v0.6.1", psnr: false },
		});
	});

	it("toggling PSNR patches qc.psnr", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{
					...baseState,
					qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: false },
				}}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByLabelText("Also compute PSNR"));
		expect(onPatch).toHaveBeenCalledWith({
			qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: true },
		});
	});

	it("turning VMAF off clears PSNR too (clean default, no psnr-only state)", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{
					...baseState,
					qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: true },
				}}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByLabelText("Run VMAF QC after encoding"));
		expect(onPatch).toHaveBeenCalledWith({
			qc: { vmaf: false, model: DEFAULT_VMAF_MODEL, psnr: false },
		});
	});

	it("hides the 'VMAF only' toggle until VMAF is on", () => {
		render(<EncodingOptionsSection state={baseState} onPatch={vi.fn()} />);
		expect(
			screen.queryByLabelText("VMAF only (skip delivery outputs)"),
		).not.toBeInTheDocument();
	});

	it("reveals the 'VMAF only' toggle once VMAF is on", () => {
		render(
			<EncodingOptionsSection
				state={{
					...baseState,
					qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: false },
				}}
				onPatch={vi.fn()}
			/>,
		);
		expect(
			screen.getByLabelText("VMAF only (skip delivery outputs)"),
		).toBeInTheDocument();
	});

	it("toggling 'VMAF only' patches qc.only", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{
					...baseState,
					qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: false },
				}}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByLabelText("VMAF only (skip delivery outputs)"));
		expect(onPatch).toHaveBeenCalledWith({
			qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: false, only: true },
		});
	});
});

describe("ManifestSection — disabled under VMAF-only (qc.only)", () => {
	it("leaves the HLS/DASH manifest toggles enabled when qc.only is off", () => {
		render(<ManifestSection state={baseState} onPatch={vi.fn()} />);
		expect(screen.getByLabelText("HLS (stream.m3u8)")).not.toBeDisabled();
		expect(screen.getByLabelText("DASH (stream.mpd)")).not.toBeDisabled();
	});

	it("disables the manifest controls and shows a notice when qc.only is on", () => {
		render(
			<ManifestSection
				state={{
					...baseState,
					qc: {
						vmaf: true,
						model: DEFAULT_VMAF_MODEL,
						psnr: false,
						only: true,
					},
				}}
				onPatch={vi.fn()}
			/>,
		);
		// A native <fieldset disabled> disables every descendant control.
		expect(screen.getByLabelText("HLS (stream.m3u8)")).toBeDisabled();
		expect(screen.getByLabelText("DASH (stream.mpd)")).toBeDisabled();
		expect(screen.getByText(/VMAF only is on/i)).toBeInTheDocument();
	});
});

describe("plan preview reflects qc (Review step)", () => {
	it("adds a QC MP4 mirror op per video rendition when qc is on", () => {
		const off = evaluateWizardState(baseState);
		const on = evaluateWizardState({
			...baseState,
			qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: false },
		});
		if (!off.ok || !on.ok) {
			throw new Error("expected valid plans");
		}
		// Two video renditions ⇒ two extra qc-muxing ops with qc on.
		expect(on.opCount).toBe(off.opCount + 2);
	});

	it("shows the qc block (model + psnr) in the Plan JSON preview", async () => {
		const { default: userEvent } = await import("@testing-library/user-event");
		const user = userEvent.setup();
		const on = evaluateWizardState({
			...baseState,
			qc: { vmaf: true, model: "vmaf_4k_v0.6.1", psnr: true },
		});
		render(<PlanPreview evaluation={on} />);
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		const json = screen.getByTestId("plan-json").textContent ?? "";
		expect(json).toContain('"qc"');
		expect(json).toContain('"model": "vmaf_4k_v0.6.1"');
		expect(json).toContain('"psnr": true');
	});
});

/**
 * QC gate editor : the wizard's authoring surface for
 * plan.qc.gate — the last piece of row 86's recorded deferral. The pins:
 * zero rules = NO gate key (an empty gate cannot reach the schema), the
 * patch shape is the schema shape VERBATIM, target checkboxes drive
 * rule.renditions with empty-selection = absent, and the C29 hint appears
 * only under BLOCK_MANIFESTS.
 */
describe("EncodingOptionsSection — QC gate editor", () => {
	const DEFAULT_QC_FOR_TEST = {
		vmaf: true,
		model: DEFAULT_VMAF_MODEL,
		psnr: false,
	};
	const gateOnState: WizardState = {
		...baseState,
		qc: DEFAULT_QC_FOR_TEST,
	};

	it("adds a first rule with the schema-shaped patch (MARK_ONLY default)", () => {
		const onPatch = vi.fn();
		render(<EncodingOptionsSection state={gateOnState} onPatch={onPatch} />);
		fireEvent.click(screen.getByRole("button", { name: "Add gate rule" }));
		expect(onPatch).toHaveBeenCalledWith({
			qc: {
				vmaf: true,
				model: DEFAULT_VMAF_MODEL,
				psnr: false,
				gate: {
					rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 80 }],
					onFail: "MARK_ONLY",
				},
			},
		});
	});

	it("removing the last rule removes the WHOLE gate key", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{
					...gateOnState,
					qc: {
						...(gateOnState.qc ?? DEFAULT_QC_FOR_TEST),
						gate: {
							rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 80 }],
							onFail: "BLOCK_MANIFESTS",
						},
					},
				}}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove gate rule 1" }));
		const patched = onPatch.mock.calls[0]?.[0] as {
			qc: { gate?: unknown };
		};
		expect(patched.qc.gate).toBeUndefined();
	});

	it("target checkboxes list the ladder's video keys; empty selection = renditions absent", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{
					...gateOnState,
					qc: {
						...(gateOnState.qc ?? DEFAULT_QC_FOR_TEST),
						gate: {
							rules: [
								{
									metric: "VMAF_MIN",
									scope: "PER_RENDITION",
									gte: 60,
									renditions: ["v360"],
								},
							],
							onFail: "MARK_ONLY",
						},
					},
				}}
				onPatch={onPatch}
			/>,
		);
		// baseState's ladder is 360p/540p — unique heights keep the
		// fixture-identical key form (videoKeys docblock): v360 / v540.
		const v360 = screen.getByLabelText("v360") as HTMLInputElement;
		expect(v360.checked).toBe(true);
		expect((screen.getByLabelText("v540") as HTMLInputElement).checked).toBe(
			false,
		);
		// Unticking the only selected key drops `renditions` entirely.
		fireEvent.click(v360);
		const patched = onPatch.mock.calls[0]?.[0] as {
			qc: { gate: { rules: { renditions?: string[] }[] } };
		};
		expect(patched.qc.gate.rules[0]?.renditions).toBeUndefined();
	});

	it("clearing the threshold keeps the LAST VALID value — never snaps to 0 (review-204 I2)", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{
					...gateOnState,
					qc: {
						...DEFAULT_QC_FOR_TEST,
						gate: {
							rules: [
								{
									metric: "VMAF_MEAN" as const,
									scope: "OVERALL" as const,
									gte: 85,
								},
							],
							onFail: "MARK_ONLY" as const,
						},
					},
				}}
				onPatch={onPatch}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Threshold"), {
			target: { value: "" },
		});
		// No patch at all: the state keeps 85 (the C29 gte-0 warning covers a
		// DELIBERATE zero typed as "0").
		expect(onPatch).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Threshold"), {
			target: { value: "90" },
		});
		expect(onPatch).toHaveBeenCalledTimes(1);
	});

	it("an ORPHANED target key renders as a checked box that can be unticked (review-204 N1)", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{
					...gateOnState,
					qc: {
						...DEFAULT_QC_FOR_TEST,
						gate: {
							rules: [
								{
									metric: "VMAF_MIN" as const,
									scope: "PER_RENDITION" as const,
									gte: 60,
									renditions: ["vGONE"],
								},
							],
							onFail: "MARK_ONLY" as const,
						},
					},
				}}
				onPatch={onPatch}
			/>,
		);
		const orphan = screen.getByLabelText("vGONE") as HTMLInputElement;
		expect(orphan.checked).toBe(true);
		fireEvent.click(orphan);
		const patched = onPatch.mock.calls[0]?.[0] as {
			qc: { gate: { rules: { renditions?: string[] }[] } };
		};
		expect(patched.qc.gate.rules[0]?.renditions).toBeUndefined();
	});

	it("PSNR_MEAN is disabled while qc.psnr is off (review-204 N5)", () => {
		render(
			<EncodingOptionsSection
				state={{
					...gateOnState,
					qc: {
						...DEFAULT_QC_FOR_TEST,
						gate: {
							rules: [
								{
									metric: "VMAF_MEAN" as const,
									scope: "OVERALL" as const,
									gte: 80,
								},
							],
							onFail: "MARK_ONLY" as const,
						},
					},
				}}
				onPatch={vi.fn()}
			/>,
		);
		const option = screen.getByRole("option", {
			name: /PSNR_MEAN \(enable PSNR first\)/,
		}) as HTMLOptionElement;
		expect(option.disabled).toBe(true);
	});

	it("the C29 hint renders only under BLOCK_MANIFESTS", () => {
		const withMode = (
			onFail: "MARK_ONLY" | "BLOCK_MANIFESTS",
		): WizardState => ({
			...gateOnState,
			qc: {
				...(gateOnState.qc ?? DEFAULT_QC_FOR_TEST),
				gate: {
					rules: [
						{
							metric: "VMAF_MEAN" as const,
							scope: "OVERALL" as const,
							gte: 80,
						},
					],
					onFail,
				},
			},
		});
		const { unmount } = render(
			<EncodingOptionsSection
				state={withMode("MARK_ONLY")}
				onPatch={vi.fn()}
			/>,
		);
		expect(screen.queryByText(/Blocking requires every manifest/)).toBeNull();
		unmount();
		render(
			<EncodingOptionsSection
				state={withMode("BLOCK_MANIFESTS")}
				onPatch={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(/Blocking requires every manifest/),
		).toBeInTheDocument();
	});

	it("the Review-step plan JSON carries the authored gate verbatim", () => {
		const state: WizardState = {
			...gateOnState,
			qc: {
				...(gateOnState.qc ?? DEFAULT_QC_FOR_TEST),
				gate: {
					rules: [{ metric: "VMAF_HARMONIC_MEAN", scope: "OVERALL", gte: 88 }],
					onFail: "BLOCK_MANIFESTS",
				},
			},
		};
		const evaluated = evaluateWizardState(state);
		if (!evaluated.ok) {
			throw new Error(`plan invalid: ${evaluated.zodMessage}`);
		}
		expect(evaluated.plan.qc?.gate).toEqual({
			rules: [{ metric: "VMAF_HARMONIC_MEAN", scope: "OVERALL", gte: 88 }],
			onFail: "BLOCK_MANIFESTS",
		});
	});
	it("the whole QC section is gone while QC/VMAF is OFF, so a new plan cannot carry qc (ledger #131)", () => {
		const off = render(
			<EncodingOptionsSection state={baseState} onPatch={vi.fn()} />,
			"en",
			false,
		);
		expect(screen.queryByText(/Quality control/i)).not.toBeInTheDocument();
		// A sibling section survives — a gate that hid the whole step would
		// also pass a bare absence check.
		expect(screen.getAllByText(/Per-Title/i).length).toBeGreaterThan(0);
		off.unmount();

		render(<EncodingOptionsSection state={baseState} onPatch={vi.fn()} />);
		expect(screen.getByText(/Quality control/i)).toBeInTheDocument();
	});
	it("OFF with a plan that CARRIES qc offers an explicit removal — the 422 must not name a remedy the UI cannot perform (review-265 131-A4)", async () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{
					...baseState,
					qc: { vmaf: true, psnr: false, model: "vmaf_v0.6.1" },
				}}
				onPatch={onPatch}
			/>,
			"en",
			false,
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(/turned off/i);
		fireEvent.click(
			screen.getByRole("button", { name: /Remove the QC block/i }),
		);
		expect(onPatch).toHaveBeenCalledWith({ qc: undefined });
	});
});
