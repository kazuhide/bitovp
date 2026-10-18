import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { ApiError } from "@/lib/api";
import { LiveSettingsClient } from "./live-settings-client";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const POOL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ENCODING_ID = "11112222-3333-4444-8555-666677778888";
/** A live encoding this app never provisioned — no LiveChannel row exists. */
const FOREIGN_ENCODING_ID = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
const STREAM_KEY = "sk-live-abc12345";
const POOL_STREAM_KEY = "sk-standby-xyz98765";

function mockApi(overrides: Record<string, unknown> = {}) {
	apiFetch.mockImplementation(async (input: unknown, init?: unknown) => {
		const url = String(input);
		const method = (init as { method?: string } | undefined)?.method ?? "GET";
		if (url === "/api/auth/session") {
			return {
				mode: "password",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
			};
		}
		if (url === "/api/bitmovin-accounts") {
			return [
				{ id: ACCOUNT_ID, label: "main", tenantOrgId: null, defaults: {} },
			];
		}
		if (url.startsWith("/api/live-channels?")) {
			if (overrides.channelsFail) {
				throw new ApiError(502, "Request failed (502)");
			}
			return (
				overrides.channels ?? {
					items: [
						{
							id: "chan-1",
							name: "studio-a-channel",
							status: "RUNNING",
							error: null,
							bitmovinEncodingId: ENCODING_ID,
							bitmovinAccountId: ACCOUNT_ID,
							createdAt: "2026-08-06T09:00:00Z",
							updatedAt: "2026-08-06T10:00:00Z",
						},
						{
							id: "chan-2",
							name: "never-provisioned",
							status: "CREATED",
							error: null,
							bitmovinEncodingId: null,
							bitmovinAccountId: ACCOUNT_ID,
							createdAt: "2026-08-05T09:00:00Z",
							updatedAt: "2026-08-05T09:00:00Z",
						},
					],
				}
			);
		}
		if (url.startsWith("/api/live/stream-keys?")) {
			return (
				overrides.streamKeys ?? {
					totalCount: 2,
					items: [
						{
							id: "key-1",
							name: "studio-a",
							value: STREAM_KEY,
							status: "ASSIGNED",
							type: "RESERVED",
							assignedEncodingId: ENCODING_ID,
						},
						{
							id: "key-2",
							name: "spare",
							value: "sk-live-spare0001",
							status: "UNASSIGNED",
							type: "TEMPORARY",
						},
					],
				}
			);
		}
		if (url.startsWith("/api/live/stream-keys/unassign")) {
			return { encodingId: ENCODING_ID, unassigned: true };
		}
		if (url.startsWith("/api/live/dns-mappings?")) {
			return {
				totalCount: 1,
				items: [
					{
						id: "dns-1",
						subdomain: "studio-a",
						hostname: "studio-a.live.bitmovin.com",
						ip: "203.0.113.5",
						encodingId: ENCODING_ID,
					},
				],
			};
		}
		if (url.includes(`/standby-pools/${POOL_ID}/encodings`)) {
			return {
				totalCount: 1,
				items: [
					{
						id: "pool-enc-1",
						encodingId: ENCODING_ID,
						status: "ACQUIRED",
						createdAt: "2026-08-06T10:00:00Z",
					},
				],
			};
		}
		if (url.includes(`/standby-pools/${POOL_ID}/logs`)) {
			return {
				totalCount: 1,
				items: [
					{
						id: "log-1",
						eventType: "ERROR",
						message: "Encoding failed to prepare",
						details: "quota exceeded",
						createdAt: "2026-08-06T10:05:00Z",
					},
				],
			};
		}
		if (url.includes(`/standby-pools/${POOL_ID}/actions`)) {
			return {
				poolId: POOL_ID,
				action: "acquire",
				encoding: {
					id: "pool-enc-2",
					encodingId: ENCODING_ID,
					status: "ACQUIRED",
					ingestPoints: [
						{
							streamBaseUrl: "rtmps://live.bitmovin.com/live",
							streamKey: POOL_STREAM_KEY,
						},
					],
					manifests: [
						{
							url: "https://cdn.example.com/live/master.m3u8",
							manifestId: "man-1",
							type: "HLS",
						},
					],
				},
			};
		}
		if (url.includes(`/standby-pools/${POOL_ID}?`)) {
			return {
				id: POOL_ID,
				name: "breaking-news",
				targetPoolSize: 3,
				encodingTemplate: "dGVtcGxhdGU=",
				encodingTemplateText: "encodings:\n  - name: standby-live\n",
			};
		}
		if (url.startsWith("/api/live/standby-pools")) {
			if (method === "POST") {
				return { id: POOL_ID, name: "breaking-news" };
			}
			return {
				totalCount: 1,
				items: [
					{
						id: POOL_ID,
						name: "breaking-news",
						targetPoolSize: 3,
						readyEncodings: 2,
						preparingEncodings: 1,
						errorEncodings: 0,
						poolStatus: "HEALTHY",
						encodingTemplateName: "live-1080p",
					},
				],
			};
		}
		throw new Error(`unexpected apiFetch: ${method} ${url}`);
	});
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("Settings → Live: stream keys (default tab)", () => {
	it("shows status/type chips, the copyable key value and the assigned encoding", async () => {
		mockApi();
		wrap(<LiveSettingsClient />);

		expect(await screen.findByText("studio-a")).toBeInTheDocument();
		expect(screen.getByText("ASSIGNED")).toBeInTheDocument();
		expect(screen.getByText("UNASSIGNED")).toBeInTheDocument();
		expect(screen.getByText("RESERVED")).toBeInTheDocument();
		// "TEMPORARY" is also named in the explanatory copy above the list.
		expect(screen.getAllByText("TEMPORARY").length).toBeGreaterThanOrEqual(1);
		// The value is displayed via the copyable-id affordance (ledgered exception).
		expect(
			screen.getByRole("button", {
				name: `Copy stream key: ${STREAM_KEY}`,
			}),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: ENCODING_ID })).toBeInTheDocument();
	});

	it("unassigns the encoding behind an ASSIGNED key", async () => {
		mockApi();
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("studio-a");

		await user.click(screen.getByRole("button", { name: "Unassign" }));
		await waitFor(() => {
			const call = apiFetch.mock.calls.find((c) =>
				String(c[0]).includes("/stream-keys/unassign"),
			);
			expect(call).toBeDefined();
			const body = JSON.parse((call?.[1] as { body: string }).body) as {
				encodingId: string;
			};
			expect(body.encodingId).toBe(ENCODING_ID);
		});
	});

	it("Unassign by encoding picks from the encodings that actually hold keys", async () => {
		mockApi({
			streamKeys: {
				totalCount: 2,
				items: [
					{
						id: "key-1",
						name: "studio-a",
						status: "ASSIGNED",
						type: "RESERVED",
						assignedEncodingId: ENCODING_ID,
					},
					{
						id: "key-3",
						name: "pool-key",
						status: "ASSIGNED",
						type: "TEMPORARY",
						// An encoding with no LiveChannel row :
						// only the key list knows about it.
						assignedEncodingId: FOREIGN_ENCODING_ID,
					},
				],
			},
		});
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("studio-a");

		await user.click(
			screen.getByRole("button", { name: "Unassign by encoding" }),
		);
		const dialog = screen.getByRole("dialog");
		// The managed channel comes from our own rows (name + status);
		// the pool-held encoding comes from the key list already on screen.
		expect(
			await within(dialog).findByRole("radio", { name: /studio-a-channel/ }),
		).toBeInTheDocument();
		await user.click(
			within(dialog).getByRole("radio", { name: /Holds pool-key/ }),
		);
		expect(within(dialog).getByLabelText("Encoding id")).toHaveValue(
			FOREIGN_ENCODING_ID,
		);

		await user.click(within(dialog).getByRole("button", { name: "Unassign" }));
		await waitFor(() => {
			const call = apiFetch.mock.calls.find((c) =>
				String(c[0]).includes("/stream-keys/unassign"),
			);
			expect(call).toBeDefined();
			const body = JSON.parse((call?.[1] as { body: string }).body) as {
				encodingId: string;
			};
			expect(body.encodingId).toBe(FOREIGN_ENCODING_ID);
		});
	});

	it("Unassign by encoding keeps the key-derived encodings when the channel list fails", async () => {
		mockApi({
			channelsFail: true,
			streamKeys: {
				totalCount: 1,
				items: [
					{
						id: "key-3",
						name: "pool-key",
						status: "ASSIGNED",
						type: "TEMPORARY",
						assignedEncodingId: FOREIGN_ENCODING_ID,
					},
				],
			},
		});
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("pool-key");

		await user.click(
			screen.getByRole("button", { name: "Unassign by encoding" }),
		);
		const dialog = screen.getByRole("dialog");
		// The channels query is dead and says so — but the stream-key list is an
		// INDEPENDENT query, still on screen, and still the only source that
		// knows this encoding holds a key. Its candidate must outlive the other
		// list's failure, or "a standby-pool encoding is one click" is false
		// exactly when the operator needs it most.
		expect(
			await within(dialog).findByText(
				/Could not list this app's live channels .* — paste an id below/,
			),
		).toBeInTheDocument();
		await user.click(
			within(dialog).getByRole("radio", { name: /Holds pool-key/ }),
		);
		expect(within(dialog).getByLabelText("Encoding id")).toHaveValue(
			FOREIGN_ENCODING_ID,
		);

		await user.click(within(dialog).getByRole("button", { name: "Unassign" }));
		await waitFor(() => {
			const call = apiFetch.mock.calls.find((c) =>
				String(c[0]).includes("/stream-keys/unassign"),
			);
			expect(call).toBeDefined();
			const body = JSON.parse((call?.[1] as { body: string }).body) as {
				encodingId: string;
			};
			expect(body.encodingId).toBe(FOREIGN_ENCODING_ID);
		});
	});

	it("Unassign by encoding still accepts a pasted id outside every list", async () => {
		mockApi({ channelsFail: true });
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("studio-a");

		await user.click(
			screen.getByRole("button", { name: "Unassign by encoding" }),
		);
		const dialog = screen.getByRole("dialog");
		expect(
			await within(dialog).findByText(
				/Could not list this app's live channels .* — paste an id below/,
			),
		).toBeInTheDocument();

		await user.type(
			within(dialog).getByLabelText("Encoding id"),
			FOREIGN_ENCODING_ID,
		);
		await user.click(within(dialog).getByRole("button", { name: "Unassign" }));
		await waitFor(() => {
			const call = apiFetch.mock.calls.find((c) =>
				String(c[0]).includes("/stream-keys/unassign"),
			);
			expect(call).toBeDefined();
			const body = JSON.parse((call?.[1] as { body: string }).body) as {
				encodingId: string;
			};
			expect(body.encodingId).toBe(FOREIGN_ENCODING_ID);
		});
	});

	it("reserves a Bitmovin-generated key when the value is left blank", async () => {
		mockApi();
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("studio-a");

		await user.click(screen.getByRole("button", { name: /Reserve key/ }));
		await user.type(screen.getByLabelText("Name (optional)"), "studio-b");
		await user.click(screen.getByRole("button", { name: "Reserve key" }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]) === "/api/live/stream-keys" &&
					(c[1] as { method?: string } | undefined)?.method === "POST",
			);
			expect(call).toBeDefined();
			const body = JSON.parse((call?.[1] as { body: string }).body) as {
				streamKey: Record<string, unknown>;
			};
			// No `value` key at all — Bitmovin generates a secure random one.
			expect(body.streamKey).toEqual({ name: "studio-b", type: "RESERVED" });
		});
	});

	it("rejects a too-short manual key value client-side", async () => {
		mockApi();
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("studio-a");

		await user.click(screen.getByRole("button", { name: /Reserve key/ }));
		await user.type(screen.getByLabelText("Value (optional)"), "abc");
		await user.click(screen.getByRole("button", { name: "Reserve key" }));

		expect(
			await screen.findByText(/at least 8 characters/),
		).toBeInTheDocument();
	});
});

