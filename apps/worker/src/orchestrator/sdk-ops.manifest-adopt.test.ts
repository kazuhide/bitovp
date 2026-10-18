import type { AuditEntry } from "@bitovp/db";

// The recorder relaxes `actor` : ops do not name it, make-sdk does.
type RecordedEntry = Omit<AuditEntry, "actor"> & { actor?: string | null };

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Adopt-or-create for manifest ROOTS : a create whose response was
 * lost re-POSTs on resume, and until this PR only HLS looked before leaping —
 * a resumed DASH/Smooth manifest step orphaned the first manifest (the #163
 * review's asymmetry). Identity is name + (outputId, outputPath); a FAILED
 * lookup must create rather than fail the step.
 *
 * HLS was NEVER untested — `retrying-fetch.test.ts` has carried a 7-test
 * reconciliation suite (including "adopts after a lost response — the exact
 * failure seen in production") since the feature landed. An earlier revision
 * of this docblock claimed otherwise because a grep for phrases these tests do
 * not contain returned nothing (review of PR #164, I1 — and not knowing test
 * 394 existed is what hid the third discipline part, I2). That suite is the
 * REGRESSION NET for routing HLS through the shared scanner; this file covers
 * DASH/Smooth and the paging pin on the survivor.
 */

const api = {
	hlsList: vi.fn(),
	hlsCreate: vi.fn(),
	hlsDefaultCreate: vi.fn(),
	dashList: vi.fn(),
	dashCreate: vi.fn(),
	dashDefaultCreate: vi.fn(),
	smoothList: vi.fn(),
	smoothCreate: vi.fn(),
};

vi.mock("@bitmovin/api-sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bitmovin/api-sdk")>();
	class FakeBitmovinApi {
		encoding = {
			manifests: {
				hls: {
					list: api.hlsList,
					create: api.hlsCreate,
					default: { create: api.hlsDefaultCreate },
				},
				dash: {
					list: api.dashList,
					create: api.dashCreate,
					default: { create: api.dashDefaultCreate },
				},
				smooth: { list: api.smoothList, create: api.smoothCreate },
			},
		};
	}
	return { ...actual, default: FakeBitmovinApi };
});

import { createBitmovinSdkOps } from "./sdk-ops";

function setup() {
	const audits: RecordedEntry[] = [];
	const ops = createBitmovinSdkOps(
		{ apiKey: "test-key", tenantOrgId: null, bitmovinAccountId: "acct-1" },
		async (entry) => {
			audits.push(entry);
		},
	);
	return { ops, audits };
}

const DEST = { outputId: "out-1", outputPath: "vod/job/manifests/" };

beforeEach(() => {
	vi.clearAllMocks();
	for (const list of [api.hlsList, api.dashList, api.smoothList]) {
		list.mockResolvedValue({ items: [] });
	}
	api.hlsCreate.mockResolvedValue({ id: "hls-new" });
	api.hlsDefaultCreate.mockResolvedValue({ id: "hls-default-new" });
	api.dashCreate.mockResolvedValue({ id: "dash-new" });
	api.dashDefaultCreate.mockResolvedValue({ id: "dash-default-new" });
	api.smoothCreate.mockResolvedValue({ id: "smooth-new" });
});

