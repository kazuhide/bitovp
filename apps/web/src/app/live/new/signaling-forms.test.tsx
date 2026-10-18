import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery as renderL } from "@/test/render";
import type { LiveWizardState } from "./build-live-plan";
import { DEFAULT_LIVE_WIZARD_STATE } from "./build-live-plan";
import { InputSection } from "./input-section";
import { LiveManifestsSection } from "./manifests-section";
import { LiveStartSection } from "./start-section";

/**
 * P5 PR-3 forms (ESAM/POIS, Cache-Control, ad insertion, HLS
 * program-date-time, SCTE-35 marker knobs, pinned RTMP input id). The
 * behaviour these pin is the one buildLiveChannelPlan cannot fix on its own:
 * a group whose last field is cleared must collapse to **undefined** in state,
 * because a lingering `{}` (or a `""` leaf) is what would grow a plan key and
 * break the live goldens' byte-identity.
 */

function startState(
	partial: Partial<LiveWizardState["start"]>,
): LiveWizardState {
	return {
		...DEFAULT_LIVE_WIZARD_STATE,
		start: { ...DEFAULT_LIVE_WIZARD_STATE.start, ...partial },
	};
}

/**
 * Renders a section, fires one change, returns the single patch it emitted.
 * Unmounts before asserting so a second call in the same test does not query a
 * stale copy (the sections use fixed control ids).
 */
function patchFrom(
	ui: React.ReactElement,
	act: () => void,
	onPatch: ReturnType<typeof vi.fn>,
): Partial<LiveWizardState> {
	const { unmount } = renderL(ui);
	act();
	unmount();
	expect(onPatch).toHaveBeenCalledTimes(1);
	return onPatch.mock.calls[0]?.[0];
}

describe("LiveStartSection — signaling & delivery groups collapse when cleared", () => {
	it("emits esam while a field is filled and undefined once the last one is blanked", () => {
		const onPatch = vi.fn();
		const patch = patchFrom(
			<LiveStartSection
				state={startState({
					esam: { poisEndpoint: "https://pois.example.com" },
				})}
				onPatch={onPatch}
			/>,
			() =>
				fireEvent.change(screen.getByLabelText("POIS endpoint"), {
					target: { value: "" },
				}),
			onPatch,
		);
		expect(patch.start?.esam).toBeUndefined();
	});

	it("keeps the remaining esam fields when only one is blanked", () => {
		const onPatch = vi.fn();
		const patch = patchFrom(
			<LiveStartSection
				state={startState({
					esam: {
						poisEndpoint: "https://pois.example.com",
						zoneIdentity: "z1",
					},
				})}
				onPatch={onPatch}
			/>,
			() =>
				fireEvent.change(screen.getByLabelText("POIS endpoint"), {
					target: { value: "" },
				}),
			onPatch,
		);
		expect(patch.start?.esam).toEqual({
			poisEndpoint: undefined,
			zoneIdentity: "z1",
		});
	});

	it("stores the ESAM ad-avail offset as a number (ms)", () => {
		const onPatch = vi.fn();
		const patch = patchFrom(
			<LiveStartSection state={startState({})} onPatch={onPatch} />,
			() =>
				fireEvent.change(screen.getByLabelText("Ad avail offset (ms)"), {
					target: { value: "-1500" },
				}),
			onPatch,
		);
		expect(patch.start?.esam).toEqual({ adAvailOffset: -1500 });
	});

	it("collapses cacheControl entirely when its last leaf is blanked", () => {
		const onPatch = vi.fn();
		const patch = patchFrom(
			<LiveStartSection
				state={startState({
					cacheControl: {
						segments: { mediaSegment: { cacheControl: "public, max-age=60" } },
					},
				})}
				onPatch={onPatch}
			/>,
			() =>
				fireEvent.change(screen.getByLabelText("Media segment"), {
					target: { value: "" },
				}),
			onPatch,
		);
		expect(patch.start?.cacheControl).toBeUndefined();
	});

	it("writes a Cache-Control leaf into its own family", () => {
		const onPatch = vi.fn();
		const patch = patchFrom(
			<LiveStartSection state={startState({})} onPatch={onPatch} />,
			() =>
				fireEvent.change(screen.getByLabelText("HLS variant playlist"), {
					target: { value: "public, max-age=2" },
				}),
			onPatch,
		);
		expect(patch.start?.cacheControl).toEqual({
			hls: { variantPlaylist: { cacheControl: "public, max-age=2" } },
		});
	});

	it("emits the clock-synchronization mode and drops it back to undefined", () => {
		const onPatch = vi.fn();
		const set = patchFrom(
			<LiveStartSection state={startState({})} onPatch={onPatch} />,
			() =>
				fireEvent.change(screen.getByLabelText("Clock synchronization mode"), {
					target: { value: "SYSTEM_CLOCK" },
				}),
			onPatch,
		);
		expect(set.start?.adInsertion).toEqual({
			clockSynchronizationMode: "SYSTEM_CLOCK",
		});
		const cleared = vi.fn();
		const back = patchFrom(
			<LiveStartSection
				state={startState({
					adInsertion: { clockSynchronizationMode: "SYSTEM_CLOCK" },
				})}
				onPatch={cleared}
			/>,
			() =>
				fireEvent.change(screen.getByLabelText("Clock synchronization mode"), {
					target: { value: "" },
				}),
			cleared,
		);
		expect(back.start?.adInsertion).toBeUndefined();
	});

	it("unchecking the ESAM media-point gate emits no false — the key disappears", () => {
		const onPatch = vi.fn();
		const patch = patchFrom(
			<LiveStartSection
				state={startState({
					adInsertion: { enableEsamMediaPointInsertion: true },
				})}
				onPatch={onPatch}
			/>,
			// The label also carries the ⓘ help text, so match on a substring.
			() =>
				fireEvent.click(
					screen.getByLabelText(/Enable ESAM media-point insertion/),
				),
			onPatch,
		);
		expect(patch.start?.adInsertion).toBeUndefined();
	});
});

