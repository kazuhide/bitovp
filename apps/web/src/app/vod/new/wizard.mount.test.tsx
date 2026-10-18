import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

/**
 * : no test in the repo rendered VodWizard at all (review-178 I1
 * measured it), so every conditionally-rendered slot — portal children,
 * effect-gated panels — was invisible to the suite; "portal children mount
 * after parent effects" is the defect class a mount catches. This is the
 * first mount: the wizard renders with its real providers, its first step's
 * fields are live (typing reaches state and re-renders), the stepper
 * navigates, and the preview rail is present.
 *
 * The Review regression also builds a schema-valid plan through the real
 * manual storage controls. Only HTTP data is stubbed; placeholder collection,
 * conditional slot rendering, and the submission gate are real.
 */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: routerPush, replace: vi.fn() }),
}));

import { ApiError } from "@/lib/api";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { VodWizard } from "./wizard";

beforeEach(() => {
	vi.clearAllMocks();
	// Every wizard query resolves empty — a mount must not depend on data.
	apiFetch.mockResolvedValue([]);
});

describe("VodWizard — the first mount (ledger #91)", () => {
	it.each([
		"ja",
		"en",
	] as const)("omits deployment-profile labeling in %s", async (locale) => {
		renderWithQuery(<VodWizard />, locale);
		expect(
			screen.queryByText(/Akamai-only deployment|Akamai 専用環境/),
		).toBeNull();
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith("/api/credentials"),
		);
	});
	it("keeps a valid AWS import available across rerenders", async () => {
		const raw = buildPlan({
			...DEFAULT_WIZARD_STATE,
			name: "profile-import",
			accountId: "33333333-3333-4333-8333-333333333333",
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: "44444444-4444-4444-8444-444444444444",
					bucket: "synthetic",
					path: "input.mp4",
				},
			],
			output: {
				...DEFAULT_WIZARD_STATE.output,
				kind: "S3",
				credentialId: "44444444-4444-4444-8444-444444444444",
				bucket: "synthetic",
				basePath: "output",
			},
		});
		const rendered = renderWithQuery(<VodWizard />);
		await userEvent.click(
			screen.getByRole("button", { name: /Import plan JSON/ }),
		);
		fireEvent.change(
			screen.getByRole("textbox", { name: /Import plan JSON/ }),
			{ target: { value: JSON.stringify(raw) } },
		);
		await userEvent.click(
			screen.getByRole("button", { name: /Validate.*load/i }),
		);
		expect(screen.getByRole("textbox", { name: /job name/i })).toHaveValue(
			"profile-import",
		);
		await userEvent.click(screen.getByRole("button", { name: /^8\. Review$/ }));
		const submit = screen.getByRole("button", { name: /^Start encoding$/i });
		expect(submit).toBeEnabled();
		rendered.rerender(<VodWizard />);
		expect(submit).toBeEnabled();
		expect(screen.queryByText(/PROFILE_AKAMAI_ONLY/)).toBeNull();
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(false);
	});
	it("mounts with real providers: step-0 fields, stepper, preview rail", async () => {
		renderWithQuery(<VodWizard />);

		// Step 0 (basics): the job-name field is a real, labelled input.
		const name = screen.getByLabelText(/job name/i);
		expect(name).toBeInTheDocument();

		// Typing reaches state and survives the re-render.
		await userEvent.type(name, "mount-probe");
		expect((name as HTMLInputElement).value).toBe("mount-probe");

		// The stepper renders every step.
		for (const label of [
			/basics/i,
			/sources/i,
			/ladder/i,
			/output/i,
			/packaging/i,
			/encoding/i,
			/manifests/i,
			/review/i,
		]) {
			expect(
				screen.getAllByRole("button", { name: label }).length,
			).toBeGreaterThan(0);
		}

		// The preview rail is mounted beside the form (its three tabs).
		expect(
			screen.getByRole("button", { name: "Template YAML" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Plan JSON" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Operations" }),
		).toBeInTheDocument();
	});

	it("navigates: the output step's base-path field accepts a placeholder path", async () => {
		renderWithQuery(<VodWizard />);
		// Jump via the stepper to Output (step 3).
		const [outputTab] = screen.getAllByRole("button", { name: /output/i });
		if (!outputTab) {
			throw new Error("stepper did not render an Output step");
		}
		await userEvent.click(outputTab);
		const base = screen.getByLabelText(/output folder/i, {
			selector: "input",
		});
		await userEvent.type(base, "videos/{{uuid}}/");
		expect((base as HTMLInputElement).value).toContain("{uuid}");
	});

	it("the delivery-mirrors note rides its ? (review-uibatch #9)", async () => {
		renderWithQuery(<VodWizard />);
		const [outputTab] = screen.getAllByRole("button", { name: /output/i });
		if (!outputTab) {
			throw new Error("stepper did not render an Output step");
		}
		await userEvent.click(outputTab);
		expect(
			screen.queryByText(/one encode, several storages/i),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", {
				name: /Delivery mirrors — more information/i,
			}),
		);
		expect(
			await screen.findByText(/one encode, several storages/i),
		).toBeInTheDocument();
	});

	it("renders Review placeholder tokens and paths after manual storage entry, then clears the gate when replaced", async () => {
		const user = userEvent.setup();
		const accountId = "33333333-3333-4333-8333-333333333333";
		const credentialId = "44444444-4444-4444-8444-444444444444";
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/bitmovin-accounts") {
				return [{ id: accountId, label: "Test account" }];
			}
			if (url === "/api/credentials") {
				return [{ id: credentialId, label: "Test S3", provider: "AWS_S3" }];
			}
			if (url.endsWith("/storage/buckets")) return { buckets: [] };
			return [];
		});
		renderWithQuery(<VodWizard />);
		const goTo = async (name: RegExp) => {
			await user.click(
				within(
					screen.getByRole("navigation", { name: /wizard steps/i }),
				).getByRole("button", { name }),
			);
		};
		const closePicker = async () => {
			await user.click(
				within(await screen.findByRole("dialog")).getByRole("button", {
					name: "Close",
				}),
			);
		};
		await user.type(screen.getByLabelText(/job name/i), "placeholder-review");
		await screen.findByRole("option", { name: "Test account" });
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Bitmovin account" }),
			accountId,
		);
		await goTo(/sources/i);
		await user.selectOptions(
			screen.getByRole("combobox", { name: /^credential/i }),
			credentialId,
		);
		await closePicker();
		await user.type(screen.getByLabelText(/^bucket/i), "source-bucket");
		await user.type(
			screen.getByLabelText(/^object path/i, { selector: "input" }),
			"<INSERT_SOURCE>.mp4",
		);
		await goTo(/output/i);
		await user.selectOptions(
			screen.getByRole("combobox", { name: /^credential/i }),
			credentialId,
		);
		await closePicker();
		await user.type(screen.getByLabelText(/^bucket/i), "output-bucket");
		await user.click(screen.getByRole("button", { name: "Show summary" }));
		await user.click(screen.getByRole("button", { name: "Enter manually" }));
		const folder = screen.getByLabelText(/output folder/i, {
			selector: "input",
		});
		await user.clear(folder);
		await user.type(folder, "<INSERT_OUTPUT>");
		await goTo(/review/i);
		const warning = screen.getByRole("alert");
		expect(warning).toHaveTextContent("2 sample placeholder path(s)");
		expect(
			within(warning)
				.getAllByRole("term")
				.map((term) => term.textContent),
		).toEqual(["<INSERT_SOURCE>", "<INSERT_OUTPUT>"]);
		expect(
			within(warning)
				.getAllByRole("definition")
				.map((path) => path.textContent),
		).toEqual([
			"ingest[0].inputPath, ingest[1].inputPath",
			"muxings[0].destination.path, muxings[1].destination.path, manifests[0].destination.path",
		]);
		expect(
			screen.getByRole("button", { name: "Start encoding" }),
		).toBeDisabled();

		await goTo(/sources/i);
		await user.click(screen.getByRole("button", { name: "Enter manually" }));
		const source = screen.getByLabelText(/^object path/i, {
			selector: "input",
		});
		await user.clear(source);
		await user.type(source, "source.mp4");
		await goTo(/output/i);
		await user.click(screen.getByRole("button", { name: "Enter manually" }));
		const destination = screen.getByLabelText(/output folder/i, {
			selector: "input",
		});
		await user.clear(destination);
		await user.type(destination, "encoded");
		await goTo(/review/i);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Start encoding" }),
		).toBeEnabled();
		expect(
			apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(false);
	});
});

