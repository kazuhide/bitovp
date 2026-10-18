import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

/**
 * The storage picker is the wizards' component with its own suite; here it is
 * a stub that hands back a fixed object, so the arms are about what the form
 * does WITH a picked file — the C36 flow — not about browsing.
 */
const PICK = {
	credentialId: "00000000-0000-4000-8000-0000000000c1",
	bucket: "in",
	path: "slates/brb.mp4",
};
const PICK_OTHER = { ...PICK, path: "slates/other.mp4" };
vi.mock("@/components/storage-picker", () => ({
	StoragePicker: ({
		open,
		onSelect,
	}: {
		open: boolean;
		onSelect: (s: typeof PICK) => void;
	}) =>
		open ? (
			<div>
				<button type="button" onClick={() => onSelect(PICK)}>
					pick-brb
				</button>
				<button type="button" onClick={() => onSelect(PICK_OTHER)}>
					pick-other
				</button>
			</div>
		) : null,
}));

import { ApiError } from "@/lib/api";
import { SlateRegisterForm } from "./slate-register-form";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const BASE = `/api/live-channels/${CHANNEL_ID}/insertable-content`;

const OK_VERDICT = {
	status: "DONE",
	verdict: "OK",
	compared: ["resolution", "frame rate", "audio sample rate"],
	notComparable: [
		"H.264 profile",
		"H.264 level",
		"pixel format",
		"audio channels",
	],
	inputPath: {
		path: "slates/brb.mp4",
		original: "slates/brb.mp4",
		stripped: false,
	},
	kind: "movie",
	container: "mp4",
	differences: [],
	probe: {
		format: {
			format_name: "mov,mp4,m4a,3gp,3g2,mj2",
			format_long_name: "QuickTime / MOV",
		},
		streams: [
			{
				index: 0,
				codec_type: "video",
				codec_name: "h264",
				width: 1280,
				height: 720,
				r_frame_rate: "30/1",
			},
			{
				index: 1,
				codec_type: "audio",
				codec_name: "aac",
				sample_rate: "48000",
				channels: 2,
			},
		],
	},
};

/** The 2026-09-02 verdict: frame rate + sample rate block, container reported. */
const INCOMPATIBLE_VERDICT = {
	...OK_VERDICT,
	verdict: "INCOMPATIBLE",
	container: "matroska",
	differences: [
		{
			attribute: "frame rate",
			reference: "30",
			candidate: "24000/1001",
			blocking: true,
		},
		{
			attribute: "audio sample rate",
			reference: "48000 Hz",
			candidate: "44100 Hz",
			blocking: true,
		},
		{
			attribute: "container",
			reference: "mov/mp4",
			candidate: "matroska",
			blocking: false,
		},
	],
};

function mockApis(
	overrides: { preflight?: unknown | (() => unknown); postError?: Error } = {},
) {
	apiFetch.mockImplementation(async (input: unknown, init?: unknown) => {
		const url = String(input);
		const method = (init as { method?: string } | undefined)?.method ?? "GET";
		if (url === `${BASE}/preflight`) {
			const p = overrides.preflight ?? OK_VERDICT;
			return typeof p === "function" ? p() : p;
		}
		if (url === BASE && method === "POST") {
			if (overrides.postError) {
				throw overrides.postError;
			}
			return { id: "new-content", status: "CREATED", preflight: OK_VERDICT };
		}
		throw new Error(`unexpected apiFetch: ${method} ${url}`);
	});
}

function renderForm(locale: "en" | "ja" = "en") {
	const onRegistered = vi.fn();
	wrap(
		<SlateRegisterForm
			channelId={CHANNEL_ID}
			bitmovinAccountId={ACCOUNT_ID}
			onRegistered={onRegistered}
		/>,
		locale,
	);
	return { onRegistered };
}