describe("LiveManifestsSection — HLS program-date-time settings", () => {
	function hlsState(
		pdt?: LiveWizardState["manifests"]["hls"]["programDateTimeSettings"],
	): LiveWizardState {
		return {
			...DEFAULT_LIVE_WIZARD_STATE,
			manifests: {
				hls: {
					...DEFAULT_LIVE_WIZARD_STATE.manifests.hls,
					enabled: true,
					...(pdt ? { programDateTimeSettings: pdt } : {}),
				},
				dash: DEFAULT_LIVE_WIZARD_STATE.manifests.dash,
			},
		};
	}

	it("shows the interval only for the *_INTERVAL placement modes", () => {
		const { unmount } = renderL(
			<LiveManifestsSection
				state={hlsState({ placement: { mode: "ONCE_PER_PLAYLIST" } })}
				onPatch={vi.fn()}
			/>,
		);
		expect(screen.queryByLabelText(/^Interval/)).toBeNull();
		unmount();
		renderL(
			<LiveManifestsSection
				state={hlsState({
					placement: { mode: "SECONDS_INTERVAL", interval: 30 },
				})}
				onPatch={vi.fn()}
			/>,
		);
		expect(screen.getByLabelText("Interval (seconds)")).toHaveValue(30);
	});

	it("flags a missing interval — the schema refine would reject the plan", () => {
		renderL(
			<LiveManifestsSection
				state={hlsState({ placement: { mode: "SEGMENTS_INTERVAL" } })}
				onPatch={vi.fn()}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain(
			"interval is required for SEGMENTS_INTERVAL",
		);
	});

	it("drops a stale interval when switching to ONCE_PER_PLAYLIST", () => {
		const onPatch = vi.fn();
		const patch = patchFrom(
			<LiveManifestsSection
				state={hlsState({
					source: "SYSTEM_CLOCK",
					placement: { mode: "SECONDS_INTERVAL", interval: 30 },
				})}
				onPatch={onPatch}
			/>,
			() =>
				fireEvent.change(screen.getByLabelText("Placement mode"), {
					target: { value: "ONCE_PER_PLAYLIST" },
				}),
			onPatch,
		);
		expect(patch.manifests?.hls.programDateTimeSettings).toEqual({
			source: "SYSTEM_CLOCK",
			placement: { mode: "ONCE_PER_PLAYLIST" },
		});
	});

	it("collapses the PDT group when both source and placement are cleared", () => {
		const onPatch = vi.fn();
		const patch = patchFrom(
			<LiveManifestsSection
				state={hlsState({ placement: { mode: "ONCE_PER_PLAYLIST" } })}
				onPatch={onPatch}
			/>,
			() =>
				fireEvent.change(screen.getByLabelText("Placement mode"), {
					target: { value: "" },
				}),
			onPatch,
		);
		expect(patch.manifests?.hls.programDateTimeSettings).toBeUndefined();
	});
});

describe("LiveManifestsSection — SCTE-35 marker knobs (gated by the toggle)", () => {
	const gated = (scte35AdMarkers: boolean): LiveWizardState => ({
		...DEFAULT_LIVE_WIZARD_STATE,
		scte35AdMarkers,
	});

	it("hides every knob until SCTE-35 ad markers are enabled", () => {
		const { unmount } = renderL(
			<LiveManifestsSection state={gated(false)} onPatch={vi.fn()} />,
		);
		expect(screen.queryByLabelText("EXT_X_DATERANGE")).toBeNull();
		expect(screen.queryByLabelText("Period option")).toBeNull();
		unmount();
		renderL(<LiveManifestsSection state={gated(true)} onPatch={vi.fn()} />);
		expect(screen.getByLabelText("EXT_X_DATERANGE")).toBeInTheDocument();
		expect(screen.getByLabelText("Period option")).toBeInTheDocument();
	});

	it("keeps the marker-type list in canonical enum order", () => {
		const onPatch = vi.fn();
		const patch = patchFrom(
			<LiveManifestsSection
				state={{
					...gated(true),
					adMarkerOptions: { hlsMarkerTypes: ["EXT_X_SCTE35"] },
				}}
				onPatch={onPatch}
			/>,
			() => fireEvent.click(screen.getByLabelText("EXT_X_DATERANGE")),
			onPatch,
		);
		expect(patch.adMarkerOptions?.hlsMarkerTypes).toEqual([
			"EXT_X_DATERANGE",
			"EXT_X_SCTE35",
		]);
	});

	it("unchecking the last marker type falls back to the C14 default (no key)", () => {
		const onPatch = vi.fn();
		const patch = patchFrom(
			<LiveManifestsSection
				state={{
					...gated(true),
					adMarkerOptions: { hlsMarkerTypes: ["EXT_X_DATERANGE"] },
				}}
				onPatch={onPatch}
			/>,
			() => fireEvent.click(screen.getByLabelText("EXT_X_DATERANGE")),
			onPatch,
		);
		expect(patch.adMarkerOptions).toBeUndefined();
	});

	it("emits the DASH knobs and collapses them back to the defaults", () => {
		const onPatch = vi.fn();
		const set = patchFrom(
			<LiveManifestsSection state={gated(true)} onPatch={onPatch} />,
			() =>
				fireEvent.change(screen.getByLabelText("Event stream signalling"), {
					target: { value: "XML" },
				}),
			onPatch,
		);
		expect(set.adMarkerOptions).toEqual({ dashEventStreamSignalling: "XML" });
		const cleared = vi.fn();
		const back = patchFrom(
			<LiveManifestsSection
				state={{
					...gated(true),
					adMarkerOptions: { dashPeriodOption: "MULTI_PERIOD" },
				}}
				onPatch={cleared}
			/>,
			() =>
				fireEvent.change(screen.getByLabelText("Period option"), {
					target: { value: "" },
				}),
			cleared,
		);
		expect(back.adMarkerOptions).toBeUndefined();
	});
});

describe("InputSection — pinned RTMP input id (ledger #6)", () => {
	it("patches the RTMP input id and only shows on the RTMP variant", () => {
		const onPatch = vi.fn();
		renderL(
			<InputSection
				state={{ ...DEFAULT_LIVE_WIZARD_STATE, inputKind: "RTMP" }}
				credentials={[]}
				onPatch={onPatch}
			/>,
		);
		fireEvent.change(screen.getByLabelText("RTMP input id"), {
			target: { value: "00000000-0000-4000-8000-0000000000f6" },
		});
		expect(onPatch).toHaveBeenCalledWith({
			rtmp: { inputId: "00000000-0000-4000-8000-0000000000f6" },
		});
	});

	it("is absent for a created input kind (SRT has its own id-less contract)", () => {
		renderL(
			<InputSection
				state={{ ...DEFAULT_LIVE_WIZARD_STATE, inputKind: "SRT" }}
				credentials={[]}
				onPatch={vi.fn()}
			/>,
		);
		expect(screen.queryByLabelText("RTMP input id")).toBeNull();
	});
});

/**
 * review-uibatch #9 — the #129 batch-3 conversions in THIS file, pinned in
 * both directions per the stated standard: hidden until the ? is clicked
 * (an overlay that silently reverts to always-on prose is the owner's
 * request undone), and reachable once it is (never-opens = note deleted).
 */
describe("LiveManifestsSection — #129 help overlays", () => {
	it("the PDT/C19 note hides behind the program-date-time ?", async () => {
		const { default: userEvent } = await import("@testing-library/user-event");
		renderL(
			<LiveManifestsSection
				state={{
					...DEFAULT_LIVE_WIZARD_STATE,
					manifests: {
						hls: {
							...DEFAULT_LIVE_WIZARD_STATE.manifests.hls,
							enabled: true,
							insertProgramDateTime: true,
						},
						dash: DEFAULT_LIVE_WIZARD_STATE.manifests.dash,
					},
				}}
				onPatch={vi.fn()}
			/>,
		);
		expect(
			screen.queryByText(/Where the PDT wall-clock comes from/i),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", {
				name: /Program-date-time settings — more information/i,
			}),
		);
		expect(
			await screen.findByText(/Where the PDT wall-clock comes from/i),
		).toBeInTheDocument();
	});

	it("the SCTE-35 carrier note hides behind its ?", async () => {
		const { default: userEvent } = await import("@testing-library/user-event");
		renderL(
			<LiveManifestsSection
				state={DEFAULT_LIVE_WIZARD_STATE}
				onPatch={vi.fn()}
			/>,
		);
		expect(
			screen.queryByText(/Outputs SCTE-35 markers/i),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", {
				name: /SCTE-35 ad markers — more information/i,
			}),
		);
		expect(
			await screen.findByText(/Outputs SCTE-35 markers/i),
		).toBeInTheDocument();
	});
});