describe("VodWizard — template edit mode (ledger #109 §5)", () => {
	it("loads the template, shows the banner, and PATCHes with the loaded updatedAt as the CAS token", async () => {
		const { samplePresetPlan } = await import("@bitovp/core/presets");
		const raw = samplePresetPlan("fixed-bitrate-hls-on-aws") as {
			bitmovin: Record<string, unknown>;
		};
		// A SAVED template always carries its account and REAL credential ids
		// (POST refuses an invalid plan); the sample fixture ships placeholder
		// credential names — substitute UUIDs, as a real template row would
		// have. (First probe of this test found both gaps one at a time:
		// accountId, then inputs.0.credentialId, each failing the schema parse
		// and silently disabling the primary action.)
		const uuidify = (node: unknown): unknown => {
			if (Array.isArray(node)) {
				return node.map(uuidify);
			}
			if (node && typeof node === "object") {
				const out: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(node)) {
					out[k] =
						k === "credentialId" && typeof v === "string"
							? "44444444-4444-4444-8444-444444444444"
							: uuidify(v);
				}
				return out;
			}
			return node;
		};
		const body = uuidify({
			...raw,
			bitmovin: {
				...raw.bitmovin,
				accountId: "33333333-3333-4333-8333-333333333333",
			},
		});
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === "/api/presets/tpl-1" && !init) {
				return {
					name: "hardened-hls",
					body,
					updatedAt: "2026-08-15T00:00:00.000Z",
				};
			}
			if (url === "/api/presets/tpl-1" && init?.method === "PATCH") {
				return { id: "tpl-1" };
			}
			return [];
		});
		renderWithQuery(<VodWizard editPresetId="tpl-1" />);

		// The banner names the template being edited.
		expect(
			await screen.findByText(/Editing template .hardened-hls./i),
		).toBeInTheDocument();

		// The primary action lives on the Review step (the same slot job
		// submission occupies outside edit mode) — navigate via the STEPPER's
		// own nav (a bare /review/i also matches preview-rail buttons).
		const stepsNav = screen.getByRole("navigation", {
			name: /wizard steps/i,
		});
		await userEvent.click(
			within(stepsNav).getByRole("button", { name: /review/i }),
		);
		const update = await screen.findByRole("button", {
			name: /Update template/i,
		});
		await userEvent.click(update);

		const findPatch = () =>
			apiFetch.mock.calls.find(
				([url, init]) =>
					url === "/api/presets/tpl-1" &&
					(init as RequestInit | undefined)?.method === "PATCH",
			);
		await waitFor(() => {
			if (!findPatch()) {
				throw new Error("PATCH never fired");
			}
		});
		const patch = findPatch();
		if (!patch) {
			throw new Error("PATCH never fired");
		}
		const payload = JSON.parse((patch[1] as RequestInit).body as string) as {
			plan?: unknown;
			expectedUpdatedAt?: string;
		};
		// CAS token = the row's updatedAt AS LOADED — a stale one is how the
		// server detects the lost race (409).
		expect(payload.expectedUpdatedAt).toBe("2026-08-15T00:00:00.000Z");
		expect(payload.plan).toBeDefined();
		// No job was submitted.
		expect(
			apiFetch.mock.calls.find(([url]) => url === "/api/encoding-jobs"),
		).toBeUndefined();
	});
});

