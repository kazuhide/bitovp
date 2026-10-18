import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

/* Mount the live output step to verify that configured MSL destinations remain selectable in the actual operator workflow. */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));

import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "./build-live-plan";
import { LiveWizard } from "./live-wizard";

const CREDENTIALS = [
	{
		id: "cred-msl",
		label: "akamai-msl4",
		provider: "AKAMAI_MSL",
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt: "2026-08-20T00:00:00.000Z",
	},
	{
		id: "cred-s3",
		label: "verify-aws",
		provider: "AWS_S3",
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt: "2026-08-20T00:00:00.000Z",
	},
	{
		id: "cred-aos",
		label: "Akamai storage",
		provider: "AKAMAI_OBJECT_STORAGE",
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt: "2026-08-20T00:00:00.000Z",
	},
	{
		id: "cred-drm",
		label: "widevine",
		provider: "DRM_CENC",
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt: "2026-08-20T00:00:00.000Z",
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/credentials") return CREDENTIALS;
		return [];
	});
});

it("offers AWS and Akamai storage without deployment-profile labeling", async () => {
	renderWithQuery(<LiveWizard />);
	expect(screen.queryByText(/Akamai-only deployment/)).toBeNull();
	const step = (
		await screen.findAllByRole("button", { name: /^\d+\. Destinations$/ })
	)[0];
	if (!step) throw Error("missing Destinations step");
	await userEvent.click(step);
	await waitFor(() =>
		expect(
			screen.getByRole("option", { name: /Akamai storage/ }),
		).toBeInTheDocument(),
	);
	expect(
		screen.getByRole("option", { name: /verify-aws/ }),
	).toBeInTheDocument();
});

it("keeps a valid AWS import available across rerenders", async () => {
	const raw = buildLiveChannelPlan({
		...DEFAULT_LIVE_WIZARD_STATE,
		name: "profile-import",
		accountId: "33333333-3333-4333-8333-333333333333",
		output: {
			...DEFAULT_LIVE_WIZARD_STATE.output,
			kind: "S3",
			credentialId: "44444444-4444-4444-8444-444444444444",
			bucket: "synthetic",
			basePath: "output",
		},
	});
	const rendered = renderWithQuery(<LiveWizard />);
	await userEvent.click(
		screen.getByRole("button", { name: /Import plan JSON/ }),
	);
	fireEvent.change(screen.getByLabelText("Live channel plan JSON"), {
		target: { value: JSON.stringify(raw) },
	});
	await userEvent.click(screen.getByRole("button", { name: "Load plan" }));
	const name = screen.getByRole("textbox", { name: "Channel name" });
	expect(name).toHaveValue("profile-import");
	rendered.rerender(<LiveWizard />);
	expect(name).toHaveValue("profile-import");
	expect(screen.queryByText(/PROFILE_AKAMAI_ONLY/)).toBeNull();
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
});

/** Walk to the output step and hand back its credential select. */
async function outputCredentialSelect(): Promise<HTMLSelectElement> {
	renderWithQuery(<LiveWizard />);
	// "4. Destinations" — a bare /output/i now lands on
	// "5. Output groups and manifests", one step past the credential select.
	const step = (
		await screen.findAllByRole("button", { name: /^\d+\. Destinations$/ })
	)[0];
	if (!step) throw new Error("no Destinations step button");
	await userEvent.click(step);
	// By ID, not by label: the step has more than one field whose label
	// contains "credential", so findByLabelText throws on the ambiguity.
	await waitFor(() =>
		expect(document.getElementById("lw-out-cred")).not.toBeNull(),
	);
	const select = document.getElementById("lw-out-cred");
	if (!(select instanceof HTMLSelectElement)) {
		throw new Error("output credential select not rendered");
	}
	return select;
}

function optionFor(
	select: HTMLSelectElement,
	label: string,
): HTMLOptionElement {
	const option = [...select.options].find((o) => o.text.includes(label));
	if (!option) {
		throw new Error(
			`no option for "${label}"; saw ${[...select.options].map((o) => o.text).join(" | ")}`,
		);
	}
	return option;
}

