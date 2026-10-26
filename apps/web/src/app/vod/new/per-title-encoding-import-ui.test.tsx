import type { PerTitleGoal } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "@/lib/api";
import { renderLocalized } from "@/test/render";
import type { PerTitleEncodingImportedConfiguration } from "./per-title-encoding-import";
import { PerTitleEncodingImportResult } from "./per-title-encoding-import-result";
import { PerTitleSimulator } from "./per-title-simulator";

vi.mock("@/lib/api", async (original) => ({
	...(await original<typeof import("@/lib/api")>()),
	apiFetch: vi.fn(),
}));

const encodingId = "11111111-1111-4111-8111-111111111111";
const anotherId = "22222222-2222-4222-8222-222222222222";
const endpoint = "/api/per-title-simulator/encodings/import";
const initialGoal: PerTitleGoal = {
	strategy: "automatic",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 4_000_000,
	countPolicy: { kind: "unrestricted" },
	autoRepresentations: {},
};

function configuration(
	codec: "H264" | "H265" | "VP9" | "AV1",
	maximum = 2_000_000,
): PerTitleEncodingImportedConfiguration {
	return {
		codec,
		goal: {
			...initialGoal,
			codec,
			maxBitrate: maximum,
			targetQualityCrf: 17,
			autoRepresentations: false,
			automaticTemplates: [{ id: `${codec}-template`, height: 720 }],
		},
		reference: {
			codec,
			global: {
				minBitrate: 100_000,
				maxBitrate: maximum,
				targetQualityCrf: 17,
			},
			streams: [
				{
					id: `${codec}-template`,
					codec,
					mode: "PER_TITLE_TEMPLATE",
					height: 720,
				},
			],
		},
	};
}

const result = () => ({
	configurations: [
		configuration("H264"),
		configuration("H265", 3_000_000),
		configuration("VP9", 3_500_000),
	],
	issues: [],
});

const copy = {
	en: {
		open: "Load from Encoding ID",
		id: "Encoding ID",
		account: "Bitmovin account",
		temporary: "Use a temporary API key",
		fetch: "Fetch settings",
		load: "Load selected settings",
		cancel: "Cancel",
	},
	ja: {
		open: "Encoding IDから読み込む",
		id: "Encoding ID",
		account: "Bitmovinアカウント",
		temporary: "一時APIキーを使う",
		fetch: "設定を取得",
		load: "選択した設定を読み込む",
		cancel: "キャンセル",
	},
};

function show(locale: "en" | "ja" = "en") {
	const props = {
		initialGoal,
		open: true,
		onOpenChange: vi.fn(),
		onApply: vi.fn(),
	};
	return {
		...renderLocalized(<PerTitleSimulator {...props} />, locale),
		props,
	};
}

async function open(locale: "en" | "ja" = "en") {
	fireEvent.click(screen.getByRole("button", { name: copy[locale].open }));
	await screen.findByRole("combobox", { name: copy[locale].account });
	await waitFor(() =>
		expect(screen.getByRole("option", { name: "Saved account" })).toBeVisible(),
	);
	fireEvent.change(screen.getByLabelText(copy[locale].id), {
		target: { value: encodingId },
	});
	fireEvent.change(
		screen.getByRole("combobox", { name: copy[locale].account }),
		{ target: { value: "saved-account" } },
	);
}

beforeEach(() => {
	vi.mocked(apiFetch).mockReset();
	vi.mocked(apiFetch).mockImplementation(async (path) => {
		if (path === "/api/bitmovin-accounts")
			return [{ id: "saved-account", label: "Saved account" }];
		if (path === endpoint) return result();
		throw new Error("Unexpected API request");
	});
});