describe("DEFAULT manifests adopt by ENCODING ID — the S6 rule", () => {
	it("strict live-to-VOD lookup fails closed when listing is unavailable", async () => {
		const { ops } = setup();
		api.hlsList.mockRejectedValue(new Error("manifest list unavailable"));
		await expect(
			ops.createDefaultHlsManifest({
				encodingId: "enc-live-2",
				manifestName: "stream.m3u8",
				name: "vod hls",
				destination: DEST,
				strictIdentity: true,
			}),
		).rejects.toThrow(/manifest list unavailable/);
		expect(api.hlsDefaultCreate).not.toHaveBeenCalled();
	});

	it("strict live-to-VOD lookup rejects duplicate identity matches", async () => {
		const { ops } = setup();
		api.hlsList.mockResolvedValue({
			items: [
				{ id: "hlsd-one", manifestName: "stream.m3u8", outputs: [DEST] },
				{ id: "hlsd-two", manifestName: "stream.m3u8", outputs: [DEST] },
			],
		});
		await expect(
			ops.createDefaultHlsManifest({
				encodingId: "enc-live-2",
				manifestName: "stream.m3u8",
				name: "vod hls",
				destination: DEST,
				strictIdentity: true,
			}),
		).rejects.toThrow(/ambiguous.*2 matches/i);
		expect(api.hlsDefaultCreate).not.toHaveBeenCalled();
	});

	it("a delivery that does not own the durable intent may adopt but never POST", async () => {
		const { ops } = setup();
		await expect(
			ops.createDefaultHlsManifest({
				encodingId: "enc-live-2",
				manifestName: "stream.m3u8",
				name: "vod hls",
				destination: DEST,
				strictIdentity: true,
				allowCreate: false,
			}),
		).rejects.toThrow(/does not own its create intent/);
		expect(api.hlsDefaultCreate).not.toHaveBeenCalled();

		api.hlsList.mockResolvedValue({
			items: [
				{ id: "hls-existing", manifestName: "stream.m3u8", outputs: [DEST] },
			],
		});
		await expect(
			ops.createDefaultHlsManifest({
				encodingId: "enc-live-2",
				manifestName: "stream.m3u8",
				name: "vod hls",
				destination: DEST,
				strictIdentity: true,
				allowCreate: false,
			}),
		).resolves.toBe("hls-existing");
		expect(api.hlsDefaultCreate).not.toHaveBeenCalled();
	});

	it("HLS: adopts when encodingId + name + destination match, without POSTing", async () => {
		const { ops, audits } = setup();
		api.hlsList.mockResolvedValue({
			items: [{ id: "hlsd-old", manifestName: "stream.m3u8", outputs: [DEST] }],
		});
		const created = await ops.createDefaultHlsManifest({
			encodingId: "enc-live-2",
			manifestName: "stream.m3u8",
			name: "vod hls",
			destination: DEST,
		});
		expect(created).toBe("hlsd-old");
		expect(api.hlsDefaultCreate).not.toHaveBeenCalled();
		// THE S6 pin: the list is scoped server-side to THIS encoding. Without
		// this filter, the second recording of a channel (same per-CHANNEL
		// output, same default name) would adopt the FIRST recording's
		// manifest — the exact wrong artefact S6 forbids.
		expect(api.hlsList).toHaveBeenCalledWith(
			expect.objectContaining({ encodingId: "enc-live-2" }),
		);
		const adoptRow = audits.find(
			(entry) =>
				(entry.request as { phase?: string })?.phase === "pre" &&
				(entry.request as { encodingId?: string })?.encodingId === "enc-live-2",
		);
		expect(adoptRow, JSON.stringify(audits)).toBeDefined();
	});

	it("HLS: a re-run to a DIFFERENT path creates fresh — destination narrows within the encoding", async () => {
		const { ops } = setup();
		api.hlsList.mockResolvedValue({
			items: [
				{
					id: "hlsd-pathA",
					manifestName: "stream.m3u8",
					outputs: [{ outputId: "out-1", outputPath: "channel/vod-A/" }],
				},
			],
		});
		const created = await ops.createDefaultHlsManifest({
			encodingId: "enc-live-2",
			manifestName: "stream.m3u8",
			name: "vod hls",
			destination: { outputId: "out-1", outputPath: "channel/vod-B/" },
		});
		expect(created).toBe("hls-default-new");
		expect(api.hlsDefaultCreate).toHaveBeenCalledTimes(1);
	});

	it("HLS: create rejects, the manifest exists → adopted (the OBSERVED real failure)", async () => {
		const { ops } = setup();
		api.hlsDefaultCreate.mockRejectedValue(new Error("Premature close"));
		api.hlsList.mockResolvedValueOnce({ items: [] }).mockResolvedValue({
			items: [
				{ id: "hlsd-lost", manifestName: "stream.m3u8", outputs: [DEST] },
			],
		});
		const created = await ops.createDefaultHlsManifest({
			encodingId: "enc-live-2",
			manifestName: "stream.m3u8",
			name: "vod hls",
			destination: DEST,
		});
		expect(created).toBe("hlsd-lost");
	});

	it("DASH: a re-run to a DIFFERENT path creates fresh — the matcher is a separate lambda and must be pinned separately", async () => {
		// Workflow review of PR #173, M7: the DASH matcher is hand-copied, so
		// it could regress to name-only while HLS's pin stays green — the
		// wrong-artefact class S6 exists for.
		const { ops } = setup();
		api.dashList.mockResolvedValue({
			items: [
				{
					id: "dashd-pathA",
					manifestName: "stream.mpd",
					outputs: [{ outputId: "out-1", outputPath: "channel/vod-A/" }],
				},
			],
		});
		const created = await ops.createDefaultDashManifest({
			encodingId: "enc-live-2",
			manifestName: "stream.mpd",
			name: "vod dash",
			destination: { outputId: "out-1", outputPath: "channel/vod-B/" },
		});
		expect(created).toBe("dash-default-new");
		expect(api.dashDefaultCreate).toHaveBeenCalledTimes(1);
	});

	it("DASH: adopts by encodingId + name + destination, filter pinned", async () => {
		const { ops } = setup();
		api.dashList.mockResolvedValue({
			items: [{ id: "dashd-old", manifestName: "stream.mpd", outputs: [DEST] }],
		});
		const created = await ops.createDefaultDashManifest({
			encodingId: "enc-live-2",
			manifestName: "stream.mpd",
			name: "vod dash",
			destination: DEST,
		});
		expect(created).toBe("dashd-old");
		expect(api.dashDefaultCreate).not.toHaveBeenCalled();
		expect(api.dashList).toHaveBeenCalledWith(
			expect.objectContaining({ encodingId: "enc-live-2" }),
		);
	});
});

