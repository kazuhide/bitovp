import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as renderL } from "@/test/render";
import type { LiveWizardState } from "./build-live-plan";
import { DEFAULT_LIVE_WIZARD_STATE } from "./build-live-plan";
import { InputSection } from "./input-section";

/**
 * SRT backup rows share one `port` field across both modes (unlike the main
 * input's split listenerPort/callerPort), so the LISTENER switch must snap
 * out-of-range ports into the 2088–2091 rail — otherwise the LISTENER port
 * select renders with a value matching none of its options while the stale
 * port stays in wizard state.
 */

function srtStateWithBackup(
	backup: LiveWizardState["srt"]["backups"][number],
): LiveWizardState {
	return {
		...DEFAULT_LIVE_WIZARD_STATE,
		inputKind: "SRT",
		srt: { ...DEFAULT_LIVE_WIZARD_STATE.srt, backups: [backup] },
	};
}

function switchBackupMode(state: LiveWizardState, mode: "LISTENER" | "CALLER") {
	const onPatch = vi.fn();
	renderL(<InputSection state={state} credentials={[]} onPatch={onPatch} />);
	fireEvent.change(screen.getByLabelText("Backup 1 mode"), {
		target: { value: mode },
	});
	expect(onPatch).toHaveBeenCalledTimes(1);
	return onPatch.mock.calls[0]?.[0].srt.backups[0];
}

describe("InputSection SRT backup mode switch (LISTENER port rail)", () => {
	it("snaps an out-of-range caller port to 2089 when switching to LISTENER", () => {
		const patched = switchBackupMode(
			srtStateWithBackup({
				mode: "CALLER",
				host: "203.0.113.10",
				port: 9000,
				credentialId: "",
				keyLength: 256,
			}),
			"LISTENER",
		);
		expect(patched).toMatchObject({ mode: "LISTENER", port: 2089 });
	});

	it("snaps an unset port to 2089 when switching to LISTENER", () => {
		const patched = switchBackupMode(
			srtStateWithBackup({
				mode: "CALLER",
				host: "203.0.113.10",
				credentialId: "",
				keyLength: 256,
			}),
			"LISTENER",
		);
		expect(patched).toMatchObject({ mode: "LISTENER", port: 2089 });
	});

	it("keeps an in-range port when switching to LISTENER", () => {
		const patched = switchBackupMode(
			srtStateWithBackup({
				mode: "CALLER",
				host: "203.0.113.10",
				port: 2090,
				credentialId: "",
				keyLength: 256,
			}),
			"LISTENER",
		);
		expect(patched).toMatchObject({ mode: "LISTENER", port: 2090 });
	});

	it("never rewrites the port when switching to CALLER", () => {
		const patched = switchBackupMode(
			srtStateWithBackup({
				mode: "LISTENER",
				host: "",
				port: 2088,
				credentialId: "",
				keyLength: 256,
			}),
			"CALLER",
		);
		expect(patched).toMatchObject({ mode: "CALLER", port: 2088 });
	});
});

/**
 * The live-channel wizard is the second screen the owner named as still English.
 * The literals are hardcoded rather than read back through `t`: a lookup passes
 * against any catalogue, including the English one.
 */
describe("InputSection — Japanese", () => {
	it("renders the input-kind options and their hints in Japanese", () => {
		renderL(
			<InputSection
				state={{ ...DEFAULT_LIVE_WIZARD_STATE, inputKind: "RTMP" }}
				credentials={[]}
				onPatch={vi.fn()}
			/>,
			"ja",
		);
		// `INPUT_KINDS` lives at module scope and now carries `labelKey`/`hintKey`;
		// a table left holding an English literal would render it here.
		expect(screen.getByText("冗長 RTMP")).toBeInTheDocument();
		expect(screen.getByText("HLS プル")).toBeInTheDocument();
		// Pin the input-kind hint separately from the longer RTMP explanation.
		expect(
			screen.getByText(/アカウント既定の RTMP 入力を一覧から選びます/),
		).toBeInTheDocument();
		expect(screen.queryByText("Redundant RTMP")).not.toBeInTheDocument();
	});

	it("localizes an interpolated aria-label on an SRT backup row", () => {
		renderL(
			<InputSection
				state={srtStateWithBackup({
					mode: "CALLER",
					host: "203.0.113.10",
					port: 9000,
					credentialId: "",
					keyLength: 256,
				})}
				credentials={[]}
				onPatch={vi.fn()}
			/>,
			"ja",
		);
		/* The numbered backup-mode label proves that both translation placeholders were filled. */
		expect(
			screen.getByLabelText("バックアップ 1 のモード"),
		).toBeInTheDocument();
	});
});

/**
 *  / review-247-A1: the STATIC radio label is the only render of
 * the interpolated static-ingest URL, and a mistyped {url} placeholder THROWS
 * at render (lib/i18n/index.ts) — green tests, crashed wizard. This executes
 * the interpolation and pins the corrected FQDN (live-input — the NXDOMAIN'd
 * live-ingest's replacement) at the render layer: the drift class #113 kills.
 */
describe("InputSection REDUNDANT_RTMP static ingest label (ledger #113)", () => {
	it("renders the interpolated static URL — the corrected live-input FQDN", () => {
		renderL(
			<InputSection
				state={{ ...DEFAULT_LIVE_WIZARD_STATE, inputKind: "REDUNDANT_RTMP" }}
				credentials={[]}
				onPatch={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(/rtmps:\/\/live-input\.bitmovin\.com\/live/),
		).toBeInTheDocument();
	});
});

it("shows unavailable SRT passphrases instead of claiming no passphrase", () => {
	const state = srtStateWithBackup({
		mode: "CALLER",
		host: "ingest.example",
		port: 9000,
		credentialId: "missing-backup",
		keyLength: 256,
	});
	state.srt.credentialId = "missing-primary";
	renderL(<InputSection state={state} credentials={[]} onPatch={vi.fn()} />);
	expect(document.getElementById("lw-srt-cred")).toHaveValue("missing-primary");
	expect(document.getElementById("lw-srt-b-0-cred")).toHaveValue(
		"missing-backup",
	);
	expect(
		screen.getByRole("option", { name: "missing-primary (missing)" }),
	).toBeInTheDocument();
});
