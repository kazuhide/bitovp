import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DrmRowEditor } from "./drm-row-editor";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const OWNER_SESSION = {
	mode: "password",
	configured: true,
	authenticated: true,
	loginKind: "password-form",
};

beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/auth/session") return OWNER_SESSION;
		return undefined;
	});
});

/**
 * : direct key entry auto-creates a DRM_CENC credential and
 * assigns it — the plan keeps carrying a REFERENCE, the key never enters
 * wizard state. The validation gate (32 hex) sits in front of the POST.
 */
describe("DrmRowEditor — inline key entry (ledger #120)", () => {
	function renderEditor(onChange = vi.fn()) {
		renderWithQuery(
			<DrmRowEditor
				idBase="drm-0"
				row={{
					kind: "CENC",
					muxingKey: "v720",
					credentialId: "",
					kid: "00112233445566778899aabbccddeeff",
				}}
				drmCredentials={[]}
				onChange={onChange}
				onRemove={vi.fn()}
			/>,
		);
		return onChange;
	}

	it("gates the POST behind the 32-hex rule and shows the reason", async () => {
		renderEditor();
		fireEvent.click(await screen.findByText("Enter key directly…"));
		const input = screen.getByLabelText("Content key (32 hex chars)");
		fireEvent.change(input, { target: { value: "not-hex" } });
		expect(screen.getByText(/exactly 32 hex characters/)).toBeInTheDocument();
		expect(
			(screen.getByText("Save key and use it") as HTMLButtonElement).disabled,
		).toBe(true);
		expect(
			apiFetch.mock.calls.some(([url]) => url === "/api/credentials"),
		).toBe(false);
	});

	it("creates the DRM_CENC credential and assigns the returned id", async () => {
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/auth/session") return OWNER_SESSION;
			if (url === "/api/credentials") return { id: "cred-new" };
			return undefined;
		});
		const onChange = renderEditor();
		fireEvent.click(await screen.findByText("Enter key directly…"));
		fireEvent.change(screen.getByLabelText("Content key (32 hex chars)"), {
			target: { value: "00112233445566778899aabbccddeeff" },
		});
		fireEvent.click(screen.getByText("Save key and use it"));
		await waitFor(() =>
			expect(onChange).toHaveBeenCalledWith(
				expect.objectContaining({ credentialId: "cred-new" }),
			),
		);
		const [url, init] = apiFetch.mock.calls.find(
			([requestUrl]) => requestUrl === "/api/credentials",
		) as [string, RequestInit];
		expect(url).toBe("/api/credentials");
		const body = JSON.parse(String(init.body));
		expect(body).toMatchObject({
			provider: "DRM_CENC",
			config: {},
			secret: { key: "00112233445566778899aabbccddeeff" },
		});
	});

	it("the error path renders the alert and NEVER assigns (review-254 120-A1)", async () => {
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/auth/session") return OWNER_SESSION;
			if (url === "/api/credentials") throw new Error("boom from the route");
			return undefined;
		});
		const onChange = renderEditor();
		fireEvent.click(await screen.findByText("Enter key directly…"));
		fireEvent.change(screen.getByLabelText("Content key (32 hex chars)"), {
			target: { value: "00112233445566778899aabbccddeeff" },
		});
		fireEvent.click(screen.getByText("Save key and use it"));
		await screen.findByRole("alert");
		expect(screen.getByRole("alert").textContent).toContain(
			"boom from the route",
		);
		// The security-relevant half: a credentialId that was never created
		// must never be assigned — onCreated lives in onSuccess ONLY, and a
		// refactor to onSettled would break this silently without the pin.
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("SPEKE authoring", () => {
	it("offers provider references and DRM choices without inline content-key entry", async () => {
		const onChange = vi.fn();
		renderWithQuery(
			<DrmRowEditor
				idBase="speke"
				row={{
					kind: "SPEKE",
					muxingKey: "v360",
					credentialId: "",
					systemIds: ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"],
				}}
				drmCredentials={[]}
				onChange={onChange}
				onRemove={vi.fn()}
			/>,
		);
		expect(screen.getByLabelText("SPEKE key provider")).toBeInTheDocument();
		expect(screen.queryByText("Enter key directly…")).not.toBeInTheDocument();
		expect(
			screen.getByText(
				"The endpoint and authentication are stored encrypted. Provide both username and password for Basic authentication.",
			),
		).not.toBeVisible();
		fireEvent.mouseEnter(
			screen.getByRole("button", {
				name: /SPEKE key provider.*more information/,
			}),
		);
		expect(
			screen.getByText(
				"The endpoint and authentication are stored encrypted. Provide both username and password for Basic authentication.",
			),
		).toBeVisible();
		fireEvent.click(screen.getByLabelText("PlayReady"));
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({
				systemIds: [
					"edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",
					"9a04f079-9840-4286-ab92-e65be0885f95",
				],
			}),
		);
		fireEvent.change(screen.getByLabelText("Content ID"), {
			target: { value: "movie" },
		});
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ contentId: "movie" }),
		);
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith(
				"/api/auth/session",
				expect.anything(),
			),
		);
	});
});