describe("Settings → Live: DNS mappings tab", () => {
	it("lists hostnames and requires an encoding id to create one", async () => {
		mockApi();
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("studio-a");

		await user.click(screen.getByRole("tab", { name: "DNS mappings" }));
		// Row label + CopyableId → two nodes with the hostname.
		expect(
			await screen.findAllByText("studio-a.live.bitmovin.com"),
		).toHaveLength(2);

		await user.click(screen.getByRole("button", { name: /Add mapping/ }));
		await user.type(screen.getByLabelText("Subdomain"), "studio-b");
		await user.click(screen.getByRole("button", { name: "Add mapping" }));
		// encodingId is blank → client-side rejection, no POST.
		const dialog = screen.getByRole("dialog");
		expect(
			await within(dialog).findByText(/must be a UUID/),
		).toBeInTheDocument();
	});

	it("picks the encoding from this app's own live channels", async () => {
		mockApi();
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("studio-a");
		await user.click(screen.getByRole("tab", { name: "DNS mappings" }));
		await user.click(
			await screen.findByRole("button", { name: /Add mapping/ }),
		);

		const dialog = screen.getByRole("dialog");
		// Channel NAME + status chip, not a bare UUID; a channel with no
		// bitmovinEncodingId yet is not offered at all.
		const channelRadio = await within(dialog).findByRole("radio", {
			name: /studio-a-channel/,
		});
		expect(
			within(dialog).queryByRole("radio", { name: /never-provisioned/ }),
		).not.toBeInTheDocument();

		await user.click(channelRadio);
		expect(within(dialog).getByLabelText("Encoding id")).toHaveValue(
			ENCODING_ID,
		);
		await user.type(within(dialog).getByLabelText("Subdomain"), "studio-b");
		await user.click(
			within(dialog).getByRole("button", { name: "Add mapping" }),
		);

		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]) === "/api/live/dns-mappings" &&
					(c[1] as { method?: string } | undefined)?.method === "POST",
			);
			expect(call).toBeDefined();
			const body = JSON.parse((call?.[1] as { body: string }).body) as {
				dnsMapping: { encodingId: string; subdomain: string };
			};
			expect(body.dnsMapping).toEqual({
				encodingId: ENCODING_ID,
				subdomain: "studio-b",
			});
		});
	});

	it("degrades to free text when the channel list fails, and still submits a pasted id", async () => {
		mockApi({ channelsFail: true });
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("studio-a");
		await user.click(screen.getByRole("tab", { name: "DNS mappings" }));
		await user.click(
			await screen.findByRole("button", { name: /Add mapping/ }),
		);

		const dialog = screen.getByRole("dialog");
		expect(
			await within(dialog).findByText(
				/Could not list this app's live channels .* — paste an id below/,
			),
		).toBeInTheDocument();
		expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);

		await user.type(
			within(dialog).getByLabelText("Encoding id"),
			FOREIGN_ENCODING_ID,
		);
		await user.type(within(dialog).getByLabelText("Subdomain"), "studio-c");
		await user.click(
			within(dialog).getByRole("button", { name: "Add mapping" }),
		);

		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]) === "/api/live/dns-mappings" &&
					(c[1] as { method?: string } | undefined)?.method === "POST",
			);
			expect(call).toBeDefined();
			const body = JSON.parse((call?.[1] as { body: string }).body) as {
				dnsMapping: { encodingId: string };
			};
			expect(body.dnsMapping.encodingId).toBe(FOREIGN_ENCODING_ID);
		});
	});

	it("rejects an uppercase subdomain", async () => {
		mockApi();
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("studio-a");
		await user.click(screen.getByRole("tab", { name: "DNS mappings" }));
		await user.click(
			await screen.findByRole("button", { name: /Add mapping/ }),
		);

		await user.type(screen.getByLabelText("Encoding id"), ENCODING_ID);
		await user.type(screen.getByLabelText("Subdomain"), "Studio-B");
		await user.click(screen.getByRole("button", { name: "Add mapping" }));
		// Scoped to the dialog: the same wording also lives in the panel's ⓘ text.
		expect(
			await within(screen.getByRole("dialog")).findByText(
				/lowercase letters, digits and dashes/,
			),
		).toBeInTheDocument();
	});
});

