import type { InputFileSummary } from "@bitovp/core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as renderQ } from "@/test/render";
import { InputFilesPanel } from "./input-files-panel";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

/**
 * The inspect wiring (job-detail design PR 5, narrowing 's
 * "browser-only"): a credentialed input card offers Inspect and shows what a
 * PRIOR probe found; an HTTPS card — the one credential-less kind — offers
 * neither, and the panel never probes on its own.
 */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const CRED_ID = "00000000-0000-4000-8000-0000000000c1";

const s3File = (over: Partial<InputFileSummary> = {}): InputFileSummary => ({
	inputKey: "in",
	inputPath: "sources/mezz.mp4",
	kind: "S3",
	location: "src-bucket",
	credentialId: CRED_ID,
	consumers: [],
	...over,
});

const httpsFile = (): InputFileSummary => ({
	inputKey: "web",
	inputPath: "media/remote.mp4",
	kind: "HTTPS",
	location: "example.invalid",
	consumers: [],
});

const REFS = { [CRED_ID]: { label: "source", provider: "AWS_S3" } };

/** The latest-inspection GET, FINISHED with a real-shaped probe. */
function latestFinished() {
	return {
		latest: {
			id: "insp-1",
			status: "FINISHED",
			bucket: "src-bucket",
			objectKey: "sources/mezz.mp4",
			probe: {
				format: { format_name: "mov,mp4", duration: "62.400" },
				streams: [
					{
						index: 0,
						codec_type: "video",
						codec_name: "h264",
						width: 1920,
						height: 1080,
					},
					{ index: 1, codec_type: "audio", codec_name: "aac" },
				],
			},
			bytesRead: 1024,
			error: null,
			createdAt: "2026-08-12T00:00:00.000Z",
			updatedAt: "2026-08-12T00:00:01.000Z",
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	apiFetch.mockResolvedValue({ latest: null });
});

describe("input files panel — inspect wiring", () => {
	it("offers Inspect on a credentialed card, and opens the dialog with ITS object", async () => {
		renderQ(<InputFilesPanel files={[s3File()]} credentialRefs={REFS} />);
		await userEvent.click(screen.getByRole("button", { name: /inspect/i }));
		// The dialog is open on this exact object (its title carries the basename;
		// by ROLE, because the card's copyable path also contains the filename) —
		// and mounting its body is what POSTs, so the button's action IS the probe.
		expect(
			await screen.findByRole("heading", { name: /Inspect mezz\.mp4/ }),
		).toBeTruthy();
		await waitFor(() => {
			const post = apiFetch.mock.calls.find(
				(call) =>
					call[0] === "/api/storage-inspections" &&
					(call[1] as RequestInit | undefined)?.method === "POST",
			);
			expect(post).toBeTruthy();
			expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
				credentialId: CRED_ID,
				bucket: "src-bucket",
				objectKey: "sources/mezz.mp4",
			});
		});
	});

	it("offers NO inspect on an HTTPS card, and never queries for it", async () => {
		renderQ(<InputFilesPanel files={[httpsFile()]} credentialRefs={{}} />);
		expect(screen.queryByRole("button", { name: /inspect/i })).toBeNull();
		// No chips query either: there is no credential to sign a read with.
		await waitFor(() => expect(apiFetch).not.toHaveBeenCalled());
	});

	it("shows what a prior probe found, without probing", async () => {
		apiFetch.mockResolvedValue(latestFinished());
		renderQ(<InputFilesPanel files={[s3File()]} credentialRefs={REFS} />);
		// Container, duration and per-stream codecs on one line.
		expect(await screen.findByText(/mov,mp4/)).toBeTruthy();
		expect(screen.getByText(/1:02\.400/)).toBeTruthy();
		expect(screen.getByText(/h264 1920×1080/)).toBeTruthy();
		expect(screen.getByText(/aac/)).toBeTruthy();
		// PASSIVE: the panel read our own row and probed nothing.
		expect(
			apiFetch.mock.calls.filter(
				(call) => (call[1] as RequestInit | undefined)?.method === "POST",
			),
		).toHaveLength(0);
	});

	it("refreshes the chips after an inspection finishes — the full round-trip", async () => {
		// The stack review proved the old chips NEVER refreshed: a private query key
		// over the identical URL, invalidated by nothing — inspect, read the result
		// in the dialog, close, and the card still looked uninspected until a full
		// page load. Chips and dialog now share latestInspectionKey, and the
		// dialog invalidates it when the poll lands terminal. This drives the whole
		// loop: no prior inspection → Inspect → POST → poll FINISHED → chips appear.
		let inspected = false;
		apiFetch.mockImplementation(async (input: string, init?: RequestInit) => {
			if (input === "/api/storage-inspections" && init?.method === "POST") {
				inspected = true;
				return { ...latestFinished().latest, status: "RUNNING", probe: null };
			}
			if (input.startsWith("/api/storage-inspections/insp-1")) {
				return latestFinished().latest;
			}
			if (input.startsWith("/api/storage-inspections?")) {
				return inspected ? latestFinished() : { latest: null };
			}
			return {};
		});
		renderQ(<InputFilesPanel files={[s3File()]} credentialRefs={REFS} />);
		expect(screen.queryByText(/mov,mp4/)).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /inspect/i }));
		// The dialog's poll reaches FINISHED → it invalidates the shared key → the
		// CHIPS refetch and render, with the dialog still open. The discriminator
		// is CONTAINMENT, not styling: the dialog's own report also prints the
		// container name (and in a font-mono context), so the assertion must be
		// "inside the card's listitem" — a class check passed with the broken
		// private key on the first attempt (mutation caught the test, not the code).
		// hidden: the Radix dialog is MODAL and aria-hides everything outside it,
		// which is exactly why containment (not styling) is the right discriminator.
		const card = screen.getByRole("listitem", { hidden: true });
		await waitFor(() => expect(within(card).getByText(/mov,mp4/)).toBeTruthy());
	});

	it("shows no chips when nothing was ever inspected", async () => {
		renderQ(<InputFilesPanel files={[s3File()]} credentialRefs={REFS} />);
		await waitFor(() => expect(apiFetch).toHaveBeenCalled());
		expect(screen.queryByText(/mov,mp4/)).toBeNull();
	});
});