async function pickFile(
	user: ReturnType<typeof userEvent.setup>,
	which = "pick-brb",
) {
	await user.click(screen.getByRole("button", { name: "Browse storage…" }));
	await user.click(screen.getByRole("button", { name: which }));
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("SlateRegisterForm (C36 / WP-A1)", () => {
	it("blocks Register until the picked file has been checked, then sends the picker's shape", async () => {
		mockApis();
		const user = userEvent.setup();
		const { onRegistered } = renderForm();
		const register = () =>
			screen.getByRole("button", { name: "Register content" });
		expect(register()).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Check compatibility" }),
		).toBeDisabled();

		await pickFile(user);
		expect(screen.getByDisplayValue("in/slates/brb.mp4")).toBeInTheDocument();
		expect(register()).toBeDisabled();
		expect(
			screen.getByText("Run the compatibility check first."),
		).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: "Check compatibility" }),
		);
		await waitFor(() => expect(register()).toBeEnabled());
		expect(
			screen.getByText("Compatible with the live stream."),
		).toBeInTheDocument();
		// rev406 R1: the OK names its scope, so it never reads as "everything matched".
		expect(
			screen.getByText(
				"Compared on: resolution, frame rate, audio sample rate. Not comparable from this channel's reference: H.264 profile, H.264 level, pixel format, audio channels.",
			),
		).toBeInTheDocument();
		// The probe summary: what the file contains, at a glance.
		expect(screen.getByText("QuickTime / MOV")).toBeInTheDocument();
		expect(screen.getByText(/1280×720 · 30 fps/)).toBeInTheDocument();
		const preflightCall = apiFetch.mock.calls.find(
			(c) => c[0] === `${BASE}/preflight`,
		);
		expect(JSON.parse((preflightCall?.[1] as { body: string }).body)).toEqual({
			bitmovinAccountId: ACCOUNT_ID,
			source: {
				credentialId: PICK.credentialId,
				bucket: "in",
				key: "slates/brb.mp4",
			},
		});

		await user.type(screen.getByLabelText("Name (optional)"), "brb");
		await user.click(register());
		await waitFor(() => expect(onRegistered).toHaveBeenCalled());
		const createCall = apiFetch.mock.calls.find(
			(c) => c[0] === BASE && (c[1] as { method?: string }).method === "POST",
		);
		expect(JSON.parse((createCall?.[1] as { body: string }).body)).toEqual({
			bitmovinAccountId: ACCOUNT_ID,
			content: {
				name: "brb",
				source: {
					credentialId: PICK.credentialId,
					bucket: "in",
					key: "slates/brb.mp4",
				},
			},
		});
	});

	it("an INCOMPATIBLE verdict keeps Register disabled and lists every difference, blocking vs reported", async () => {
		mockApis({ preflight: INCOMPATIBLE_VERDICT });
		const user = userEvent.setup();
		renderForm();
		await pickFile(user);
		await user.click(
			screen.getByRole("button", { name: "Check compatibility" }),
		);
		expect(
			await screen.findByText(/Not compatible with the live stream/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Register content" }),
		).toBeDisabled();
		expect(screen.getByText("frame rate 30 → 24000/1001")).toBeInTheDocument();
		expect(
			screen.getByText("audio sample rate 48000 Hz → 44100 Hz"),
		).toBeInTheDocument();
		expect(screen.getAllByText("blocks")).toHaveLength(2);
		// The container is shown as information, never as the reason.
		expect(
			screen.getByText("container mov/mp4 → matroska"),
		).toBeInTheDocument();
		expect(screen.getAllByText("reported only")).toHaveLength(1);
	});
	it("renders difference labels in Japanese without changing the gate", async () => {
		mockApis({ preflight: INCOMPATIBLE_VERDICT });
		const user = userEvent.setup();
		renderForm("ja");
		await user.click(screen.getByRole("button", { name: "ストレージを参照…" }));
		await user.click(screen.getByRole("button", { name: "pick-brb" }));
		await user.click(screen.getByRole("button", { name: "互換性を確認" }));
		expect(
			await screen.findByText("フレームレート 30 → 24000/1001"),
		).toBeInTheDocument();
		expect(
			screen.getByText("音声サンプリング周波数 48000 Hz → 44100 Hz"),
		).toBeInTheDocument();
		expect(screen.getByText("コンテナ mov/mp4 → matroska")).toBeInTheDocument();
		expect(screen.getAllByText("登録不可")).toHaveLength(2);
	});
	it("localizes the compared and not-comparable scope of an OK verdict", async () => {
		mockApis();
		const user = userEvent.setup();
		renderForm("ja");
		await user.click(screen.getByRole("button", { name: "ストレージを参照…" }));
		await user.click(screen.getByRole("button", { name: "pick-brb" }));
		await user.click(screen.getByRole("button", { name: "互換性を確認" }));
		expect(
			await screen.findByText(/解像度, フレームレート, 音声サンプリング周波数/),
		).toHaveTextContent(
			"H.264 プロファイル, H.264 レベル, ピクセル形式, 音声チャンネル数",
		);
		expect(
			screen.getByRole("button", { name: "コンテンツを登録" }),
		).toBeEnabled();
	});

	it("a still image is admitted: Register enables and the notice says what it will look like on air (ja, row #329)", async () => {
		mockApis({
			preflight: {
				...OK_VERDICT,
				kind: "image",
				container: "png_pipe",
				compared: ["media kind"],
				notComparable: [],
			},
		});
		const user = userEvent.setup();
		renderForm("ja");
		await user.click(screen.getByRole("button", { name: "ストレージを参照…" }));
		await user.click(screen.getByRole("button", { name: "pick-brb" }));
		await user.click(screen.getByRole("button", { name: "互換性を確認" }));
		expect(
			await screen.findByText(/静止画です。無音で、黒背景に収めて表示されます/),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "コンテンツを登録" }),
			).toBeEnabled(),
		);
	});

	it("an UNVERIFIED verdict enables Register and says why the check stood down", async () => {
		mockApis({
			preflight: {
				...OK_VERDICT,
				verdict: "UNVERIFIED",
				standDown: "NO_INGEST_REFERENCE",
				probe: undefined,
			},
		});
		const user = userEvent.setup();
		renderForm();
		await pickFile(user);
		await user.click(
			screen.getByRole("button", { name: "Check compatibility" }),
		);
		expect(
			await screen.findByText(/Could not be verified/),
		).toBeInTheDocument();
		expect(
			screen.getByText(/no heartbeat and no recorded source/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Register content" }),
		).toBeEnabled();
	});

	it("polls a PENDING inspection until the verdict lands", async () => {
		let calls = 0;
		mockApis({
			preflight: () => {
				calls += 1;
				return calls < 2
					? {
							status: "PENDING",
							inspectionId: "insp-1",
							inputPath: OK_VERDICT.inputPath,
						}
					: OK_VERDICT;
			},
		});
		const user = userEvent.setup();
		renderForm();
		await pickFile(user);
		await user.click(
			screen.getByRole("button", { name: "Check compatibility" }),
		);
		expect(await screen.findByText(/Inspecting the file/)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Register content" }),
		).toBeDisabled();
		await waitFor(
			() =>
				expect(
					screen.getByRole("button", { name: "Register content" }),
				).toBeEnabled(),
			{ timeout: 8000 },
		);
		expect(calls).toBeGreaterThanOrEqual(2);
	});

	it("changing the picked file disarms the previous verdict", async () => {
		mockApis();
		const user = userEvent.setup();
		renderForm();
		await pickFile(user);
		await user.click(
			screen.getByRole("button", { name: "Check compatibility" }),
		);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Register content" }),
			).toBeEnabled(),
		);
		await pickFile(user, "pick-other");
		expect(screen.getByDisplayValue("in/slates/other.mp4")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Register content" }),
		).toBeDisabled();
		expect(screen.queryByText("Compatible with the live stream.")).toBeNull();
	});

	it("renders a 422 SLATE_UNSUPPORTED_IMAGE from the register route as catalogue copy plus its kind row", async () => {
		mockApis({
			postError: new ApiError(
				422,
				"Slate clip is a still image — raw English",
				{
					code: "SLATE_UNSUPPORTED_IMAGE",
					differences: [
						{
							attribute: "media kind",
							reference: "movie",
							candidate: "image",
							blocking: true,
						},
					],
				},
			),
		});
		const user = userEvent.setup();
		renderForm();
		await pickFile(user);
		await user.click(
			screen.getByRole("button", { name: "Check compatibility" }),
		);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Register content" }),
			).toBeEnabled(),
		);
		await user.click(screen.getByRole("button", { name: "Register content" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"The still-image slate could not be registered",
		);
		expect(alert).toHaveTextContent("media kind movie → image");
		expect(alert).not.toHaveTextContent(/raw English/);
	});

	it("renders a 422 SLATE_INCOMPATIBLE from the register route as catalogue copy plus the differences (ja)", async () => {
		mockApis({
			postError: new ApiError(422, "Slate clip does not match — raw English", {
				code: "SLATE_INCOMPATIBLE",
				differences: INCOMPATIBLE_VERDICT.differences,
			}),
		});
		const user = userEvent.setup();
		renderForm("ja");
		await user.click(screen.getByRole("button", { name: "ストレージを参照…" }));
		await user.click(screen.getByRole("button", { name: "pick-brb" }));
		await user.click(screen.getByRole("button", { name: "互換性を確認" }));
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "コンテンツを登録" }),
			).toBeEnabled(),
		);
		await user.click(screen.getByRole("button", { name: "コンテンツを登録" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("この素材はライブ配信と一致しません");
		expect(alert).toHaveTextContent("フレームレート 30 → 24000/1001");
		expect(alert).toHaveTextContent("登録不可");
		expect(alert).not.toHaveTextContent(/raw English/);
	});
});