describe("VodWizard — requested preset must load before editing", () => {
	const cases = [
		{
			props: { presetName: "requested" },
			url: "/api/sample-presets/requested",
			response: (plan: unknown) => plan,
		},
		{
			props: { userPresetId: "requested" },
			url: "/api/presets/requested",
			response: (plan: unknown) => ({
				name: "requested",
				body: plan,
				updatedAt: "2026-09-07T00:00:00Z",
			}),
		},
		{
			props: { editPresetId: "requested" },
			url: "/api/presets/requested",
			response: (plan: unknown) => ({
				name: "requested",
				body: plan,
				updatedAt: "2026-09-07T00:00:00Z",
			}),
		},
		{
			props: { deliveryPresetId: "requested" },
			url: "/api/delivery-presets/requested",
			response: (plan: unknown) => ({
				spec: { name: "requested", plan, constraints: [] },
			}),
		},
	];
	for (const entry of cases) {
		it(`${Object.keys(entry.props)[0]} prevents edits being overwritten by a delayed response`, async () => {
			const { samplePresetPlan } = await import("@bitovp/core/presets");
			let finish = (_value: unknown) => {};
			const pending = new Promise((resolve) => {
				finish = resolve;
			});
			apiFetch.mockImplementation((url: string) =>
				url === entry.url ? pending : Promise.resolve([]),
			);
			renderWithQuery(<VodWizard {...entry.props} />);
			expect(screen.getByRole("status")).toHaveTextContent("Loading preset");
			expect(screen.queryByLabelText(/job name/i)).toBeNull();
			expect(
				screen.queryByRole("navigation", { name: /wizard steps/i }),
			).toBeNull();
			finish(
				entry.response({
					...samplePresetPlan("fixed-bitrate-hls-on-aws"),
					name: "loaded-plan",
				}),
			);
			expect(await screen.findByLabelText(/job name/i)).toHaveValue(
				"loaded-plan",
			);
		});

		it(`${Object.keys(entry.props)[0]} explains failed loading and retries the selected preset`, async () => {
			const { samplePresetPlan } = await import("@bitovp/core/presets");
			let failed = true;
			apiFetch.mockImplementation((url: string) =>
				url === entry.url
					? failed
						? Promise.reject(new Error("preset unavailable"))
						: Promise.resolve(
								entry.response({
									...samplePresetPlan("fixed-bitrate-hls-on-aws"),
									name: "recovered-plan",
								}),
							)
					: Promise.resolve([]),
			);
			renderWithQuery(<VodWizard {...entry.props} />);
			expect(await screen.findByRole("alert")).toHaveTextContent(
				/Could not load preset.*requested/,
			);
			expect(screen.queryByLabelText(/job name/i)).toBeNull();
			failed = false;
			await userEvent.click(screen.getByRole("button", { name: "Retry" }));
			expect(await screen.findByLabelText(/job name/i)).toHaveValue(
				"recovered-plan",
			);
			expect(
				apiFetch.mock.calls.some(
					([, init]) => (init as RequestInit | undefined)?.method === "POST",
				),
			).toBe(false);
		});
	}
});

