import type { InputFileSummary } from "@bitovp/core";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@/lib/auth/dto";
import { SESSION_QUERY_KEY } from "@/lib/auth/use-session";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { InputFilesPanel } from "./input-files-panel";

const CREDENTIAL_ID = "00000000-0000-4000-8000-000000000381";
const FILE: InputFileSummary = {
	inputKey: "main",
	inputPath: "sources/program.mp4",
	kind: "S3",
	location: "source-bucket",
	credentialId: CREDENTIAL_ID,
	consumers: [],
};
const REFS = {
	[CREDENTIAL_ID]: { label: "Source credential", provider: "AWS_S3" },
};

function users(role: "VIEWER" | "OPERATOR"): SessionDto {
	return {
		mode: "users",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		role,
	};
}

function mockInputFilesApi(initialSession: SessionDto) {
	let session: SessionDto | "error" = initialSession;
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url === "/api/auth/session") {
			if (session === "error") {
				throw new Error("session unavailable");
			}
			return session;
		}
		if (url.startsWith("/api/storage-inspections?") && !init?.method) {
			return { latest: null };
		}
		if (url === "/api/storage-inspections" && init?.method === "POST") {
			return {
				id: "inspection-1",
				status: "PENDING",
				bucket: "source-bucket",
				objectKey: "sources/program.mp4",
				probe: null,
				bytesRead: null,
				error: null,
				createdAt: "2026-08-31T00:00:00.000Z",
				updatedAt: "2026-08-31T00:00:00.000Z",
			};
		}
		if (url === "/api/storage-inspections/inspection-1") {
			return {
				id: "inspection-1",
				status: "FINISHED",
				bucket: "source-bucket",
				objectKey: "sources/program.mp4",
				probe: null,
				bytesRead: 1024,
				error: null,
				createdAt: "2026-08-31T00:00:00.000Z",
				updatedAt: "2026-08-31T00:00:01.000Z",
			};
		}
		return {};
	});
	return {
		failSession() {
			session = "error";
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("InputFilesPanel inspection roles", () => {
	it("keeps passive inspection summaries readable but hides the OPERATOR probe from VIEWER", async () => {
		mockInputFilesApi(users("VIEWER"));
		renderWithQuery(<InputFilesPanel files={[FILE]} credentialRefs={REFS} />);

		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith(
				expect.stringMatching(/^\/api\/storage-inspections\?/),
			),
		);
		expect(screen.getByText("source-bucket/sources/program.mp4")).toBeVisible();
		expect(screen.queryByRole("button", { name: /inspect/i })).toBeNull();
		expect(
			apiFetch.mock.calls.some(
				([url, init]) =>
					url === "/api/storage-inspections" &&
					(init as RequestInit | undefined)?.method === "POST",
			),
		).toBe(false);
	});

	it("lets OPERATOR start a probe and closes its dialog if role resolution fails", async () => {
		const session = mockInputFilesApi(users("OPERATOR"));
		const user = userEvent.setup();
		const rendered = renderWithQuery(
			<InputFilesPanel files={[FILE]} credentialRefs={REFS} />,
		);

		await user.click(await screen.findByRole("button", { name: /^inspect$/i }));
		expect(
			await screen.findByRole("dialog", { name: /Inspect program\.mp4/ }),
		).toBeVisible();
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith(
				"/api/storage-inspections",
				expect.objectContaining({ method: "POST" }),
			),
		);

		session.failSession();
		await act(async () => {
			await rendered.client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
		});
		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", { name: /Inspect program\.mp4/ }),
			).toBeNull(),
		);
	});
});
