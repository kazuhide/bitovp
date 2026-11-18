import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { renderWithQuery } from "@/test/render";
import { StoredClipResult } from "./stored-clip-result";

const calls = vi.hoisted(() => ({
	api: vi.fn(),
	push: vi.fn(),
	canEdit: true,
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<typeof import("@/lib/api")>()),
	apiFetch: calls.api,
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => calls.canEdit,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: calls.push }),
}));

const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000010";
const exportId = "00000000-0000-4000-8000-000000000011";
const targetId = "00000000-0000-4000-8000-000000000012";
const artifact = "/api/library/artifacts/00000000-0000-4000-8000-000000000013";
const result = {
	projectId,
	contentId: "00000000-0000-4000-8000-000000000014",
	title: "Episode teaser",
	purpose: "TRAILER",
	earlierVersion: true,
	render: {
		id: exportId,
		revisionId: "00000000-0000-4000-8000-000000000015",
		generation: 1,
		kind: "EXPORT",
		state: "SUCCEEDED",
		error: null,
		durationFrames: 150,
		artifact: {
			id: artifact.split("/").at(-1),
			url: `${artifact}/media?expectedOrganizationId=${organizationId}`,
			downloadUrl: `${artifact}/download?expectedOrganizationId=${organizationId}`,
			derivedContentId: null,
		},
	},
	settings: {
		canvas: { width: 1080, height: 1920 },
		fps: { num: 30, den: 1 },
		durationFrames: 150,
		captionCount: 3,
		captionDisplayLanguage: "ja",
		audioTrackCount: 1,
		videoFit: "FILL",
		captionPlacement: "BANDS",
		clips: [
			{
				id: "00000000-0000-4000-8000-000000000016",
				sourceNumber: 1,
				sourceInUs: 35_000_000,
				timelineStartFrame: 0,
				durationFrames: 150,
				audio: "MUTE",
				framing: ["CROP"],
			},
		],
	},
};

function mount(clipEditingAvailable = true) {
	return renderWithQuery(
		<DocumentOrganizationContext.Provider value={organizationId}>
			<StoredClipResult
				id={projectId}
				exportId={exportId}
				clipEditingAvailable={clipEditingAvailable}
			/>
		</DocumentOrganizationContext.Provider>,
	);
}

beforeEach(() => {
	calls.api.mockReset();
	calls.push.mockReset();
	calls.canEdit = true;
});

it("shows the saved export settings and creates a separate draft only on re-edit", async () => {
	calls.api
		.mockResolvedValueOnce(result)
		.mockResolvedValueOnce({ id: targetId });
	mount();
	await screen.findByRole("heading", { name: "Editing settings" });
	expect(screen.getByText("1080 × 1920")).toBeVisible();
	expect(screen.getByText("35.000–40.000 s")).toBeVisible();
	expect(screen.getByText("Muted")).toBeVisible();
	expect(calls.api).toHaveBeenCalledTimes(1);
	fireEvent.click(screen.getByRole("button", { name: "Re-edit" }));
	await waitFor(() =>
		expect(calls.push).toHaveBeenCalledWith(`/library/edits/${targetId}`),
	);
	const [url, options] = calls.api.mock.calls[1] ?? [];
	expect(url).toBe("/api/library/edits");
	expect(options.method).toBe("POST");
	expect(JSON.parse(options.body)).toMatchObject({
		title: "Episode teaser (re-edit)",
		fromExport: {
			projectId,
			exportId,
			expectedOrganizationId: organizationId,
			requestKey: expect.any(String),
		},
	});
});

it("reuses the same draft request after an uncertain response", async () => {
	calls.api
		.mockResolvedValueOnce(result)
		.mockRejectedValueOnce(new Error("Network error"))
		.mockResolvedValueOnce({ id: targetId });
	mount();
	fireEvent.click(await screen.findByRole("button", { name: "Re-edit" }));
	await screen.findByRole("alert");
	fireEvent.click(screen.getByRole("button", { name: "Re-edit" }));
	await waitFor(() => expect(calls.push).toHaveBeenCalledOnce());
	expect(calls.api.mock.calls[2]?.[1]?.body).toBe(
		calls.api.mock.calls[1]?.[1]?.body,
	);
});

it("still shows recorded settings when editing is unavailable", async () => {
	calls.api.mockResolvedValue(result);
	mount(false);
	await screen.findByRole("heading", { name: "Editing settings" });
	expect(screen.getByRole("button", { name: "Re-edit" })).toBeDisabled();
	expect(
		screen.getByText("Re-editing requires the editing service."),
	).toBeVisible();
	expect(
		screen.getByRole("link", { name: "Generation history" }),
	).toBeVisible();
});
