import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();

vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { InspectDialog, type InspectTarget } from "./inspect-dialog";
import { StorageClient } from "./storage-client";

const TARGET: InspectTarget = {
	credentialId: "00000000-0000-4000-8000-0000000000c1",
	bucket: "my-bucket",
	objectKey: "videos/raw/bbb.mp4",
};
const INSPECTION_ID = "00000000-0000-4000-8000-0000000000f1";

const PROBE = {
	format: {
		format_name: "mov,mp4,m4a,3gp,3g2,mj2",
		format_long_name: "QuickTime / MOV",
		duration: "135.400000",
		bit_rate: "4500000",
	},
	streams: [
		{
			index: 0,
			codec_type: "video",
			codec_name: "h264",
			profile: "High",
			width: 1920,
			height: 1080,
			r_frame_rate: "30000/1001",
			bit_rate: "4200000",
			tags: { language: "und" },
		},
		{
			index: 1,
			codec_type: "audio",
			codec_name: "aac",
			profile: "LC",
			channels: 2,
			channel_layout: "stereo",
			sample_rate: "48000",
			bit_rate: "128000",
			tags: { language: "eng" },
		},
	],
};

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: INSPECTION_ID,
		status: "PENDING",
		bucket: TARGET.bucket,
		objectKey: TARGET.objectKey,
		probe: null,
		bytesRead: null,
		error: null,
		createdAt: "2026-08-06T00:00:00.000Z",
		updatedAt: "2026-08-06T00:00:00.000Z",
		...overrides,
	};
}

function renderDialog(target: InspectTarget | null = TARGET) {
	return renderWithQuery(<InspectDialog target={target} onClose={vi.fn()} />);
}