describe("row #330: a picked file is converted, not refused", () => {
	const TARGET = {
		width: 1280,
		height: 720,
		frameRate: 30,
		sampleRate: 48000,
		channels: 2,
		channelsAssumed: true,
	};

	it("an INCOMPATIBLE verdict with a NORMALIZE preparation enables Register and says what the conversion fixes", async () => {
		mockApis({
			preflight: {
				...INCOMPATIBLE_VERDICT,
				preparation: {
					action: "NORMALIZE",
					target: TARGET,
					reasons: ["container", "frame rate", "audio sample rate"],
				},
				conversionDestination: {
					bucket: "channel-output",
					keyPrefix: "chan-1/slates",
					sameAsSource: false,
				},
			},
		});
		const user = userEvent.setup();
		renderForm("en");
		await pickFile(user);
		await user.click(
			screen.getByRole("button", { name: "Check compatibility" }),
		);
		expect(
			await screen.findByText(
				/It will be converted to an MPEG-TS matching the live input before registration \(adjusted: container, frame rate, audio sample rate\)/,
			),
		).toBeInTheDocument();
		expect(screen.getByText("CONVERT")).toBeInTheDocument();
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Register content" }),
			).toBeEnabled(),
		);
		expect(screen.getAllByText("fixed by conversion")).toHaveLength(3);
		expect(screen.queryByText("blocks")).not.toBeInTheDocument();
		expect(
			screen.getByText(
				/The converted file is written to the channel's output storage, channel-output\/chan-1\/slates\//,
			),
		).toBeInTheDocument();
	});

	it("a WAIT_FOR_INPUT preparation enables Register and explains the wait; the 202 body is reported as accepted", async () => {
		apiFetch.mockImplementation(async (input: unknown, init?: unknown) => {
			const url = String(input);
			const method = (init as { method?: string } | undefined)?.method ?? "GET";
			if (url === `${BASE}/preflight`) {
				return {
					...OK_VERDICT,
					verdict: "UNVERIFIED",
					standDown: "NO_INGEST_REFERENCE",
					preparation: {
						action: "WAIT_FOR_INPUT",
						missing: ["ingest reference"],
					},
				};
			}
			if (url === BASE && method === "POST") {
				return {
					normalization: { id: "row-1", status: "WAITING_FOR_INPUT" },
					preflight: OK_VERDICT,
				};
			}
			throw new Error(`unexpected apiFetch: ${method} ${url}`);
		});
		const user = userEvent.setup();
		const { onRegistered } = renderForm("en");
		await pickFile(user);
		await user.click(
			screen.getByRole("button", { name: "Check compatibility" }),
		);
		expect(
			await screen.findByText(/The live input is not connected yet/),
		).toBeInTheDocument();
		expect(screen.getByText("WAIT")).toBeInTheDocument();
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Register content" }),
			).toBeEnabled(),
		);
		await user.click(screen.getByRole("button", { name: "Register content" }));
		expect(
			await screen.findByRole("status", {
				name: "",
			}),
		).toHaveTextContent(
			/converted and registered automatically once the live input connects/,
		);
		expect(onRegistered).toHaveBeenCalledTimes(1);
	});

	it("a REFUSE preparation reads as catalogue copy — core's English reason never reaches the page", async () => {
		mockApis({
			preflight: {
				...OK_VERDICT,
				verdict: "UNVERIFIED",
				preparation: {
					action: "REFUSE",
					reason:
						"the file carries no video stream (a slate must be a movie or a still image)",
				},
			},
		});
		const user = userEvent.setup();
		renderForm("en");
		await pickFile(user);
		await user.click(
			screen.getByRole("button", { name: "Check compatibility" }),
		);
		expect(
			await screen.findByText(
				/Cannot be registered: the file has no video stream \(a slate must be a movie or a still image\)\./,
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/carries no video stream/),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Register content" }),
		).toBeDisabled();
	});

	it("a REFUSE preparation keeps Register disabled and names the reason", async () => {
		mockApis({
			preflight: {
				...OK_VERDICT,
				verdict: "UNVERIFIED",
				preparation: {
					action: "REFUSE",
					reason:
						"the file carries no video stream (a slate must be a movie or a still image)",
				},
			},
		});
		const user = userEvent.setup();
		renderForm("en");
		await pickFile(user);
		await user.click(
			screen.getByRole("button", { name: "Check compatibility" }),
		);
		expect(
			await screen.findByText(
				/Cannot be registered: the file has no video stream/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Register content" }),
		).toBeDisabled();
	});

	it("an as-is MPEG-TS says so and enables Register", async () => {
		mockApis({
			preflight: {
				...OK_VERDICT,
				container: "mpegts",
				preparation: { action: "REGISTER_AS_IS", reason: "MATCHES_INGEST" },
			},
		});
		const user = userEvent.setup();
		renderForm("en");
		await pickFile(user);
		await user.click(
			screen.getByRole("button", { name: "Check compatibility" }),
		);
		expect(
			await screen.findByText(
				/An MPEG-TS matching the live input; it registers as it is/,
			),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Register content" }),
			).toBeEnabled(),
		);
	});
});
