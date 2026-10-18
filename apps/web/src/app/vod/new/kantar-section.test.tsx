import type { CredentialSummaryWire } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery as render } from "@/test/render";
import type { WizardKantar, WizardState } from "./build-plan";
import { EncodingOptionsSection } from "./wizard-sections";

/**
 * The VOD wizard's "Kantar audio watermarking" section in the Encoding-options
 * step (beside Per-Title / AISA / QC). These guard the UI contract; the
 * buildPlan emission and the golden round-trip are pinned by build-plan.test.ts
 * and plan-to-wizard.test.ts.
 *
 * Kantar is an ENCODING-level singleton, so the section patches state.kantar
 * directly (unlike NexGuard, which attaches per rendition), and enabling it
 * seeds a BLANK block that buildPlan emits verbatim so the preview rails every
 * unfilled field loudly.
 */

const baseState: WizardState = {
	name: "kantar-ui",
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
		basePath: "output/kantar-ui/",
		publicRead: true,
		name: "S3 Output",
	},
	videos: [{ height: 360, bitrate: 300_000 }],
	audios: [{ bitrate: 64_000, rate: 44_100 }],
	audioGuard: false,
	manifests: { hls: true, dash: false },
	timing: "JUST_IN_TIME",
};

const filledKantar: WizardKantar = {
	credentialId: "00000000-0000-4000-8000-0000000000b1",
	licenseId: 4711,
	channelName: "Demo Channel JP",
	contentReference: "bbb-2026-08-06-ep01",
	serverUrl: "https://kantar.example.com/watermark",
	reportPath: "reports",
	reportPrivate: true,
};

const credential = (
	id: string,
	label: string,
	provider: CredentialSummaryWire["provider"],
): CredentialSummaryWire => ({
	id,
	label,
	provider,
	config: {},
	createdAt: "2026-08-06T00:00:00.000Z",
	updatedAt: "2026-08-06T00:00:00.000Z",
	// : a per-ROW fact, so every wire fixture must state it.
	hasSecret: true,
});

const credentials: CredentialSummaryWire[] = [
	credential("00000000-0000-4000-8000-0000000000b1", "Kantar prod", "KANTAR"),
	credential("00000000-0000-4000-8000-0000000000b2", "Kantar test", "KANTAR"),
	// Must NOT appear in the KANTAR picker.
	credential("00000000-0000-4000-8000-0000000000c1", "NexGuard", "NEXGUARD"),
	credential("00000000-0000-4000-8000-000000000002", "Origin S3", "AWS_S3"),
];