const postCalls = () =>
	apiFetch.mock.calls.filter(
		(call) => (call[1] as RequestInit | undefined)?.method === "POST",
	);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("InspectDialog", () => {
	it.each([
		[
			"ja",
			"部分読み取りでは全体ビットレートを確定できないため、— と表示します",
		],
		[
			"en",
			"Overall bitrate is shown as — because a bounded read cannot establish it",
		],
	] as const)("keeps the Run25 partial bitrate in raw JSON only (%s)", async (locale, note) => {
		const probe = {
			...PROBE,
			format: {
				...PROBE.format,
				duration: "540.458",
				size: "8388608",
				bit_rate: "124170",
			},
			streams: PROBE.streams.map((stream, index) => ({
				...stream,
				bit_rate: index === 0 ? "1280000" : "125000",
			})),
		};
		const finished = row({ status: "FINISHED", probe, bytesRead: 8_388_608 });
		apiFetch.mockImplementation(async (url: string) =>
			url.startsWith("/api/storage-inspections?")
				? { latest: finished }
				: finished,
		);
		renderWithQuery(
			<InspectDialog target={TARGET} onClose={vi.fn()} />,
			locale,
		);
		await screen.findByText("QuickTime / MOV");
		expect(screen.queryByText("124 kbps")).not.toBeInTheDocument();
		expect(screen.getByText("1.28 Mbps")).toBeInTheDocument();
		expect(screen.getByText("125 kbps")).toBeInTheDocument();
		expect(screen.getByText((text) => text.includes(note))).toBeInTheDocument();
		const raw = screen
			.getByText(/JSON/, { selector: "summary" })
			.closest("details")
			?.querySelector("pre")?.textContent;
		expect(raw).toContain('"bit_rate": "124170"');
		expect(raw).toContain('"size": "8388608"');
		expect(postCalls()).toHaveLength(0);
	});

	it("POSTs an inspection when the object was never inspected, then polls it to FINISHED", async () => {
		let polls = 0;
		apiFetch.mockImplementation((url: string, init?: RequestInit) => {
			if (url.startsWith("/api/storage-inspections?")) {
				return Promise.resolve({ latest: null });
			}
			if (init?.method === "POST") {
				return Promise.resolve(row());
			}
			polls += 1;
			return Promise.resolve(
				polls === 1
					? row({ status: "RUNNING" })
					: row({
							status: "FINISHED",
							probe: PROBE,
							bytesRead: 8_388_608,
						}),
			);
		});

		renderDialog();

		// The POST carries the page's credential/bucket context verbatim.
		await waitFor(() => expect(postCalls()).toHaveLength(1));
		expect(postCalls()[0]?.[0]).toBe("/api/storage-inspections");
		expect(
			JSON.parse((postCalls()[0]?.[1] as RequestInit).body as string),
		).toEqual(TARGET);

		// Polls while non-terminal, then renders the probe summary + stream table.
		await screen.findByText("FINISHED", {}, { timeout: 5000 });
		expect(screen.getByText("QuickTime / MOV")).toBeInTheDocument();
		expect(screen.getByText("2:15.400")).toBeInTheDocument();
		expect(screen.getByText(/read 8\.0 MB/)).toBeInTheDocument();

		const table = screen.getByRole("table");
		expect(table).toHaveTextContent("h264");
		expect(table).toHaveTextContent("High");
		expect(table).toHaveTextContent("1920×1080");
		expect(table).toHaveTextContent("29.97 fps");
		expect(table).toHaveTextContent("4.20 Mbps");
		expect(table).toHaveTextContent("aac");
		expect(table).toHaveTextContent("2 (stereo)");
		expect(table).toHaveTextContent("48000 Hz");
		expect(table).toHaveTextContent("eng");

		// Raw JSON disclosure carries the full ffprobe output.
		const raw = screen.getByText(/Raw JSON/);
		expect(raw).toBeInTheDocument();
		expect(raw.closest("details")?.querySelector("pre")?.textContent).toContain(
			"mov,mp4,m4a,3gp,3g2,mj2",
		);
	});

	it("stops polling once the row is terminal", async () => {
		apiFetch.mockImplementation((url: string, init?: RequestInit) => {
			if (url.startsWith("/api/storage-inspections?")) {
				return Promise.resolve({ latest: null });
			}
			if (init?.method === "POST") {
				return Promise.resolve(row());
			}
			return Promise.resolve(row({ status: "FINISHED", probe: PROBE }));
		});
		renderDialog();
		await screen.findByText("FINISHED");
		const afterTerminal = apiFetch.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 2600));
		expect(apiFetch.mock.calls.length).toBe(afterTerminal);
	});

	it("shows the worker's ERROR message verbatim plus the bounded-read explanation", async () => {
		const message =
			"ffprobe found no streams in the first 12 MB of videos/raw/bbb.mp4 — the container's index may sit at the end of the file (a non-faststart MP4), which a bounded preview cannot reach";
		apiFetch.mockImplementation((url: string, init?: RequestInit) => {
			if (url.startsWith("/api/storage-inspections?")) {
				return Promise.resolve({ latest: null });
			}
			if (init?.method === "POST") {
				return Promise.resolve(row());
			}
			return Promise.resolve(
				row({ status: "ERROR", error: message, bytesRead: 12_582_912 }),
			);
		});
		renderDialog();
		await screen.findByText(message);
		expect(screen.getByText("ERROR")).toBeInTheDocument();
		expect(
			screen.getByText(/bounded on purpose/, { exact: false }),
		).toBeInTheDocument();
		expect(screen.getByText("-movflags +faststart")).toBeInTheDocument();
	});

	it("adopts a previous inspection without re-POSTing", async () => {
		apiFetch.mockImplementation((url: string) => {
			if (url.startsWith("/api/storage-inspections?")) {
				return Promise.resolve({
					latest: row({
						status: "FINISHED",
						probe: PROBE,
						bytesRead: 8_388_608,
					}),
				});
			}
			return Promise.resolve(
				row({ status: "FINISHED", probe: PROBE, bytesRead: 8_388_608 }),
			);
		});
		renderDialog();
		await screen.findByText("QuickTime / MOV");
		expect(postCalls()).toHaveLength(0);
		// The prior lookup is scoped to the full credential+bucket+key triple.
		const lookup = apiFetch.mock.calls[0]?.[0] as string;
		expect(lookup).toContain(`credentialId=${TARGET.credentialId}`);
		expect(lookup).toContain("bucket=my-bucket");
		expect(lookup).toContain(encodeURIComponent(TARGET.objectKey));
	});

	it("offers Re-inspect on a terminal row, which POSTs a fresh inspection", async () => {
		apiFetch.mockImplementation((url: string) => {
			if (url.startsWith("/api/storage-inspections?")) {
				return Promise.resolve({
					latest: row({ status: "FINISHED", probe: PROBE }),
				});
			}
			return Promise.resolve(row({ status: "FINISHED", probe: PROBE }));
		});
		renderDialog();
		const button = await screen.findByRole("button", { name: "Re-inspect" });
		await userEvent.click(button);
		await waitFor(() => expect(postCalls()).toHaveLength(1));
	});

	it("renders nothing (and fires no request) with no target", () => {
		renderDialog(null);
		expect(apiFetch).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("surfaces a failed POST instead of spinning forever", async () => {
		apiFetch.mockImplementation((url: string, init?: RequestInit) => {
			if (url.startsWith("/api/storage-inspections?")) {
				return Promise.resolve({ latest: null });
			}
			if (init?.method === "POST") {
				return Promise.reject(new Error("boom"));
			}
			return Promise.resolve(row());
		});
		renderDialog();
		await screen.findByText("Requesting the inspection failed");
	});
});