describe("Encoding ID import in the simulator", () => {
	it("identifies only omitted step values as simulator initial values and retains the original references", () => {
		const neither = configuration("H264");
		const minimumOnly = configuration("H265");
		minimumOnly.reference.global.minBitrateStepSize = 1.7;
		const maximumOnly = configuration("VP9");
		maximumOnly.reference.global.maxBitrateStepSize = 3;
		const both = configuration("AV1");
		both.reference.global.minBitrateStepSize = 1.5;
		both.reference.global.maxBitrateStepSize = 3;
		const data = {
			configurations: [neither, minimumOnly, maximumOnly, both],
			issues: [],
		};
		const original = structuredClone(data);
		const onComplete = vi.fn();
		renderLocalized(
			<PerTitleEncodingImportResult
				result={data}
				onCancel={vi.fn()}
				onComplete={onComplete}
			/>,
		);
		const row = (codec: string) =>
			screen
				.getByRole("checkbox", { name: new RegExp(codec) })
				.closest("label");
		expect(row("H264")).toHaveTextContent(
			/simulator initial values.*minBitrateStepSize: 1\.5.*maxBitrateStepSize: 1\.9/i,
		);
		expect(row("H264")).toHaveTextContent(
			/does not identify the API defaults or the source job's effective values/i,
		);
		expect(row("H265")).toHaveTextContent(/maxBitrateStepSize: 1\.9/);
		expect(row("H265")).not.toHaveTextContent(/minBitrateStepSize/);
		expect(row("VP9")).toHaveTextContent(/minBitrateStepSize: 1\.5/);
		expect(row("VP9")).not.toHaveTextContent(/maxBitrateStepSize/);
		expect(row("AV1")).not.toHaveTextContent(
			/minBitrateStepSize|maxBitrateStepSize/,
		);
		fireEvent.click(screen.getByRole("button", { name: copy.en.load }));
		expect(onComplete).toHaveBeenCalledWith(original.configurations);
		expect(data).toEqual(original);
		expect(neither.reference.global).not.toHaveProperty("minBitrateStepSize");
		expect(neither.reference.global).not.toHaveProperty("maxBitrateStepSize");
	});

	it.each([
		"en",
		"ja",
	] as const)("offers adjacent setup and import actions without loading test presets (%s)", (locale) => {
		show(locale);
		const setup = screen.getByRole("button", {
			name: locale === "ja" ? "新規設定ウィザード" : "New setup wizard",
		});
		const load = screen.getByRole("button", { name: copy[locale].open });
		expect(load.parentElement).toBe(setup.parentElement);
		expect(apiFetch).not.toHaveBeenCalled();
		expect(screen.queryByText(/Test presets|テスト用プリセット/)).toBeNull();
	});

	it("requests a saved account only on fetch and stages all selected codecs before applying", async () => {
		const { props } = show();
		await open();
		expect(apiFetch).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: copy.en.fetch }));
		expect(await screen.findByRole("checkbox", { name: /H265/ })).toBeChecked();
		expect(apiFetch).toHaveBeenLastCalledWith(
			endpoint,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					encodingId,
					bitmovinAccountId: "saved-account",
				}),
				cache: "no-store",
				signal: expect.any(AbortSignal),
			}),
		);
		expect(props.onApply).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("checkbox", { name: /VP9/ }));
		fireEvent.click(screen.getByRole("button", { name: copy.en.load }));
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(2000);
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "H265" },
		});
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(3000);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{
				target: { value: "2800" },
			},
		);
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "H264" },
		});
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(2000);
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "H265" },
		});
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(2800);
		expect(props.onApply).not.toHaveBeenCalled();
	});

	it("uses a temporary key in the POST body and forgets it when canceled", async () => {
		show("ja");
		await open("ja");
		fireEvent.click(screen.getByLabelText(copy.ja.temporary));
		const key = screen.getByLabelText("APIキー");
		expect(key).toHaveAttribute("type", "password");
		expect(key).toHaveAttribute("autocomplete", "one-time-code");
		fireEvent.change(key, { target: { value: "temporary-test-only-api-key" } });
		fireEvent.change(screen.getByLabelText("Tenant Organization ID（任意）"), {
			target: { value: anotherId },
		});
		fireEvent.click(screen.getByRole("button", { name: copy.ja.fetch }));
		await screen.findByRole("checkbox", { name: /H264/ });
		expect(apiFetch).toHaveBeenLastCalledWith(
			endpoint,
			expect.objectContaining({
				body: JSON.stringify({
					encodingId,
					apiKey: "temporary-test-only-api-key",
					tenantOrgId: anotherId,
				}),
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: copy.ja.cancel }));
		expect(screen.getByRole("button", { name: copy.ja.open })).toHaveFocus();
		fireEvent.click(screen.getByRole("button", { name: copy.ja.open }));
		fireEvent.click(screen.getByLabelText(copy.ja.temporary));
		expect(screen.getByLabelText("APIキー")).toHaveValue("");
	});

	it("cancels a request and ignores its late response while preserving editor state", async () => {
		let finish!: (value: unknown) => void;
		vi.mocked(apiFetch).mockImplementation(async (path) =>
			path === endpoint
				? new Promise((resolve) => {
						finish = resolve;
					})
				: [{ id: "saved-account", label: "Saved account" }],
		);
		show();
		await open();
		fireEvent.click(screen.getByRole("button", { name: copy.en.fetch }));
		const signal = vi.mocked(apiFetch).mock.calls.at(-1)?.[1]?.signal;
		expect(screen.getByRole("button", { name: /Fetching/ })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: copy.en.cancel }));
		expect(signal?.aborted).toBe(true);
		await act(async () => finish(result()));
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(4000);
		expect(screen.getByRole("button", { name: copy.en.open })).toHaveFocus();
	});

	it("invalidates a pending response when request inputs change", async () => {
		let finish!: (value: unknown) => void;
		vi.mocked(apiFetch).mockImplementation(async (path) =>
			path === endpoint
				? new Promise((resolve) => {
						finish = resolve;
					})
				: [{ id: "saved-account", label: "Saved account" }],
		);
		show();
		await open();
		fireEvent.click(screen.getByRole("button", { name: copy.en.fetch }));
		const signal = vi.mocked(apiFetch).mock.calls.at(-1)?.[1]?.signal;
		fireEvent.change(screen.getByLabelText(copy.en.id), {
			target: { value: anotherId },
		});
		await act(async () => finish(result()));
		expect(signal?.aborted).toBe(true);
		expect(screen.queryByRole("checkbox", { name: /H264/ })).toBeNull();
	});

	it("invalidates a pending response when the external editing context changes", async () => {
		let finish!: (value: unknown) => void;
		vi.mocked(apiFetch).mockImplementation(async (path) =>
			path === endpoint
				? new Promise((resolve) => {
						finish = resolve;
					})
				: [{ id: "saved-account", label: "Saved account" }],
		);
		const view = show();
		await open();
		fireEvent.click(screen.getByRole("button", { name: copy.en.fetch }));
		view.rerender(
			<PerTitleSimulator
				{...view.props}
				initialGoal={{ ...initialGoal, maxBitrate: 6_000_000 }}
			/>,
		);
		await act(async () => finish(result()));
		expect(screen.queryByRole("checkbox", { name: /H264/ })).toBeNull();
		expect(screen.getByRole("alert")).toHaveTextContent(/changed/i);
	});

	it.each([
		403, 503,
	])("shows a safe failure for status %s without changing the draft", async (status) => {
		vi.mocked(apiFetch).mockImplementation(async (path) => {
			if (path === endpoint)
				throw new ApiError(status, "sensitive provider details");
			return [{ id: "saved-account", label: "Saved account" }];
		});
		const { props } = show();
		await open();
		fireEvent.click(screen.getByRole("button", { name: copy.en.fetch }));
		const alert = await screen.findByRole("alert");
		expect(alert).not.toHaveTextContent("sensitive provider details");
		expect(alert).toHaveTextContent(
			status === 403 ? /administrator/i : /could not/i,
		);
		expect(props.onApply).not.toHaveBeenCalled();
	});

	it("explains empty and unsupported results without silently loading them", async () => {
		vi.mocked(apiFetch).mockImplementation(async (path) =>
			path === endpoint
				? {
						configurations: [],
						issues: [
							{
								codec: "H264",
								code: "UNSUPPORTED_GLOBAL_SETTINGS",
								fields: ["minBitrate"],
							},
						],
					}
				: [{ id: "saved-account", label: "Saved account" }],
		);
		const { props } = show();
		await open();
		fireEvent.click(screen.getByRole("button", { name: copy.en.fetch }));
		expect(await screen.findByText(/No settings can be loaded/)).toBeVisible();
		expect(screen.getByText(/H264.*unsupported/i)).toHaveTextContent(
			"minBitrate",
		);
		expect(screen.getByRole("button", { name: copy.en.load })).toBeDisabled();
		expect(props.onApply).not.toHaveBeenCalled();
	});

	it("validates returned configurations and reports a rejected codec beside valid ones", async () => {
		const data = result();
		data.configurations = data.configurations.map((configuration) =>
			configuration.codec === "H265"
				? {
						...configuration,
						goal: { ...configuration.goal, minBitrate: 5_000_000 },
					}
				: configuration,
		);
		vi.mocked(apiFetch).mockImplementation(async (path) =>
			path === endpoint
				? data
				: [{ id: "saved-account", label: "Saved account" }],
		);
		show();
		await open();
		fireEvent.click(screen.getByRole("button", { name: copy.en.fetch }));
		await screen.findByRole("checkbox", { name: /H264/ });
		expect(screen.queryByRole("checkbox", { name: /H265/ })).toBeNull();
		expect(screen.getByText(/H265.*cannot be loaded/i)).toBeVisible();
	});

	it("discards the preview when inputs change after a successful fetch", async () => {
		show();
		await open();
		fireEvent.click(screen.getByRole("button", { name: copy.en.fetch }));
		await screen.findByRole("checkbox", { name: /H264/ });
		fireEvent.change(screen.getByLabelText(copy.en.id), {
			target: { value: anotherId },
		});
		expect(screen.queryByRole("button", { name: copy.en.load })).toBeNull();
		expect(screen.queryByRole("checkbox", { name: /H264/ })).toBeNull();
	});

	it("keeps temporary keys out of storage and clears them when the outer dialog closes", async () => {
		const storage = vi.spyOn(Storage.prototype, "setItem");
		try {
			show();
			await open();
			fireEvent.click(screen.getByLabelText(copy.en.temporary));
			fireEvent.change(screen.getByLabelText("API key"), {
				target: { value: "temporary-test-only-api-key" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Close" }));
			fireEvent.click(screen.getByRole("button", { name: copy.en.open }));
			fireEvent.click(screen.getByLabelText(copy.en.temporary));
			expect(screen.getByLabelText("API key")).toHaveValue("");
			expect(storage).not.toHaveBeenCalled();
		} finally {
			storage.mockRestore();
		}
	});

	it("lets users recover from an account-list failure with a temporary key", async () => {
		vi.mocked(apiFetch).mockRejectedValue(
			new ApiError(503, "sensitive account details"),
		);
		show();
		fireEvent.click(screen.getByRole("button", { name: copy.en.open }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/Accounts could not be loaded/,
		);
		expect(screen.getByRole("alert")).not.toHaveTextContent(
			"sensitive account details",
		);
		fireEvent.click(screen.getByLabelText(copy.en.temporary));
		expect(screen.getByLabelText("API key")).toBeVisible();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("rejects untrusted warning fields without rendering them", async () => {
		vi.mocked(apiFetch).mockImplementation(async (path) =>
			path === endpoint
				? {
						configurations: [],
						issues: [
							{
								code: "MISSING_BITRATE_LIMITS",
								fields: ["private-field-value"],
							},
						],
					}
				: [{ id: "saved-account", label: "Saved account" }],
		);
		show();
		await open();
		fireEvent.click(screen.getByRole("button", { name: copy.en.fetch }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/returned settings cannot be loaded/,
		);
		expect(screen.queryByText(/private-field-value/)).toBeNull();
	});

	it("loads a width-only fixed-resolution template without inventing a height", async () => {
		vi.mocked(apiFetch).mockImplementation(async (path) =>
			path === endpoint
				? {
						configurations: [
							{
								codec: "H264",
								goal: {
									...initialGoal,
									strategy: "fixed-resolutions",
									autoRepresentations: false,
									automaticTemplates: [],
									rows: [{ id: "width-template", width: 1280 }],
								},
								reference: {
									codec: "H264",
									global: { minBitrate: 100_000, maxBitrate: 4_000_000 },
									streams: [
										{
											id: "width-template",
											mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
											width: 1280,
										},
									],
								},
							},
						],
						issues: [],
					}
				: [{ id: "saved-account", label: "Saved account" }],
		);
		show();
		await open();
		fireEvent.click(screen.getByRole("button", { name: copy.en.fetch }));
		await screen.findByRole("checkbox", { name: /H264/ });
		fireEvent.click(screen.getByRole("button", { name: copy.en.load }));
		const api = JSON.parse(
			screen.getByTestId("per-title-api-settings").textContent ?? "{}",
		);
		expect(api.streams[0]).toMatchObject({
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			width: 1280,
		});
		expect(api.streams[0]).not.toHaveProperty("height");
	});
});
