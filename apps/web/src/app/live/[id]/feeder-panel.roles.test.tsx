import type { LiveChannelPlan } from "@bitovp/core";
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

import { FeederPanel } from "./feeder-panel";

const OPERATOR_SESSION: SessionDto = {
	mode: "users",
	configured: true,
	authenticated: true,
	loginKind: "password-form",
	role: "OPERATOR",
};

const PLAN = {
	planVersion: 1,
	name: "role-loss-feeder",
	bitmovin: { accountId: "account-1" },
	liveInput: { key: "main", kind: "RTMP", name: "RTMP Input" },
	outputs: [],
	ingest: [],
	renditions: [],
	muxings: [],
	liveManifests: [],
	start: { streamKey: "channel-key" },
} as unknown as LiveChannelPlan;

function mockFeederApi() {
	let session: SessionDto | "error" = OPERATOR_SESSION;
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/auth/session") {
			if (session === "error") {
				throw new Error("session unavailable");
			}
			return session;
		}
		if (url.startsWith("/api/feeder-sessions?")) {
			return { items: [] };
		}
		if (url === "/api/credentials") {
			return [
				{
					id: "credential-1",
					label: "Cached S3 credential",
					provider: "AWS_S3",
				},
			];
		}
		return { items: [] };
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

describe("FeederPanel role transitions", () => {
	it("unmounts an open OPERATOR storage browser when session resolution fails", async () => {
		const session = mockFeederApi();
		const user = userEvent.setup();
		const rendered = renderWithQuery(
			<FeederPanel
				channelId="channel-1"
				channelStatus="RUNNING"
				plan={PLAN}
				streamKey="channel-key"
				encoderIp="203.0.113.81"
			/>,
		);

		await user.click(
			await screen.findByRole("button", { name: "Start file input" }),
		);
		await user.click(screen.getByRole("button", { name: /Browse storage/ }));
		expect(
			await screen.findByRole("dialog", { name: "Pick an input object" }),
		).toBeVisible();
		expect(screen.getByText("Cached S3 credential")).toBeVisible();

		session.failSession();
		await act(async () => {
			await rendered.client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
		});

		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", { name: "Pick an input object" }),
			).toBeNull(),
		);
		expect(screen.queryByRole("button", { name: /Browse storage/ })).toBeNull();
	});
});