describe("Storage browser → Inspect", () => {
	it("opens the dialog for the clicked object with the page's credential + bucket", async () => {
		apiFetch.mockImplementation((url: string, init?: RequestInit) => {
			if (url === "/api/credentials") {
				return Promise.resolve([
					{ id: TARGET.credentialId, label: "My S3", provider: "AWS_S3" },
				]);
			}
			if (url.includes("/storage/buckets")) {
				return Promise.resolve({ buckets: [TARGET.bucket] });
			}
			if (url.includes("/storage/objects")) {
				return Promise.resolve({
					prefixes: [],
					objects: [{ key: TARGET.objectKey, size: 1024 }],
				});
			}
			if (url === "/api/storage-presets") {
				return Promise.resolve([]);
			}
			if (url.startsWith("/api/storage-inspections?")) {
				return Promise.resolve({ latest: null });
			}
			if (init?.method === "POST") {
				return Promise.resolve(row());
			}
			return Promise.resolve(row({ status: "RUNNING" }));
		});

		renderWithQuery(<StorageClient />);

		await screen.findByRole("option", { name: /My S3/ });
		await userEvent.selectOptions(
			screen.getByLabelText("Credential"),
			TARGET.credentialId,
		);
		await userEvent.click(
			await screen.findByRole("button", { name: TARGET.bucket }),
		);
		await userEvent.click(
			await screen.findByRole("button", {
				name: `Inspect ${TARGET.objectKey}`,
			}),
		);

		// Dialog opened and POSTed the page's credential + bucket + clicked key.
		await waitFor(() => expect(postCalls()).toHaveLength(1));
		expect(
			JSON.parse((postCalls()[0]?.[1] as RequestInit).body as string),
		).toEqual({ ...TARGET, objectSize: 1024 });
		expect(
			await screen.findByText(/Probing — reading a capped slice/),
		).toBeInTheDocument();
	});

	it("history lists prior inspections; clicking one loads THAT row (ledger #25)", async () => {
		const OLD_ID = "00000000-0000-4000-8000-00000000000b";
		apiFetch.mockImplementation((url: string) => {
			if (url.startsWith("/api/storage-inspections?")) {
				expect(url).toContain("history=1");
				return Promise.resolve({
					latest: row({ status: "FINISHED", probe: PROBE }),
					history: [
						{
							id: row().id,
							status: "FINISHED",
							createdAt: "2026-08-14T10:00:00.000Z",
							bytesRead: 8_388_608,
						},
						{
							id: OLD_ID,
							status: "ERROR",
							createdAt: "2026-08-13T09:00:00.000Z",
							bytesRead: null,
						},
					],
				});
			}
			if (url.endsWith(`/${OLD_ID}`)) {
				return Promise.resolve(
					row({ id: OLD_ID, status: "ERROR", error: "old probe failed" }),
				);
			}
			return Promise.resolve(row({ status: "FINISHED", probe: PROBE }));
		});

		renderDialog();
		const summary = await screen.findByText(/Inspection history \(2\)/);
		await userEvent.click(summary);
		// The old ERROR row is listed and clickable…
		await userEvent.click(screen.getByRole("button", { name: /ERROR/ }));
		// …and its detail replaces the view — the row's own error text renders.
		expect(await screen.findByText("old probe failed")).toBeInTheDocument();
	});
});