describe("VodWizard — cached template revision stays bound to its body", () => {
	const oldRevision = "2026-09-07T00:00:00.000Z";
	const newRevision = "2026-09-07T00:01:00.000Z";
	async function template(name: string, updatedAt: string) {
		const { samplePresetPlan } = await import("@bitovp/core/presets");
		const body = JSON.parse(
			JSON.stringify(samplePresetPlan("fixed-bitrate-hls-on-aws")),
			(key, value) =>
				key === "credentialId" ? "44444444-4444-4444-8444-444444444444" : value,
		);
		body.name = name;
		body.bitmovin.accountId = "33333333-3333-4333-8333-333333333333";
		return { name, body, updatedAt };
	}
	async function saveTemplate() {
		await userEvent.click(
			within(
				screen.getByRole("navigation", { name: /wizard steps/i }),
			).getByRole("button", { name: /review/i }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: /Update template/i }),
		);
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.some(([, init]) => init?.method === "PATCH"),
			).toBe(true),
		);
		const call = apiFetch.mock.calls.find(
			([, init]) => init?.method === "PATCH",
		);
		return JSON.parse(call?.[1].body as string);
	}

	it("waits for a deferred warm-cache refresh and PATCHes the refreshed body with its own token", async () => {
		const cached = await template("cached-A", oldRevision);
		const current = await template("current-B", newRevision);
		let finish = (_value: unknown) => {};
		const pending = new Promise((resolve) => {
			finish = resolve;
		});
		apiFetch.mockImplementation((url: string, init?: RequestInit) => {
			if (url === "/api/presets/tpl-cache")
				return init?.method === "PATCH"
					? Promise.resolve({ id: "tpl-cache" })
					: pending;
			return Promise.resolve([]);
		});
		const view = renderWithQuery(null);
		view.client.setQueryData(["user-preset", "tpl-cache"], cached);
		view.rerender(<VodWizard editPresetId="tpl-cache" />);
		expect(screen.queryByLabelText(/job name/i)).toBeNull();
		expect(screen.getByRole("status")).toHaveTextContent("Loading preset");
		await act(async () => {
			finish(current);
			await pending;
		});
		expect(await screen.findByLabelText(/job name/i)).toHaveValue("current-B");
		const payload = await saveTemplate();
		expect(payload.expectedUpdatedAt).toBe(newRevision);
		expect(payload.plan.name).toBe("current-B");
	});

	it("keeps the applied token when another reader refreshes cache, preserving edits and reporting a conflict", async () => {
		const cached = await template("cached-A", oldRevision);
		const current = await template("current-B", newRevision);
		let readRow = cached;
		let storedRow = cached;
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === "/api/presets/tpl-cache") {
				if (init?.method === "PATCH") {
					const payload = JSON.parse(init.body as string);
					if (payload.expectedUpdatedAt !== storedRow.updatedAt)
						throw new ApiError(409, "Preset was modified since you loaded it");
					storedRow = { ...storedRow, body: payload.plan };
					return { id: "tpl-cache" };
				}
				return readRow;
			}
			return [];
		});
		const view = renderWithQuery(null);
		view.client.setQueryData(["user-preset", "tpl-cache"], cached);
		view.rerender(<VodWizard editPresetId="tpl-cache" />);
		const name = await screen.findByLabelText(/job name/i);
		await userEvent.clear(name);
		await userEvent.type(name, "my-edit");
		readRow = current;
		storedRow = current;
		await act(() =>
			view.client.fetchQuery({
				queryKey: ["user-preset", "tpl-cache"],
				queryFn: () => apiFetch("/api/presets/tpl-cache"),
			}),
		);
		expect(name).toHaveValue("my-edit");
		const payload = await saveTemplate();
		expect(payload.expectedUpdatedAt).toBe(oldRevision);
		expect(payload.plan.name).toBe("my-edit");
		expect(await screen.findByText(/modified.*reload/i)).toHaveAttribute(
			"role",
			"alert",
		);
		expect(storedRow).toEqual(current);
		expect(routerPush).not.toHaveBeenCalled();
	});
});

