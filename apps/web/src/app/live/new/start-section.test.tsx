import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DEFAULT_LIVE_WIZARD_STATE } from "./build-live-plan";

// The estimate renders only when the in-progress state already builds a
// VALID plan — mirror build-live-plan.test's minimal valid shape.
const STATE = {
	...DEFAULT_LIVE_WIZARD_STATE,
	name: "seed-test",
	accountId: "00000000-0000-4000-8000-0000000000aa",
	inputKind: "RTMP" as const,
	output: {
		publicRead: false,
		credentialId: "00000000-0000-4000-8000-0000000000e1",
		kind: "S3" as const,
		bucket: "b",
		basePath: "out/x",
		name: "out",
	},
	videos: [
		{
			codec: "H264" as const,
			height: 720,
			bitrate: 3_000_000,
			presetConfiguration: "LIVE_STANDARD" as const,
		},
	],
	audios: [{ codec: "AAC" as const, bitrate: 128_000, rate: 48_000 }],
	start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "seedtest" },
};

import { LiveStartSection } from "./start-section";

const apiFetch = vi.fn(async (..._args: unknown[]) => ({
	defaults: {
		rateCard: { currency: "USD", liveRates: [{ maxHeight: 1080, perHour: 6 }] },
	},
}));
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

describe("LiveStartSection — automatic stop minimums", () => {
	it.each([
		["lw-as-bytes", 30],
		["lw-as-stream", 5],
		["lw-as-first", 5],
	] as const)("%s enforces the API minimum while allowing an unset value", async (id, minimum) => {
		renderWithQuery(<LiveStartSection state={STATE} onPatch={() => {}} />);
		await screen.findByLabelText(/minutes/i, {
			selector: "input, select, textarea",
		});
		const input = document.getElementById(id) as HTMLInputElement;
		expect(input).not.toBeNull();
		input.value = String(minimum - 1);
		expect(input.validity.rangeUnderflow).toBe(true);
		input.value = String(minimum);
		expect(input.validity.valid).toBe(true);
		input.value = "";
		expect(input.validity.valid).toBe(true);
	});
});

/**
 * review-260 #125: the estimate's default minutes must agree with the billing
 * sentence beside it — seeded provision(now)→programEndAt + margin when step 7
 * holds a slot, flat 60 otherwise. Unpinned, this regresses to 60 silently.
 * The half-minute clock keeps ceil/floor distinguishable (719.5 → 720 + 30).
 */
describe("LiveStartSection — estimate seeding (ledger #125)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(new Date("2026-09-01T10:00:30.000Z"));
	});
	afterEach(() => vi.useRealTimers());

	it("seeds from the schedule's end when a slot exists; flat 60 without one", async () => {
		const view = renderWithQuery(
			<LiveStartSection
				state={STATE}
				onPatch={() => {}}
				scheduledEndAt="2026-09-01T22:00:00.000Z"
			/>,
		);
		const seeded = (await screen.findByLabelText(
			/minutes/i,
		)) as HTMLInputElement;
		expect(seeded.value).toBe("750");
		view.unmount();

		renderWithQuery(
			<LiveStartSection
				state={STATE}
				onPatch={() => {}}
				scheduledEndAt={null}
			/>,
		);
		const flat = (await screen.findByLabelText(/minutes/i, {
			selector: "input, select, textarea",
		})) as HTMLInputElement;
		expect(flat.value).toBe("60");
	});
});

/**
 * #129 batch 3 (running-app inventory): the auto-restart timeout note moved
 * behind the section heading's ? — pinned in BOTH directions (the G-round
 * lesson: an overlay that silently reverts to always-on prose is the owner's
 * request undone, and one that never opens is the note deleted).
 */
describe("LiveStartSection — help overlays (#129 batch 3)", () => {
	it("auto-shutdown and re-upload notes ride their own ? triggers", async () => {
		const { default: userEvent } = await import("@testing-library/user-event");
		renderWithQuery(<LiveStartSection state={STATE} onPatch={() => {}} />);
		expect(
			screen.queryByText(/Independent of auto-restart/i),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", {
				name: /Automatic stop — more information/i,
			}),
		);
		expect(
			await screen.findByText(/Independent of auto-restart/i),
		).toBeInTheDocument();
		// Close it (Escape) so the next overlay's panel is unambiguous.
		await userEvent.keyboard("{Escape}");
		expect(
			screen.queryByText(/HLS manifest interval is deliberately absent/i),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", {
				name: /Re-upload settings — more information/i,
			}),
		);
		expect(
			await screen.findByText(/HLS manifest interval is deliberately absent/i),
		).toBeInTheDocument();
	});

	it("the timeout note is hidden until the auto-restart ? is clicked", async () => {
		const { default: userEvent } = await import("@testing-library/user-event");
		renderWithQuery(<LiveStartSection state={STATE} onPatch={() => {}} />);
		expect(
			screen.queryByText(/Every timeout has an API minimum/i),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: /Auto-restart — more information/i }),
		);
		expect(
			await screen.findByText(/Every timeout has an API minimum/i),
		).toBeInTheDocument();
	});
});

/**
 * rev433 (owner 2026-09-07): with STATIC ingest points the stream key an
 * encoder pushes with is the point's own (GENERATE / ASSIGN), so the wizard
 * stops asking for the start request's key and says who owns it.
 */
describe("LiveStartSection — the stream key field", () => {
	it("is asked for on an account-default RTMP input", async () => {
		renderWithQuery(
			<LiveStartSection
				state={STATE}
				onPatch={() => {}}
				scheduledEndAt={null}
			/>,
		);
		await screen.findByLabelText(/minutes/i, {
			selector: "input, select, textarea",
		});
		expect(document.querySelector("#lw-streamkey")).not.toBeNull();
		expect(screen.queryByTestId("lw-streamkey-managed")).toBeNull();
	});

	it("is replaced by the static-ingest note on a REDUNDANT_RTMP input with static points", async () => {
		renderWithQuery(
			<LiveStartSection
				state={{ ...STATE, inputKind: "REDUNDANT_RTMP" }}
				onPatch={() => {}}
				scheduledEndAt={null}
			/>,
		);
		expect(
			await screen.findByTestId("lw-streamkey-managed"),
		).toBeInTheDocument();
		expect(document.querySelector("#lw-streamkey")).toBeNull();
	});
});
