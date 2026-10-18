import { encodingPlanSchema, INTERNAL_HEVC_V2_BCF_VERSION } from "@bitovp/core";
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { InternalHevcV2Badge } from "./internal-hevc-v2-badge";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./new/build-plan";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
const ACCOUNT = "0f8edfe4-fc30-4a9a-89e3-a3e89d5245df";
const plan = encodingPlanSchema.parse(
	buildPlan({
		...DEFAULT_WIZARD_STATE,
		name: "internal",
		accountId: ACCOUNT,
		videos: [{ codec: "H265V2", height: 720, bitrate: 1_000_000 }],
		inputFiles: [
			{
				key: "main",
				inputKey: "main",
				kind: "S3",
				credentialId: ACCOUNT,
				bucket: "in",
				path: "a.mp4",
			},
		],
		output: {
			...DEFAULT_WIZARD_STATE.output,
			credentialId: ACCOUNT,
			bucket: "out",
			basePath: "test",
		},
		internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
	}),
);
beforeEach(() => vi.clearAllMocks());
it("shows profile provenance only after current account capability is confirmed", async () => {
	apiFetch.mockResolvedValue([{ id: ACCOUNT, internalHevcV2: true }]);
	const view = renderWithQuery(<InternalHevcV2Badge plan={plan} />);
	expect(await screen.findByText(/HEVCv2/)).toHaveTextContent(
		INTERNAL_HEVC_V2_BCF_VERSION,
	);
	view.unmount();
	apiFetch.mockResolvedValue([{ id: ACCOUNT, internalHevcV2: false }]);
	const denied = renderWithQuery(<InternalHevcV2Badge plan={plan} />);
	await waitFor(() =>
		expect(denied.client.getQueryState(["bitmovin-accounts"])?.status).toBe(
			"success",
		),
	);
	expect(screen.queryByText(/HEVCv2/)).toBeNull();
});
it("adds no metadata request for an ordinary plan", () => {
	renderWithQuery(
		<InternalHevcV2Badge plan={{ ...plan, internal: undefined }} />,
	);
	expect(apiFetch).not.toHaveBeenCalled();
});