describe("wizard reference-data recovery", () => {
	it.each([
		["/api/bitmovin-accounts", "Could not load Bitmovin accounts"],
		["/api/credentials", "Could not load credentials"],
	])("recovers %s without discarding edited fields", async (endpoint, message) => {
		let failed = true;
		apiFetch.mockImplementation((url: string) =>
			url === endpoint && failed
				? Promise.reject(new Error("offline"))
				: Promise.resolve([]),
		);
		renderWithQuery(<VodWizard />);
		await userEvent.type(screen.getByLabelText(/job name/i), "keep-my-work");
		expect(
			(await screen.findByText(new RegExp(message))).closest('[role="alert"]'),
		).not.toBeNull();
		failed = false;
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(screen.queryByText(new RegExp(message))).toBeNull(),
		);
		expect(screen.getByLabelText(/job name/i)).toHaveValue("keep-my-work");
	});
	it("lets a raw imported plan resolve placeholder paths without reimporting", async () => {
		const raw = buildPlan({
			...DEFAULT_WIZARD_STATE,
			name: "placeholder-import",
			accountId: "33333333-3333-4333-8333-333333333333",
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: "44444444-4444-4444-8444-444444444444",
					bucket: "synthetic",
					path: "<INSERT_INPUT_PATH>",
				},
			],
			output: {
				...DEFAULT_WIZARD_STATE.output,
				credentialId: "44444444-4444-4444-8444-444444444444",
				bucket: "synthetic",
				basePath: "output",
			},
		});
		// A valid destination-key layout the wizard cannot reproduce stays in
		// the raw JSON editor, including its placeholder-resolution checklist.
		if (!raw.outputs[0]) throw new Error("Expected the origin output");
		raw.outputs[0].key = "custom-origin";
		for (const entry of [...(raw.manifests ?? []), ...raw.muxings]) {
			if (entry.destination) entry.destination.outputKey = "custom-origin";
		}
		renderWithQuery(<VodWizard />);
		await userEvent.click(
			screen.getByRole("button", { name: /Import plan JSON/ }),
		);
		fireEvent.change(
			screen.getByRole("textbox", { name: /Import plan JSON/ }),
			{ target: { value: JSON.stringify(raw) } },
		);
		await userEvent.click(
			screen.getByRole("button", { name: /Validate.*load/i }),
		);
		expect(
			screen.getByRole("region", { name: /Preset checklist/i }),
		).toBeInTheDocument();
	});
});