describe("Settings → Live: standby pools tab", () => {
	it("lists pools with ready/preparing/error counts and the poolStatus chip", async () => {
		mockApi();
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("studio-a");

		await user.click(screen.getByRole("tab", { name: "Standby pools" }));
		expect(await screen.findByText("breaking-news")).toBeInTheDocument();
		expect(screen.getByText("HEALTHY")).toBeInTheDocument();
		expect(
			screen.getByText(/2 ready · 1 preparing · 0 error · target 3/),
		).toBeInTheDocument();
		// The C6 exception is disclosed rather than faking pagination.
		expect(screen.getByText(/takes no paging parameters/)).toBeInTheDocument();
	});

	it("notes that the create form base64-encodes the template on submit", async () => {
		mockApi();
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("studio-a");
		await user.click(screen.getByRole("tab", { name: "Standby pools" }));
		await user.click(
			await screen.findByRole("button", { name: /Create pool/ }),
		);

		await user.click(
			screen.getByRole("button", {
				name: "Encoding template — more information",
			}),
		);
		expect(screen.getByText(/base64-encoded on submit/)).toBeInTheDocument();
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("note")).toBeNull();
		expect(screen.getByRole("dialog")).toBeVisible();
		// Missing name + template → client-side rejection, no POST.
		await user.click(screen.getByRole("button", { name: "Create pool" }));
		expect(
			await screen.findByText(/encodingTemplate is required/),
		).toBeInTheDocument();
	});

	it("opens the detail dialog with encodings, logs tail and the decoded template", async () => {
		mockApi();
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("studio-a");
		await user.click(screen.getByRole("tab", { name: "Standby pools" }));
		await user.click(await screen.findByRole("button", { name: "Details" }));

		expect(await screen.findByText("ACQUIRED")).toBeInTheDocument();
		expect(screen.getByText("Encoding failed to prepare")).toBeInTheDocument();
		expect(screen.getByText("quota exceeded")).toBeInTheDocument();
		expect(screen.getByText(/- name: standby-live/)).toBeInTheDocument();
	});

	it("Acquire surfaces the ingest points and manifest URLs copyably", async () => {
		mockApi();
		const user = userEvent.setup();
		wrap(<LiveSettingsClient />);
		await screen.findByText("studio-a");
		await user.click(screen.getByRole("tab", { name: "Standby pools" }));
		await user.click(await screen.findByRole("button", { name: "Details" }));
		await user.click(
			await screen.findByRole("button", { name: "Acquire encoding" }),
		);

		expect(await screen.findByText("Acquired encoding")).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: "Copy stream URL: rtmps://live.bitmovin.com/live",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: `Copy stream key: ${POOL_STREAM_KEY}`,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: "Copy manifest URL: https://cdn.example.com/live/master.m3u8",
			}),
		).toBeInTheDocument();
		// Adoption is out of scope and said so (in the banner, not only the ⓘ text).
		expect(
			within(screen.getByRole("dialog")).getByText(
				/managed channel in this app is not built yet/,
			),
		).toBeInTheDocument();

		const acquireCall = apiFetch.mock.calls.find((c) =>
			String(c[0]).includes("/actions"),
		);
		const body = JSON.parse((acquireCall?.[1] as { body: string }).body) as {
			action: string;
		};
		expect(body.action).toBe("acquire");
	});
});

/**
 * The live settings tabs were the screens the owner named as still English. The
 * literals here are deliberately hardcoded rather than read back through `t`:
 * a lookup would pass against any catalogue, including an English one.
 */
describe("Settings → Live — Japanese", () => {
	it("renders the stream-key tab intro and table copy in Japanese", async () => {
		mockApi();
		wrap(<LiveSettingsClient />, "ja");
		await userEvent.click(
			await screen.findByRole("button", { name: "「ストリームキー」の説明" }),
		);
		expect(
			await screen.findByText(/予約済みキーは複数のライブエンコーディング/),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/A reserved key can be re-used/),
		).not.toBeInTheDocument();
	});
});