describe("DASH manifest adopt-or-create", () => {
	it("adopts an existing manifest matching name AND output, without POSTing", async () => {
		const { ops, audits } = setup();
		api.dashList.mockResolvedValue({
			items: [{ id: "dash-old", manifestName: "stream.mpd", outputs: [DEST] }],
		});
		const created = await ops.createDashManifest({
			manifestName: "stream.mpd",
			name: "dash",
			destination: DEST,
		});
		expect(created).toBe("dash-old");
		expect(api.dashCreate).not.toHaveBeenCalled();
		// The C7 trail is PINNED, not just present: deleting the auditAdopt call
		// passed all 766 worker tests (review of PR #164, G1 — its own M8), which
		// is exactly how I4's zero-trace state would silently return.
		const adoptRow = audits.find(
			(entry) =>
				entry.method === "GET" &&
				entry.path === "/encoding/manifests/dash" &&
				(entry.request as { phase?: string })?.phase === "pre",
		);
		expect(adoptRow, JSON.stringify(audits)).toBeDefined();
		expect((adoptRow?.response as { id?: string })?.id).toBe("dash-old");
	});

	it("creates when the name matches but the OUTPUT does not — identity is both", async () => {
		const { ops } = setup();
		api.dashList.mockResolvedValue({
			items: [
				{
					id: "dash-other",
					manifestName: "stream.mpd",
					outputs: [{ outputId: "out-1", outputPath: "other/place/" }],
				},
			],
		});
		const created = await ops.createDashManifest({
			manifestName: "stream.mpd",
			name: "dash",
			destination: DEST,
		});
		expect(created).toBe("dash-new");
		expect(api.dashCreate).toHaveBeenCalledTimes(1);
	});

	it("creates when the lookup THROWS — a failed lookup must never fail the step", async () => {
		const { ops } = setup();
		api.dashList.mockRejectedValue(new Error("list down"));
		const created = await ops.createDashManifest({
			manifestName: "stream.mpd",
			name: "dash",
			destination: DEST,
		});
		expect(created).toBe("dash-new");
	});
});

describe("Smooth manifest adopt-or-create", () => {
	it("adopts by BOTH manifest names + output", async () => {
		const { ops } = setup();
		api.smoothList.mockResolvedValue({
			items: [
				{
					id: "smooth-old",
					serverManifestName: "stream.ism",
					clientManifestName: "stream.ismc",
					outputs: [DEST],
				},
			],
		});
		const created = await ops.createSmoothManifest({
			serverManifestName: "stream.ism",
			clientManifestName: "stream.ismc",
			name: "smooth",
			destination: DEST,
		});
		expect(created).toBe("smooth-old");
		expect(api.smoothCreate).not.toHaveBeenCalled();
	});

	it("creates when only the CLIENT name differs — identity is both names", async () => {
		// Review S1: serverManifestName alone would adopt a manifest whose .ismc
		// differs. Cheap to include, removes the question.
		const { ops } = setup();
		api.smoothList.mockResolvedValue({
			items: [
				{
					id: "smooth-other",
					serverManifestName: "stream.ism",
					clientManifestName: "OTHER.ismc",
					outputs: [DEST],
				},
			],
		});
		const created = await ops.createSmoothManifest({
			serverManifestName: "stream.ism",
			clientManifestName: "stream.ismc",
			name: "smooth",
			destination: DEST,
		});
		expect(created).toBe("smooth-new");
	});
});

