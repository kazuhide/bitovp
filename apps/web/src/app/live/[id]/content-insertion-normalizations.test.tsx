import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ContentInsertionPanel } from "./content-insertion-panel";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));
const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<typeof import("@/lib/api")>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const channelId = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const accountId = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

function row(over: Record<string, unknown>) {
	return {
		id: "row",
		status: "QUEUED",
		name: null,
		bucket: "in",
		sourceKey: "slates/brb.mp4",
		registeredKey: null,
		normalized: false,
		insertableContentId: null,
		target: null,
		note: null,
		error: null,
		createdAt: "2026-09-13T12:00:00Z",
		updatedAt: "2026-09-13T12:00:00Z",
		...over,
	};
}

afterEach(() => vi.resetAllMocks());

describe("content insertion panel — registrations in flight (row #330)", () => {
	it("lists waiting/converting/failed rows in the operator's words and hides READY ones", async () => {
		apiFetch.mockImplementation((path: string) => {
			if (path.endsWith("/normalizations")) {
				return Promise.resolve({
					items: [
						row({
							id: "w",
							name: "brb",
							status: "WAITING_FOR_INPUT",
							note: "waiting for the live input (ingest reference not known yet)",
						}),
						row({
							id: "n",
							status: "NORMALIZING",
							sourceKey: "slates/rain.mov",
						}),
						row({
							id: "e",
							status: "ERROR",
							error: "ffmpeg could not convert the file (exit 1): bad data",
						}),
						row({
							id: "r",
							status: "READY",
							name: "done",
							insertableContentId: "c1",
						}),
					],
				});
			}
			return Promise.resolve({ items: [], totalCount: 0 });
		});
		renderWithQuery(
			<ContentInsertionPanel
				channelId={channelId}
				bitmovinAccountId={accountId}
				status="RUNNING"
				runId="run-1"
			/>,
			"ja",
		);
		const section = await screen.findByRole("group", {
			name: "変換・登録中の素材",
		});
		expect(within(section).getByText("brb")).toBeInTheDocument();
		expect(within(section).getByText("入力待ち")).toBeInTheDocument();
		expect(within(section).getByText("rain.mov")).toBeInTheDocument();
		expect(within(section).getByText("変換中")).toBeInTheDocument();
		expect(within(section).getByText("失敗")).toBeInTheDocument();
		// The raw reason is technical text: localized outcome for everyone,
		// ffmpeg's own words only under the server-authorized disclosure.
		expect(within(section).getByRole("alert")).toHaveTextContent(
			"変換または登録に失敗しました",
		);
		expect(within(section).getByRole("alert")).not.toHaveTextContent(
			"ffmpeg could not convert the file",
		);
		expect(within(section).queryByText("done")).not.toBeInTheDocument();
		expect(within(section).queryByText("登録済み")).not.toBeInTheDocument();
		// The worker's English note is technical text: never shown to a
		// non-admin, and never as customer copy.
		expect(
			within(section).queryByText(/waiting for the live input/),
		).not.toBeInTheDocument();
	});

	it("renders nothing extra when no registration is in flight", async () => {
		apiFetch.mockImplementation((path: string) =>
			Promise.resolve(
				path.endsWith("/normalizations")
					? { items: [] }
					: { items: [], totalCount: 0 },
			),
		);
		renderWithQuery(
			<ContentInsertionPanel
				channelId={channelId}
				bitmovinAccountId={accountId}
				status="RUNNING"
				runId="run-1"
			/>,
			"en",
		);
		expect(
			await screen.findByText(/No content registered/i),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("group", { name: "Converting and registering" }),
		).not.toBeInTheDocument();
	});

	it("shows the raw failure reason only under the technical-details disclosure", async () => {
		apiFetch.mockImplementation((path: string) =>
			Promise.resolve(
				path.endsWith("/normalizations")
					? {
							items: [
								row({
									id: "e",
									status: "ERROR",
									error: "ffmpeg could not convert the file (exit 1): bad data",
								}),
							],
						}
					: { items: [], totalCount: 0 },
			),
		);
		renderWithQuery(
			<ContentInsertionPanel
				channelId={channelId}
				bitmovinAccountId={accountId}
				status="RUNNING"
				runId="run-1"
				technicalDetailsAllowed
			/>,
			"en",
		);
		const section = await screen.findByRole("group", {
			name: "Converting and registering",
		});
		expect(within(section).getByRole("alert")).toHaveTextContent(
			"Conversion or registration failed. Check the file and register it again. ffmpeg could not convert the file (exit 1): bad data",
		);
	});

	it("shows the worker's progress note only under the technical-details disclosure", async () => {
		apiFetch.mockImplementation((path: string) =>
			Promise.resolve(
				path.endsWith("/normalizations")
					? {
							items: [
								row({
									id: "n",
									status: "NORMALIZING",
									note: "preparing the file",
								}),
							],
						}
					: { items: [], totalCount: 0 },
			),
		);
		renderWithQuery(
			<ContentInsertionPanel
				channelId={channelId}
				bitmovinAccountId={accountId}
				status="RUNNING"
				runId="run-1"
				technicalDetailsAllowed
			/>,
			"en",
		);
		const section = await screen.findByRole("group", {
			name: "Converting and registering",
		});
		expect(within(section).getByText("preparing the file")).toBeInTheDocument();
	});
});