describe("EncodingOptionsSection — Kantar audio watermarking", () => {
	it("explains the vault-only login, the encoding-level singleton and AUDIO", () => {
		render(<EncodingOptionsSection state={baseState} onPatch={vi.fn()} />);
		expect(
			screen.queryByText(/Embeds an inaudible Kantar watermark/),
		).not.toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Kantar audio watermarking — more information",
			}),
		);
		const copy = screen.getByRole("note");
		// The three things a user must know before enabling this.
		expect(copy.textContent).toMatch(/AUDIO/);
		expect(copy.textContent).toMatch(/rejected by the plan validator/);
		expect(copy.textContent).toMatch(/ENCODING-level singleton/);
		expect(copy.textContent).toMatch(
			/every sibling encoding of a\s+multi-encoding ladder/,
		);
		expect(copy.textContent).toMatch(/vault-only/);
		expect(copy.textContent).toMatch(/Settings → Credentials/);
	});

	it("hides every field until the section is enabled", () => {
		render(<EncodingOptionsSection state={baseState} onPatch={vi.fn()} />);
		expect(
			screen.getByLabelText("Enable Kantar audio watermarking"),
		).toBeInTheDocument();
		for (const label of [
			"Kantar credential",
			"License id",
			"Channel name",
			"Content reference",
			"Server URL",
			"Report path",
		]) {
			expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
		}
	});

	it("enabling seeds a BLANK block (the schema rails the empty fields)", () => {
		const onPatch = vi.fn();
		render(<EncodingOptionsSection state={baseState} onPatch={onPatch} />);
		fireEvent.click(screen.getByLabelText("Enable Kantar audio watermarking"));
		// licenseId is deliberately absent, not 0 — buildPlan emits it verbatim so
		// the preview reads "expected number" instead of inventing a license.
		expect(onPatch).toHaveBeenCalledWith({
			kantar: {
				credentialId: "",
				channelName: "",
				contentReference: "",
				serverUrl: "",
				reportPath: "",
			},
		});
	});

	it("unchecking clears the whole block (no plan key)", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{ ...baseState, kantar: filledKantar }}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByLabelText("Enable Kantar audio watermarking"));
		expect(onPatch).toHaveBeenCalledWith({ kantar: undefined });
	});

	it("lists ONLY KANTAR credentials in the picker and patches the choice", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{ ...baseState, kantar: filledKantar }}
				onPatch={onPatch}
				credentials={credentials}
			/>,
		);
		const select = screen.getByLabelText(
			"Kantar credential",
		) as HTMLSelectElement;
		expect([...select.options].map((o) => o.textContent)).toEqual([
			"Select credential…",
			"Kantar prod",
			"Kantar test",
		]);
		fireEvent.change(select, {
			target: { value: "00000000-0000-4000-8000-0000000000b2" },
		});
		expect(onPatch).toHaveBeenCalledWith({
			kantar: {
				...filledKantar,
				credentialId: "00000000-0000-4000-8000-0000000000b2",
			},
		});
	});

	it("patches the job-metadata text fields", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{ ...baseState, kantar: filledKantar }}
				onPatch={onPatch}
				credentials={credentials}
			/>,
		);
		for (const [label, value, key] of [
			["Channel name", "Channel 2", "channelName"],
			["Content reference", "ep02", "contentReference"],
			["Server URL", "https://k2.example.com", "serverUrl"],
			["Report path", "kantar-reports", "reportPath"],
		] as const) {
			fireEvent.change(screen.getByLabelText(label), { target: { value } });
			expect(onPatch).toHaveBeenLastCalledWith({
				kantar: { ...filledKantar, [key]: value },
			});
		}
	});

	it("keeps a blank license id blank (undefined, never 0)", () => {
		const onPatch = vi.fn();
		render(
			<EncodingOptionsSection
				state={{ ...baseState, kantar: filledKantar }}
				onPatch={onPatch}
				credentials={credentials}
			/>,
		);
		const input = screen.getByLabelText("License id");
		fireEvent.change(input, { target: { value: "9001" } });
		expect(onPatch).toHaveBeenLastCalledWith({
			kantar: { ...filledKantar, licenseId: 9001 },
		});
		fireEvent.change(input, { target: { value: "" } });
		expect(onPatch).toHaveBeenLastCalledWith({
			kantar: { ...filledKantar, licenseId: undefined },
		});
	});

	it("toggles the report ACL independently of the output's publicRead", () => {
		const onPatch = vi.fn();
		const { rerender } = render(
			<EncodingOptionsSection
				state={{
					...baseState,
					kantar: { ...filledKantar, reportPrivate: undefined },
				}}
				onPatch={onPatch}
				credentials={credentials}
			/>,
		);
		const label = "Write the report privately (ACL PRIVATE)";
		expect(screen.getByLabelText(label)).not.toBeChecked();
		fireEvent.click(screen.getByLabelText(label));
		expect(onPatch).toHaveBeenLastCalledWith({
			kantar: { ...filledKantar, reportPrivate: true },
		});
		// Unticking returns to "inherit the output ACL" (unset, not false).
		rerender(
			<EncodingOptionsSection
				state={{ ...baseState, kantar: filledKantar }}
				onPatch={onPatch}
				credentials={credentials}
			/>,
		);
		expect(screen.getByLabelText(label)).toBeChecked();
		fireEvent.click(screen.getByLabelText(label));
		expect(onPatch).toHaveBeenLastCalledWith({
			kantar: { ...filledKantar, reportPrivate: undefined },
		});
	});

	it("warns when the plan has no audio rendition (the validator rejects it)", () => {
		const { rerender } = render(
			<EncodingOptionsSection
				state={{ ...baseState, audios: [], kantar: filledKantar }}
				onPatch={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(/This plan has no audio rendition/),
		).toBeInTheDocument();
		rerender(
			<EncodingOptionsSection
				state={{ ...baseState, kantar: filledKantar }}
				onPatch={vi.fn()}
			/>,
		);
		expect(
			screen.queryByText(/This plan has no audio rendition/),
		).not.toBeInTheDocument();
	});
});
