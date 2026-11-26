import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { NativeEncodingClient } from "./native-encoding-client";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));

const primaryId = "00000000-0000-4000-8000-000000000001";
const secondaryId = "00000000-0000-4000-8000-000000000002";
const resourceId = "00000000-0000-4000-8000-000000000003";
const template = { id: resourceId, name: "Studio template", type: "LIVE" };

beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/bitmovin-accounts") {
			return [
				{ id: primaryId, label: "Studio" },
				{ id: secondaryId, label: "Archive" },
			];
		}
		const params = new URL(url, "https://test").searchParams;
		if (params.has("id")) return { item: template };
		if (params.get("bitmovinAccountId") === secondaryId) {
			return { offset: 0, totalCount: 0, items: [] };
		}
		if (params.get("kind") === "watch-folders") {
			return {
				offset: 0,
				totalCount: 1,
				items: [{ id: resourceId, name: "Incoming", status: "STARTED" }],
			};
		}
		if (params.get("kind") === "outputs") {
			return {
				offset: 0,
				totalCount: 1,
				items: [
					{
						...template,
						name: params.get("protocol") === "cdn" ? "CDN output" : "S3 output",
					},
				],
			};
		}
		if (params.get("offset") === "1") throw new Error("Network unavailable");
		return { offset: 0, totalCount: 2, items: [template] };
	});
});

describe("NativeEncodingClient", () => {
	it("opens account-bound details and closes them when switching resources and accounts", async () => {
		renderWithQuery(<NativeEncodingClient />);
		fireEvent.click(
			await screen.findByRole("button", { name: /Studio template/ }),
		);
		expect(await screen.findByText(resourceId)).toBeInTheDocument();
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/encoding-native?kind=templates&bitmovinAccountId=${primaryId}&id=${resourceId}`,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		fireEvent.change(screen.getByRole("combobox", { name: "Resource" }), {
			target: { value: "watch-folders" },
		});
		expect(
			await screen.findByRole("button", { name: /Incoming/ }),
		).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText(resourceId)).toBeNull();
		fireEvent.change(
			screen.getByRole("combobox", { name: "Bitmovin account" }),
			{ target: { value: secondaryId } },
		);
		expect(
			await screen.findByText("No resources on this page."),
		).toBeInTheDocument();
		expect(screen.queryByText("Incoming")).toBeNull();
	});

	it("uses the actual page size to advance and offers Back when a following page fails", async () => {
		renderWithQuery(<NativeEncodingClient />);
		await screen.findByText("Studio template");
		fireEvent.change(screen.getByRole("combobox", { name: "Template type" }), {
			target: { value: "LIVE" },
		});
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith(
				`/api/encoding-native?kind=templates&bitmovinAccountId=${primaryId}&offset=0&type=LIVE`,
				expect.anything(),
			),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not load resources from Bitmovin.",
		);
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/encoding-native?kind=templates&bitmovinAccountId=${primaryId}&offset=1&type=LIVE`,
			expect.anything(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
		expect(await screen.findByText("Studio template")).toBeInTheDocument();
	});

	it("keeps the selected output protocol in list and detail requests", async () => {
		renderWithQuery(<NativeEncodingClient />);
		await screen.findByText("Studio template");
		fireEvent.change(screen.getByRole("combobox", { name: "Resource" }), {
			target: { value: "outputs" },
		});
		fireEvent.click(await screen.findByRole("button", { name: /S3 output/ }));
		await screen.findByText(resourceId);
		fireEvent.change(
			screen.getByRole("combobox", { name: "Storage or protocol" }),
			{ target: { value: "cdn" } },
		);
		const cdnRow = await screen.findByRole("button", { name: /CDN output/ });
		expect(cdnRow).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText(resourceId)).toBeNull();
		fireEvent.click(cdnRow);
		await screen.findByText(resourceId);
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/encoding-native?kind=outputs&bitmovinAccountId=${primaryId}&protocol=cdn&id=${resourceId}`,
			expect.anything(),
		);
	});
});