describe("the third discipline part — a failed CREATE re-looks and adopts", () => {
	it("DASH: create rejects, the manifest exists server-side → adopted, not failed", async () => {
		// The production failure mode verbatim ("each attempt succeeds server-side
		// and loses its answer"): the first port replicated only adopt-before and
		// lookup-never-fails; THIS part was the one that motivated the whole
		// feature, and its absence failed the job with two orphans where HLS
		// proceeded (review of PR #164, I2).
		const { ops } = setup();
		api.dashCreate.mockRejectedValue(new Error("Premature close"));
		api.dashList
			.mockResolvedValueOnce({ items: [] }) // pre-create lookup: nothing yet
			.mockResolvedValue({
				items: [
					{ id: "dash-lost", manifestName: "stream.mpd", outputs: [DEST] },
				],
			});
		const created = await ops.createDashManifest({
			manifestName: "stream.mpd",
			name: "dash",
			destination: DEST,
		});
		expect(created).toBe("dash-lost");
	});

	it("Smooth: create rejects, the manifest exists server-side → adopted", async () => {
		// Structurally protected via the shared helper (Smooth cannot regress on
		// part 3 without breaking DASH's test) — pinned anyway so the claim
		// "per-family pins" is measured, not argued (review of PR #164, G2).
		const { ops } = setup();
		api.smoothCreate.mockRejectedValue(new Error("Premature close"));
		api.smoothList.mockResolvedValueOnce({ items: [] }).mockResolvedValue({
			items: [
				{
					id: "smooth-lost",
					serverManifestName: "stream.ism",
					clientManifestName: "stream.ismc",
					outputs: [DEST],
				},
			],
		});
		const created = await ops.createSmoothManifest({
			serverManifestName: "stream.ism",
			clientManifestName: "stream.ismc",
			name: "smooth",
			destination: DEST,
		});
		expect(created).toBe("smooth-lost");
	});

	it("DASH: create rejects and NOTHING exists → the original error is rethrown", async () => {
		const { ops } = setup();
		api.dashCreate.mockRejectedValue(new Error("boom"));
		api.dashList.mockResolvedValue({ items: [] });
		await expect(
			ops.createDashManifest({
				manifestName: "stream.mpd",
				name: "dash",
				destination: DEST,
			}),
		).rejects.toThrow("boom");
	});
});

describe("HLS through the SHARED scanner — the paging pin now guards the survivor", () => {
	it("adopts by manifestName + output", async () => {
		const { ops } = setup();
		api.hlsList.mockResolvedValue({
			items: [{ id: "hls-old", manifestName: "master.m3u8", outputs: [DEST] }],
		});
		const created = await ops.createHlsManifest({
			manifestName: "master.m3u8",
			name: "hls",
			destination: DEST,
		});
		expect(created).toBe("hls-old");
		expect(api.hlsCreate).not.toHaveBeenCalled();
	});

	it("keeps paging past a FULL page — the cap is pages, not one page", async () => {
		// M5's kill: MANIFEST_SCAN_PAGES → 1 survived because no test ever served
		// a full 100-item page. This also pins the limit/short-page-cutoff
		// coupling that made M4 dangerous (review of PR #164).
		const { ops } = setup();
		const filler = Array.from({ length: 100 }, (_, i) => ({
			id: `hls-${i}`,
			manifestName: "other.m3u8",
			outputs: [],
		}));
		api.hlsList.mockResolvedValueOnce({ items: filler }).mockResolvedValueOnce({
			items: [
				{ id: "hls-page2", manifestName: "master.m3u8", outputs: [DEST] },
			],
		});
		const created = await ops.createHlsManifest({
			manifestName: "master.m3u8",
			name: "hls",
			destination: DEST,
		});
		expect(created).toBe("hls-page2");
		expect(api.hlsList).toHaveBeenCalledTimes(2);
		expect(api.hlsList).toHaveBeenLastCalledWith(
			expect.objectContaining({ offset: 100 }),
		);
	});

	it("pages newest-first and stops at a short page", async () => {
		const { ops } = setup();
		api.hlsList.mockResolvedValue({ items: [] });
		await ops.createHlsManifest({
			manifestName: "master.m3u8",
			name: "hls",
			destination: DEST,
		});
		expect(api.hlsList).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 100,
				offset: 0,
				sort: "createdAt:DESC",
			}),
		);
		expect(api.hlsList).toHaveBeenCalledTimes(1);
		expect(api.hlsCreate).toHaveBeenCalledTimes(1);
	});
});
