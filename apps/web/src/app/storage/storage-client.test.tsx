import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { StorageClient } from "./storage-client";

type ObjectsReply = {
	prefixes?: string[];
	objects: { key: string; size: number }[];
	nextCursor?: string;
	scan?: Record<string, unknown>;
};

/** Records every objects-route URL the client requested. */
const objectUrls: string[] = [];

/** : flip the buckets listing to an empty SUCCESS. */
const emptyBuckets = { value: false };

function mockApi(objectsFor: (url: string) => ObjectsReply) {
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/credentials") {
			return [{ id: "az-1", label: "My Azure", provider: "AZURE_BLOB" }];
		}
		if (url.includes("/storage/buckets")) {
			return { buckets: emptyBuckets.value ? [] : ["media"] };
		}
		if (url.includes("/storage/objects")) {
			objectUrls.push(url);
			const reply = objectsFor(url);
			return { prefixes: [], ...reply };
		}
		if (url === "/api/storage-presets") {
			return [];
		}
		return {};
	});
}

function renderClient(locale: "en" | "ja" = "en") {
	return renderWithQuery(<StorageClient />, locale);
}

/** Selects the seeded credential and opens the container. */
async function openBucket(user: ReturnType<typeof userEvent.setup>) {
	await screen.findByRole("option", { name: /My Azure/ });
	await user.selectOptions(screen.getByLabelText("Credential"), "az-1");
	await user.click(await screen.findByRole("button", { name: "media" }));
	await screen.findByRole("textbox", { name: "Filter by name" });
}

beforeEach(() => {
	vi.clearAllMocks();
	objectUrls.length = 0;
});

describe("StorageClient — object search", () => {
	it("offers Azure Blob credentials for browsing", async () => {
		mockApi(() => ({ objects: [] }));
		renderClient();
		const option = await screen.findByRole("option", { name: /My Azure/ });
		expect(option).not.toBeDisabled();
	});

	it("sends the search to the server and shows matches from deeper folders", async () => {
		const user = userEvent.setup();
		mockApi((url) =>
			url.includes("search=trailer")
				? {
						objects: [{ key: "in/2026/q1/trailer.mp4", size: 10 }],
						scan: {
							scannedObjects: 240,
							scannedPages: 3,
							matchLimitReached: false,
							scanLimitReached: false,
							complete: true,
						},
					}
				: { objects: [{ key: "in/loaded-page-only.mp4", size: 1 }] },
		);
		renderClient();
		await openBucket(user);

		await user.type(
			screen.getByRole("textbox", { name: "Filter by name" }),
			"trailer",
		);
		// The query goes to the API — not to the rows already in the table.
		await waitFor(() =>
			expect(objectUrls.some((url) => url.includes("search=trailer"))).toBe(
				true,
			),
		);
		// A match nested below the browsed prefix shows its path, not a bare name.
		await screen.findByText("in/2026/q1/trailer.mp4");
		await screen.findByText(/240 objects scanned, whole prefix covered/);
		expect(screen.queryByText("in/loaded-page-only.mp4")).toBeNull();
	});

	it("warns that a truncated scan may be hiding matches", async () => {
		const user = userEvent.setup();
		mockApi((url) =>
			url.includes("search=")
				? {
						objects: [{ key: "in/a.mp4", size: 1 }],
						nextCursor: "resume-here",
						scan: {
							scannedObjects: 2500,
							scannedPages: 25,
							matchLimitReached: false,
							scanLimitReached: true,
							complete: false,
						},
					}
				: { objects: [] },
		);
		renderClient();
		await openBucket(user);

		await user.type(
			screen.getByRole("textbox", { name: "Filter by name" }),
			"a",
		);
		await screen.findByText(
			/1 match so far — the scan stopped after 2500 objects/,
		);
		// Truncation is resumable, so the pager stays available.
		await screen.findByRole("button", { name: /Load more/ });
	});

	it("passes an extension filter through as its own parameter", async () => {
		const user = userEvent.setup();
		mockApi(() => ({ objects: [], scan: { complete: true } }));
		renderClient();
		await openBucket(user);

		await user.type(
			screen.getByRole("textbox", { name: "Filter by extension" }),
			".mp4",
		);
		await waitFor(() =>
			expect(objectUrls.some((url) => url.includes("ext=mp4"))).toBe(true),
		);
	});
});

/**
 * The storage browser in Japanese. Hardcoded literals rather than `t` lookups —
 * an expectation computed through the same catalogue the component reads moves in
 * lockstep with it and proves nothing.
 */
describe("StorageClient — Japanese", () => {
	it("renders the heading and the empty-state guidance in Japanese", async () => {
		renderClient("ja");
		expect(await screen.findByText("ストレージブラウザ")).toBeInTheDocument();
		expect(
			await screen.findByText(/参照を開始するにはストレージ資格情報/),
		).toBeInTheDocument();
		expect(screen.queryByText("Storage Browser")).not.toBeInTheDocument();
	});

	it("labels the credential field in Japanese", async () => {
		renderClient("ja");
		expect(await screen.findByLabelText("資格情報")).toBeInTheDocument();
	});
});

describe("an empty bucket listing renders a sentence, not nothing (ledger #143)", () => {
	it("says no buckets are listable instead of an empty list", async () => {
		emptyBuckets.value = true;
		try {
			mockApi(() => ({ objects: [] }));
			renderClient();
			await screen.findByRole("option", { name: /My Azure/ });
			await userEvent.selectOptions(
				screen.getByLabelText("Credential"),
				"az-1",
			);
			// The old behaviour was an EMPTY <ul> — a success rendering nothing
			// at all (review-277 F6). The sentence must name both readings,
			// because an empty listing does not distinguish "no buckets exist"
			// from "this key cannot see them".
			expect(
				await screen.findByText(/no buckets are listable/i),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("list", { name: /bucket/i }),
			).not.toBeInTheDocument();
		} finally {
			emptyBuckets.value = false;
		}
	});
});