describe("live wizard — output destinations (owner, 2026-08-21)", () => {
	it("authors an optional storage mirror and lets the MP4 archive reuse it", async () => {
		const primary = await outputCredentialSelect();
		await userEvent.selectOptions(primary, "cred-msl");
		const enable = screen.getByRole("checkbox", {
			name: "Also deliver to storage",
		});
		expect(enable).not.toBeChecked();
		await userEvent.click(enable);
		const mirror = screen.getByRole("region", { name: "Storage mirror" });
		const select = within(mirror).getByLabelText("Credential");
		expect(
			within(select).queryByRole("option", { name: /akamai-msl4|widevine/ }),
		).toBeNull();
		await userEvent.selectOptions(select, "cred-aos");
		await userEvent.type(within(mirror).getByLabelText("Bucket"), "qa-media");
		await userEvent.click(
			screen.getByRole("checkbox", { name: "Save an MP4 archive" }),
		);
		const destination = document.getElementById("lw-archive-destination");
		if (!(destination instanceof HTMLSelectElement))
			throw new Error("no archive select");
		await userEvent.selectOptions(destination, "mirror-1");
		expect(destination.value).toBe("mirror-1");
		await userEvent.click(enable);
		expect(destination.value).toBe("mirror-1");
		expect(
			within(destination).getByRole("option", { name: /unavailable/i }),
		).toBeInTheDocument();
	});

	it("offers an Akamai MSL credential as a selectable destination", async () => {
		const select = await outputCredentialSelect();
		const msl = optionFor(select, "akamai-msl4");
		expect(
			msl.disabled,
			"an MSL4 credential is greyed out — Akamai live customers have no destination",
		).toBe(false);
	});

	it("still greys out a credential that is not a destination at all", async () => {
		// The negative direction. Without it, "nothing is disabled" passes the
		// test above, and that is a worse bug: a DRM key offered as an output.
		const select = await outputCredentialSelect();
		expect(optionFor(select, "widevine").disabled).toBe(true);
		expect(optionFor(select, "verify-aws").disabled).toBe(false);
	});

	it("opens the output prefix picker the moment a browsable credential is chosen, and not for MSL (owner request 2026-09-06)", async () => {
		// The picker lists buckets and objects as soon as it opens; answer its
		// reads with empty pages (the default `[]` has no `.buckets`, which
		// crashed the dialog inside the test and nowhere else).
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/credentials") return CREDENTIALS;
			if (url.includes("/buckets")) return { buckets: [] };
			if (url.includes("/objects")) return { prefixes: [], objects: [] };
			return [];
		});
		const select = await outputCredentialSelect();
		expect(screen.queryByRole("dialog")).toBeNull();
		await userEvent.selectOptions(select, "cred-s3");
		expect(await screen.findByRole("dialog")).toBeVisible();
	});

	it("does not open the picker for a destination that is not browsable", async () => {
		const select = await outputCredentialSelect();
		await userEvent.selectOptions(select, "cred-msl");
		await waitFor(() =>
			expect((select as HTMLSelectElement).value).toBe("cred-msl"),
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("stops asking for a bucket once MSL is chosen", async () => {
		// MSL addresses by stream id and event name; the plan's MSL output has no
		// bucket field at all. The box used to render anyway — only the Browse
		// BUTTON beside it was hidden — so the form collected a value the plan
		// had nowhere to put.
		const select = await outputCredentialSelect();
		expect(screen.queryByLabelText(/^bucket$/i)).toBeInTheDocument();
		await userEvent.selectOptions(select, "cred-msl");
		await waitFor(() =>
			expect(screen.queryByLabelText(/^bucket$/i)).not.toBeInTheDocument(),
		);
	});
});

describe("live wizard — MSL delivery format (restored 2026-08-21)", () => {
	/**
	 * The format selector went the same way as the destination selector, and it
	 * should not have. `MslOutputFields` held streamId, eventName AND
	 * streamFormat; the first two are account facts and belong in the vault,
	 * the third is a plan choice — the refactor's own note says exactly that,
	 * and deleted the control anyway.
	 *
	 * The symptom was silent: `buildOutput` falls back to `?? "HLS"`, so every
	 * MSL channel emitted HLS with a ladder nobody had adjusted to match it.
	 * DASH and CMAF were unreachable, and `withMslStreamFormat` — the function
	 * that keeps the ladder honest under C31 — was exported, unit-tested, and
	 * called by nobody. A unit test on an uncalled function is the shape of
	 * "the slot is named but not filled".
	 */
	it("offers a format control once MSL is the destination, and not before", async () => {
		const select = await outputCredentialSelect();
		expect(document.getElementById("lw-msl-format")).toBeNull();
		await userEvent.selectOptions(select, "cred-msl");
		await waitFor(() =>
			expect(document.getElementById("lw-msl-format")).not.toBeNull(),
		);
		const format = document.getElementById("lw-msl-format");
		if (!(format instanceof HTMLSelectElement)) throw new Error("not a select");
		expect([...format.options].map((o) => o.value)).toEqual([
			"HLS",
			"DASH",
			"CMAF",
		]);
		// The owner's directive 2026-08-18: HLS is the default for MSL.
		expect(format.value).toBe("HLS");
	});

	it("moves the ladder with the format instead of failing C31 at save", async () => {
		/**
		 * Choosing DASH over a TS ladder is a save-time C31 error the operator
		 * did not cause, so the container has to follow the format (C1's
		 * auto-switch-and-explain). That is why the control calls
		 * `withMslStreamFormat` rather than patching one field.
		 *
		 * ASSERTS BOTH ENDS, and it has to. The first version only checked
		 * "fMP4 after DASH" — which the default ladder already satisfies, so
		 * patching ONLY the output and skipping the ladder entirely left it
		 * green. The test now drives HLS first to force TS, then reads the
		 * change.
		 */
		const containers = () =>
			[...document.querySelectorAll("select")]
				.filter((s) => [...s.options].some((o) => /^(TS|FMP4)$/.test(o.value)))
				.map((s) => (s as HTMLSelectElement).value);

		const select = await outputCredentialSelect();
		await userEvent.selectOptions(select, "cred-msl");
		await waitFor(() =>
			expect(document.getElementById("lw-msl-format")).not.toBeNull(),
		);
		const format = document.getElementById(
			"lw-msl-format",
		) as HTMLSelectElement;

		// step names: "3. Video and audio encodes" is the
		// ladder, "4. Destinations" the output credential.
		const ladderStep = (
			await screen.findAllByRole("button", {
				name: /^\d+\. Video and audio encodes$/,
			})
		)[0];
		if (!ladderStep) throw new Error("no encodes step");
		const outputStep = (
			await screen.findAllByRole("button", { name: /^\d+\. Destinations$/ })
		)[0];
		if (!outputStep) throw new Error("no destinations step");

		// HLS → TS segments.
		await userEvent.selectOptions(format, "HLS");
		await waitFor(() => expect(format.value).toBe("HLS"));
		await userEvent.click(ladderStep);
		const underHls = containers();
		expect(
			underHls.length,
			"no container selects on the ladder step",
		).toBeGreaterThan(0);
		expect(
			underHls.every((c) => c === "TS"),
			`HLS needs TS segments; saw ${underHls.join(",")}`,
		).toBe(true);

		// DASH → the SAME selects must now read fMP4. Comparing against the
		// HLS reading is what makes this a change rather than a coincidence.
		await userEvent.click(outputStep);
		await userEvent.selectOptions(
			document.getElementById("lw-msl-format") as HTMLSelectElement,
			"DASH",
		);
		await userEvent.click(ladderStep);
		const underDash = containers();
		expect(underDash.length).toBe(underHls.length);
		expect(
			underDash.every((c) => c === "FMP4"),
			`DASH needs fMP4 segments; saw ${underDash.join(",")}`,
		).toBe(true);
		expect(underDash).not.toEqual(underHls);

		/**
		 * And the MANIFEST families, which are the other half of what
		 * `withMslStreamFormat` does. Dropping just this half survived the
		 * container assertions above — an MSL output announcing DASH while the
		 * plan builds only an HLS playlist delivers nothing to Akamai, and the
		 * ladder would have looked perfectly right.
		 */
		const manifestStep = (
			await screen.findAllByRole("button", { name: /manifest/i })
		)[0];
		if (!manifestStep) throw new Error("no manifests step");
		await userEvent.click(manifestStep);
		const hls = document.getElementById("lw-hls-enabled");
		const dash = document.getElementById("lw-dash-enabled");
		if (
			!(hls instanceof HTMLInputElement) ||
			!(dash instanceof HTMLInputElement)
		) {
			throw new Error("manifest toggles not rendered");
		}
		expect(dash.checked, "DASH format with no DASH manifest").toBe(true);
		expect(hls.checked, "DASH format still building an HLS playlist").toBe(
			false,
		);
	});

	it("normalizes the ladder to HLS/TS on MSL credential SELECT, before any dropdown touch", async () => {
		/**
		 * The desync HIGH-7 names: the format dropdown DISPLAYS `?? "HLS"` the
		 * moment MSL is the destination, but the ladder stayed on its fMP4 default
		 * until the operator opened the dropdown and its onChange ran
		 * `withMslStreamFormat`. The shortest normal path — pick the MSL
		 * credential, leave the default HLS, submit — then built a plan whose
		 * DISPLAY said HLS over an fMP4 ladder, a C31 save error the operator
		 * never caused. Selecting the credential must move the ladder itself.
		 */
		const containers = () =>
			[...document.querySelectorAll("select")]
				.filter((s) => [...s.options].some((o) => /^(TS|FMP4)$/.test(o.value)))
				.map((s) => (s as HTMLSelectElement).value);

		const select = await outputCredentialSelect();
		await userEvent.selectOptions(select, "cred-msl");
		// The display defaults to HLS...
		await waitFor(() => {
			const fmt = document.getElementById("lw-msl-format");
			expect(fmt instanceof HTMLSelectElement && fmt.value).toBe("HLS");
		});
		// ...and the ladder must ALREADY agree, with no dropdown touch: HLS ⇒ TS.
		const ladderStep = (
			await screen.findAllByRole("button", {
				name: /^\d+\. Video and audio encodes$/,
			})
		)[0];
		if (!ladderStep) throw new Error("no encodes step");
		await userEvent.click(ladderStep);
		const seen = containers();
		expect(
			seen.length,
			"no container selects on the ladder step",
		).toBeGreaterThan(0);
		expect(
			seen.every((c) => c === "TS"),
			`MSL defaults to HLS, so on select its ladder must be TS without a dropdown touch; saw ${seen.join(",")}`,
		).toBe(true);

		// Control: choosing DASH from the dropdown flips the SAME selects to
		// fMP4 — the select-time normalization is format-aware, not a blanket TS.
		const outputStep = (
			await screen.findAllByRole("button", { name: /^\d+\. Destinations$/ })
		)[0];
		if (!outputStep) throw new Error("no destinations step");
		await userEvent.click(outputStep);
		await userEvent.selectOptions(
			document.getElementById("lw-msl-format") as HTMLSelectElement,
			"DASH",
		);
		await userEvent.click(ladderStep);
		const underDash = containers();
		expect(underDash.length).toBe(seen.length);
		expect(
			underDash.every((c) => c === "FMP4"),
			`DASH needs fMP4 segments; saw ${underDash.join(",")}`,
		).toBe(true);
	});
});

/**
 *  — the two steps talking to each other, mounted.
 *
 * `schedule-section.test.tsx` proves the RULE and the message; only this
 * proves the WIRING, which is a different claim: the auto-shutdown lives on
 * the Start step and the slot on the Schedule step, and nothing but the
 * wizard connects them. Drop the `autoShutdown` prop at the call site and the
 * rule tests all stay green.
 */
describe("live wizard — the Start step's auto-shutdown reaches the Schedule step", () => {
	async function fillShutdownThenSlot(streamTimeoutMinutes: string) {
		renderWithQuery(<LiveWizard />);
		// The step buttons are numbered ("6. Automatic restart and stop",
		// "7. Schedule actions" — the step names changed), so anchor on
		// the number-and-name shape rather than the bare word.
		const startStep = (
			await screen.findAllByRole("button", {
				name: /^\d+\. Automatic restart and stop$/,
			})
		)[0];
		if (!startStep)
			throw new Error("no Automatic restart and stop step button");
		await userEvent.click(startStep);
		const timeout = document.getElementById("lw-as-stream");
		if (!(timeout instanceof HTMLInputElement)) {
			throw new Error("streamTimeoutMinutes input not rendered");
		}
		await userEvent.type(timeout, streamTimeoutMinutes);

		const scheduleStep = (
			await screen.findAllByRole("button", {
				name: /^\d+\. Schedule actions$/,
			})
		)[0];
		if (!scheduleStep) throw new Error("no Schedule actions step button");
		await userEvent.click(scheduleStep);
		await userEvent.click(
			await screen.findByRole("checkbox", {
				name: /planned input feed, program and stop times/i,
			}),
		);
		for (const [id, value] of [
			["sch-up", "2026-09-01T20:45"],
			["sch-start", "2026-09-01T21:00"],
			["sch-end", "2026-09-01T22:00"],
		] as const) {
			const field = document.getElementById(id);
			if (!(field instanceof HTMLInputElement)) {
				throw new Error(`${id} not rendered`);
			}
			await userEvent.type(field, value);
		}
	}

	/**
	 * Scoped by TEXT, not by `getByRole("alert")`: the half-built plan's own
	 * preview renders an alert too ("name: Required"), so a bare role query
	 * would pass on the wrong element in the positive arm and fail in the
	 * negative one for a reason that has nothing to do with this rule.
	 */
	// the sentence names the value and the consequence,
	// not the raw property, so the scope is its own wording.
	const shutdownAlerts = () =>
		screen
			.queryAllByRole("alert")
			.filter((el) => (el.textContent ?? "").includes("of total run time"));

	it("a 6-minute runtime against a 75-minute slot is called out on the schedule step", async () => {
		await fillShutdownThenSlot("6");
		await waitFor(() => expect(shutdownAlerts()).toHaveLength(1));
		expect(shutdownAlerts()[0]?.textContent).toContain(
			"6 minutes of total run time",
		);
		expect(shutdownAlerts()[0]?.textContent).toContain("75-minute slot");
	});

	it("a runtime that covers the slot says nothing", async () => {
		await fillShutdownThenSlot("600");
		expect(shutdownAlerts()).toHaveLength(0);
	});
});

it("lets the output credential be cleared without retaining a hidden destination", async () => {
	const select = await outputCredentialSelect();
	await userEvent.selectOptions(select, "cred-msl");
	await userEvent.selectOptions(select, "");
	expect(select).toHaveValue("");
});

it.each([
	"credentials",
	"bitmovin-accounts",
])("exposes a retry when %s cannot load", async (resource) => {
	let failed = true;
	apiFetch.mockImplementation(async (url: string) => {
		if (url === `/api/${resource}` && failed) throw new Error("offline");
		if (url === "/api/credentials") return CREDENTIALS;
		return [];
	});
	renderWithQuery(<LiveWizard />);
	const retry = await screen.findByRole(
		"button",
		{ name: "Retry" },
		{ timeout: 1000 },
	);
	expect(screen.getByText(/Could not load/)).toHaveAttribute("role", "alert");
	failed = false;
	await userEvent.click(retry);
	await waitFor(() =>
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull(),
	);
});

it("retries a failed duplicate read and restores the original plan", async () => {
	const id = "33333333-3333-4333-8333-333333333333";
	const plan = buildLiveChannelPlan({
		...DEFAULT_LIVE_WIZARD_STATE,
		name: "retry-source",
		accountId: id,
		output: {
			...DEFAULT_LIVE_WIZARD_STATE.output,
			credentialId: "44444444-4444-4444-8444-444444444444",
			bucket: "media",
			basePath: "live",
		},
	});
	let failed = true;
	apiFetch.mockImplementation(async (url: string) => {
		if (url === `/api/live-channels/${id}`) {
			if (failed) throw new Error("offline");
			return { name: "retry-source", plan };
		}
		return [];
	});
	renderWithQuery(<LiveWizard duplicateFrom={id} />);
	await screen.findByRole("alert");
	failed = false;
	await userEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(await screen.findByLabelText("Channel name")).toHaveValue(
		"retry-source",
	);
});

it("keeps an unavailable account and output credential visible after duplication", async () => {
	const accountId = "33333333-3333-4333-8333-333333333333";
	const credentialId = "44444444-4444-4444-8444-444444444444";
	const plan = buildLiveChannelPlan({
		...DEFAULT_LIVE_WIZARD_STATE,
		name: "missing resources",
		accountId,
		output: {
			...DEFAULT_LIVE_WIZARD_STATE.output,
			credentialId,
			bucket: "media",
			basePath: "live",
		},
	});
	apiFetch.mockImplementation(async (url: string) =>
		url.startsWith("/api/live-channels/") ? { plan } : [],
	);
	renderWithQuery(<LiveWizard duplicateFrom={accountId} />);
	expect(await screen.findByLabelText("Bitmovin account")).toHaveValue(
		accountId,
	);
	expect(
		screen.getByRole("option", { name: `${accountId} (missing)` }),
	).toBeInTheDocument();
	await userEvent.click(
		screen.getByRole("button", { name: /^4\. Destinations$/ }),
	);
	expect(document.getElementById("lw-out-cred")).toHaveValue(credentialId);
	expect(
		screen.getByRole("option", { name: `${credentialId} (missing)` }),
	).toBeInTheDocument();
});
