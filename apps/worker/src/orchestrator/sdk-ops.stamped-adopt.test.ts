import type { AuditEntry } from "@bitovp/db";

// The recorder relaxes `actor` : ops do not name it, make-sdk does.
type RecordedEntry = Omit<AuditEntry, "actor"> & { actor?: string | null };

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ADOPTION half of  — stamped resources (encodings, streams,
 * muxings, DRM), beside the manifest suite (`sdk-ops.manifest-adopt.test.ts`).
 *
 * Identity here is the `{"bitovp": {job, step}}` customData the stamping
 * fetch wrote on the lost create — no name+output heuristics, no cross-job
 * collision by construction. The discipline differs from manifests in ONE
 * deliberate way: adopt-BEFORE-create runs only inside the crash window
 * (`stamp.adoptWindow` — the step was left RUNNING by a previous attempt),
 * so the happy path pays zero extra calls; the failed-create-re-look stays
 * unconditional because the stamp rode the failed POST itself.
 *
 * Per-family wiring pins exist because the #164 review's G2 lesson holds:
 * a shared helper being right does not prove each family reached it.
 */

const api = {
	encodingsList: vi.fn(),
	encodingsCreate: vi.fn(),
	encodingsCd: vi.fn(),
	encodingsStop: vi.fn(),
	encodingsDelete: vi.fn(),
	streamsList: vi.fn(),
	streamsCreate: vi.fn(),
	streamsCd: vi.fn(),
	fmp4List: vi.fn(),
	fmp4Create: vi.fn(),
	fmp4Cd: vi.fn(),
	mp4List: vi.fn(),
	mp4Create: vi.fn(),
	mp4Cd: vi.fn(),
	tsList: vi.fn(),
	tsCreate: vi.fn(),
	tsCd: vi.fn(),
	webmList: vi.fn(),
	webmCreate: vi.fn(),
	webmCd: vi.fn(),
	chunkedTextList: vi.fn(),
	chunkedTextCreate: vi.fn(),
	chunkedTextCd: vi.fn(),
	cencFmp4List: vi.fn(),
	cencFmp4Create: vi.fn(),
	cencFmp4Cd: vi.fn(),
	fairplayTsList: vi.fn(),
	fairplayTsCreate: vi.fn(),
	fairplayTsCd: vi.fn(),
};

vi.mock("@bitmovin/api-sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bitmovin/api-sdk")>();
	class FakeBitmovinApi {
		encoding = {
			encodings: {
				list: api.encodingsList,
				create: api.encodingsCreate,
				stop: api.encodingsStop,
				delete: api.encodingsDelete,
				customdata: { get: api.encodingsCd },
				streams: {
					list: api.streamsList,
					create: api.streamsCreate,
					customdata: { get: api.streamsCd },
				},
				muxings: {
					fmp4: {
						list: api.fmp4List,
						create: api.fmp4Create,
						customdata: { get: api.fmp4Cd },
						drm: {
							cenc: {
								list: api.cencFmp4List,
								create: api.cencFmp4Create,
								customdata: { get: api.cencFmp4Cd },
							},
							fairplay: {},
						},
					},
					mp4: {
						list: api.mp4List,
						create: api.mp4Create,
						customdata: { get: api.mp4Cd },
						drm: { cenc: {} },
					},
					ts: {
						list: api.tsList,
						create: api.tsCreate,
						customdata: { get: api.tsCd },
						drm: {
							fairplay: {
								list: api.fairplayTsList,
								create: api.fairplayTsCreate,
								customdata: { get: api.fairplayTsCd },
							},
						},
					},
					webm: {
						list: api.webmList,
						create: api.webmCreate,
						customdata: { get: api.webmCd },
						drm: { cenc: {} },
					},
					chunkedText: {
						list: api.chunkedTextList,
						create: api.chunkedTextCreate,
						customdata: { get: api.chunkedTextCd },
					},
				},
			},
		};
	}
	return { ...actual, default: FakeBitmovinApi };
});

import { createBitmovinSdkOps } from "./sdk-ops";
import { VerificationProviderIdDefinitelyNotPersistedError } from "./stamping-fetch";

const STAMP = { job: "job-1", step: "encoding" };

function setup(opts?: {
	window?: boolean;
	step?: string | undefined;
	stampless?: boolean;
	verification?: boolean;
	rawVerification?: unknown;
	omitEncodingCallback?: boolean;
	recordAudit?: (entry: RecordedEntry) => Promise<void>;
	onEncodingCreated?: (
		providerId: string,
		source: "created" | "adopted",
	) => Promise<"PERSISTED" | "OWNERSHIP_LOST">;
}) {
	const audits: RecordedEntry[] = [];
	const hasRawVerification = opts !== undefined && "rawVerification" in opts;
	const hasVerification = opts?.verification === true || hasRawVerification;
	const ops = createBitmovinSdkOps(
		{
			apiKey: "test-key",
			tenantOrgId: null,
			bitmovinAccountId: "acct-1",
			...(opts?.stampless
				? {}
				: {
						stamp: {
							jobId: STAMP.job,
							currentStep: () =>
								"step" in (opts ?? {}) ? opts?.step : STAMP.step,
							adoptWindow: () => opts?.window ?? true,
							...(hasVerification
								? {
										verification: hasRawVerification
											? (opts?.rawVerification as typeof VERIFICATION)
											: VERIFICATION,
									}
								: {}),
							...(!opts?.omitEncodingCallback && hasVerification
								? {
										onEncodingCreated:
											opts?.onEncodingCreated ??
											(async () => "PERSISTED" as const),
									}
								: opts?.onEncodingCreated
									? { onEncodingCreated: opts.onEncodingCreated }
									: {}),
						},
					}),
		},
		async (entry) => {
			audits.push(entry);
			await opts?.recordAudit?.(entry);
		},
	);
	return { ops, audits };
}

const stamped = (job: string, step: string) => ({
	customData: { bitovp: { job, step } },
});

const VERIFICATION = {
	key: "verify:run-1:scenario-1:VOD_JOB",
	requestSha256: "a".repeat(64),
};

const verificationStamped = (
	job: string,
	step: string,
	verification = VERIFICATION,
) => ({
	customData: { bitovp: { job, step, verification } },
});

const ENCODING_PAYLOAD = {
	name: "job encoding",
	cloudRegion: "AWS_AP_NORTHEAST_1",
	encoderVersion: "STABLE",
	labels: [`verify-key:${VERIFICATION.key}`],
};

const verificationEncodingItem = (id: string) => ({
	id,
	name: ENCODING_PAYLOAD.name,
	labels: [`verify-key:${VERIFICATION.key}`],
});

beforeEach(() => {
	vi.clearAllMocks();
	for (const key of Object.keys(api) as Array<keyof typeof api>) {
		if (key.endsWith("List")) {
			api[key].mockResolvedValue({ items: [] });
		} else if (key.endsWith("Cd")) {
			api[key].mockResolvedValue({ customData: undefined });
		}
	}
	api.encodingsCreate.mockResolvedValue({ id: "enc-new" });
	api.encodingsStop.mockResolvedValue({});
	api.encodingsDelete.mockResolvedValue({});
	api.streamsCreate.mockResolvedValue({ id: "stream-new" });
	api.fmp4Create.mockResolvedValue({ id: "fmp4-new" });
	api.mp4Create.mockResolvedValue({ id: "mp4-new" });
	api.tsCreate.mockResolvedValue({ id: "ts-new" });
	api.webmCreate.mockResolvedValue({ id: "webm-new" });
	api.chunkedTextCreate.mockResolvedValue({ id: "ctext-new" });
	api.cencFmp4Create.mockResolvedValue({ id: "cenc-new" });
	api.fairplayTsCreate.mockResolvedValue({ id: "fp-new" });
});

describe("encoding adopt-or-create in the crash window", () => {
	it("adopts the stamped encoding without POSTing, with a C7 trail", async () => {
		const { ops, audits } = setup({ window: true });
		api.encodingsList.mockResolvedValue({
			items: [{ id: "enc-other" }, { id: "enc-lost" }],
		});
		api.encodingsCd.mockImplementation(async (id: string) =>
			id === "enc-lost"
				? stamped(STAMP.job, STAMP.step)
				: stamped("someone-else", STAMP.step),
		);
		const created = await ops.createEncoding(ENCODING_PAYLOAD);
		expect(created).toBe("enc-lost");
		expect(api.encodingsCreate).not.toHaveBeenCalled();
		// The list is pre-narrowed SERVER-side by the plan's encoding name —
		// the deliberate deviation from 's label-search design (no
		// user-visible field mutated; the SDK's `name` param is an EXACT-match
		// filter, not lucene — review-172 S2).
		expect(api.encodingsList).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "job encoding",
				sort: "createdAt:DESC",
				limit: 100,
				offset: 0,
			}),
		);
		const adoptRow = audits.find(
			(entry) =>
				entry.method === "GET" &&
				entry.path === "/encoding/encodings" &&
				(entry.request as { phase?: string })?.phase === "pre",
		);
		expect(adoptRow, JSON.stringify(audits)).toBeDefined();
		expect((adoptRow?.response as { id?: string })?.id).toBe("enc-lost");
	});

	it("creates when every candidate's stamp mismatches (other job OR other step)", async () => {
		const { ops } = setup({ window: true });
		api.encodingsList.mockResolvedValue({
			items: [{ id: "enc-a" }, { id: "enc-b" }],
		});
		api.encodingsCd.mockImplementation(async (id: string) =>
			id === "enc-a"
				? stamped("job-OTHER", STAMP.step)
				: stamped(STAMP.job, "step-OTHER"),
		);
		expect(await ops.createEncoding(ENCODING_PAYLOAD)).toBe("enc-new");
		expect(api.encodingsCreate).toHaveBeenCalledTimes(1);
	});

	it("outside the window: NO list call at all — the happy path pays nothing", async () => {
		const { ops } = setup({ window: false });
		expect(await ops.createEncoding(ENCODING_PAYLOAD)).toBe("enc-new");
		expect(api.encodingsList).not.toHaveBeenCalled();
		expect(api.encodingsCd).not.toHaveBeenCalled();
	});

	it("with no stamp configured: plain create, no lookup", async () => {
		const { ops } = setup({ stampless: true });
		expect(await ops.createEncoding(ENCODING_PAYLOAD)).toBe("enc-new");
		expect(api.encodingsList).not.toHaveBeenCalled();
	});

	it("a THROWN lookup creates rather than failing the step", async () => {
		const { ops } = setup({ window: true });
		api.encodingsList.mockRejectedValue(new Error("list down"));
		expect(await ops.createEncoding(ENCODING_PAYLOAD)).toBe("enc-new");
	});

	it("a failed candidate customData read skips to the NEXT candidate", async () => {
		const { ops } = setup({ window: true });
		api.encodingsList.mockResolvedValue({
			items: [{ id: "enc-broken" }, { id: "enc-lost" }],
		});
		api.encodingsCd.mockImplementation(async (id: string) => {
			if (id === "enc-broken") {
				throw new Error("cd 500");
			}
			return stamped(STAMP.job, STAMP.step);
		});
		expect(await ops.createEncoding(ENCODING_PAYLOAD)).toBe("enc-lost");
	});

	it("keeps paging past a FULL page of mismatches", async () => {
		const { ops } = setup({ window: true });
		const filler = Array.from({ length: 100 }, (_, i) => ({
			id: `enc-${i}`,
		}));
		api.encodingsList
			.mockResolvedValueOnce({ items: filler })
			.mockResolvedValueOnce({ items: [{ id: "enc-page2" }] });
		api.encodingsCd.mockImplementation(async (id: string) =>
			id === "enc-page2" ? stamped(STAMP.job, STAMP.step) : { customData: {} },
		);
		expect(await ops.createEncoding(ENCODING_PAYLOAD)).toBe("enc-page2");
		expect(api.encodingsList).toHaveBeenLastCalledWith(
			expect.objectContaining({ offset: 100 }),
		);
	});

	it("a SHORT page of mismatches ends the scan in exactly one list call", async () => {
		// review-172 S3 / its M12: without the short-page exit every miss would
		// burn the full page budget. One sub-100 page with no match ⇒ create,
		// after exactly one list.
		const { ops } = setup({ window: true });
		api.encodingsList.mockResolvedValue({
			items: [{ id: "enc-a" }, { id: "enc-b" }],
		});
		api.encodingsCd.mockResolvedValue(stamped("job-OTHER", STAMP.step));
		expect(await ops.createEncoding(ENCODING_PAYLOAD)).toBe("enc-new");
		expect(api.encodingsList).toHaveBeenCalledTimes(1);
	});

	it("stops at the page horizon, says so, and CREATES — never hangs the step", async () => {
		// review-172 S3 / its M11: the horizon is a cost bound, and it must be
		// THE pinned number — five pages, then a visible warning and a create.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { ops } = setup({ window: true });
			const filler = Array.from({ length: 100 }, (_, i) => ({
				id: `enc-${i}`,
			}));
			api.encodingsList.mockResolvedValue({ items: filler });
			api.encodingsCd.mockResolvedValue({ customData: {} });
			expect(await ops.createEncoding(ENCODING_PAYLOAD)).toBe("enc-new");
			expect(api.encodingsList).toHaveBeenCalledTimes(5);
			expect(
				warn.mock.calls.some((call) =>
					String(call[0]).includes("stopped scanning"),
				),
			).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("verification encoding adoption is exact and fail-closed", () => {
	it("refuses verification without its provider-id durability callback", async () => {
		const { ops } = setup({
			window: false,
			verification: true,
			omitEncodingCallback: true,
		});
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
		});
		expect(api.encodingsList).not.toHaveBeenCalled();
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it("refuses a verification callback without validated verification identity", async () => {
		const { ops } = setup({
			window: false,
			onEncodingCreated: async () => "PERSISTED",
		});
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
		});
		expect(api.encodingsCreate).not.toHaveBeenCalled();
		expect(api.encodingsStop).not.toHaveBeenCalled();
		expect(api.encodingsDelete).not.toHaveBeenCalled();
	});

	it.each([
		["empty object", {}],
		["partial pair", { key: VERIFICATION.key }],
		["non-canonical SHA", { ...VERIFICATION, requestSha256: "A".repeat(64) }],
		["non-object", "verification"],
		["null", null],
	])("refuses a malformed runtime verification identity (%s)", async (_case, rawVerification) => {
		const { ops } = setup({ window: false, rawVerification });
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: expect.stringMatching(
				/^VERIFICATION_IDENTITY_(?:INCOMPLETE|INVALID)$/,
			),
		});
		expect(api.encodingsList).not.toHaveBeenCalled();
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it("refuses verification when the current create step is absent", async () => {
		const { ops } = setup({
			window: false,
			step: undefined,
			verification: true,
		});
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
		});
		expect(api.encodingsList).not.toHaveBeenCalled();
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it.each([
		["missing", { ...ENCODING_PAYLOAD, labels: undefined }],
		["wrong", { ...ENCODING_PAYLOAD, labels: ["verify-key:wrong"] }],
	])("refuses a %s provider verification label before lookup or POST", async (_case, payload) => {
		const { ops } = setup({ window: false, verification: true });
		await expect(ops.createEncoding(payload)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
		});
		expect(api.encodingsList).not.toHaveBeenCalled();
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it("adopts only an exact job + step + verification key + canonical SHA marker", async () => {
		const { ops } = setup({ window: true, verification: true });
		api.encodingsList.mockResolvedValue({
			items: [verificationEncodingItem("enc-exact")],
		});
		api.encodingsCd.mockResolvedValue(
			verificationStamped(STAMP.job, STAMP.step),
		);
		expect(await ops.createEncoding(ENCODING_PAYLOAD)).toBe("enc-exact");
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it("skips a same-job sibling step with the shared key+SHA and reaches the exact step", async () => {
		const { ops } = setup({ window: true, verification: true });
		api.encodingsList.mockResolvedValue({
			items: [
				verificationEncodingItem("enc-sibling"),
				verificationEncodingItem("enc-exact"),
			],
		});
		api.encodingsCd.mockImplementation(async (id: string) =>
			id === "enc-sibling"
				? verificationStamped(STAMP.job, "encoding:sibling")
				: verificationStamped(STAMP.job, STAMP.step),
		);
		expect(await ops.createEncoding(ENCODING_PAYLOAD)).toBe("enc-exact");
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it("refuses the shared key+SHA when it is stamped onto a different local job", async () => {
		const { ops } = setup({ window: true, verification: true });
		api.encodingsList.mockResolvedValue({
			items: [verificationEncodingItem("enc-foreign-job")],
		});
		api.encodingsCd.mockResolvedValue(
			verificationStamped("job-OTHER", STAMP.step),
		);
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
		});
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it("refuses CREATE when the same verification key exists with a different SHA", async () => {
		const { ops } = setup({ window: true, verification: true });
		api.encodingsList.mockResolvedValue({
			items: [verificationEncodingItem("enc-conflict")],
		});
		api.encodingsCd.mockResolvedValue(
			verificationStamped(STAMP.job, STAMP.step, {
				...VERIFICATION,
				requestSha256: "f".repeat(64),
			}),
		);
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_SHA_CONFLICT",
		});
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it("refuses CREATE when the exact job + step carries a different verification key", async () => {
		const { ops } = setup({ window: true, verification: true });
		api.encodingsList.mockResolvedValue({
			items: [verificationEncodingItem("enc-wrong-key")],
		});
		api.encodingsCd.mockResolvedValue(
			verificationStamped(STAMP.job, STAMP.step, {
				...VERIFICATION,
				key: "verify:some-other-intent:VOD_JOB",
			}),
		);
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
		});
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it("refuses CREATE when any candidate customData read is unknown", async () => {
		const { ops } = setup({ window: true, verification: true });
		api.encodingsList.mockResolvedValue({
			items: [verificationEncodingItem("enc-unknown")],
		});
		api.encodingsCd.mockRejectedValue(new Error("customData 503"));
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_LOOKUP_UNKNOWN",
		});
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it("refuses an exact customData marker when the provider verification label is absent", async () => {
		const { ops } = setup({ window: true, verification: true });
		api.encodingsList.mockResolvedValue({
			items: [
				{ id: "enc-unlabelled", name: ENCODING_PAYLOAD.name, labels: [] },
			],
		});
		api.encodingsCd.mockResolvedValue(
			verificationStamped(STAMP.job, STAMP.step),
		);
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
		});
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it("refuses CREATE when a resumed verification step finds no provider marker yet", async () => {
		const { ops } = setup({ window: true, verification: true });
		api.encodingsList.mockResolvedValue({ items: [] });
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_ADOPTION_MISS",
		});
		expect(api.encodingsList).toHaveBeenCalledTimes(1);
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it("refuses CREATE at a full scan horizon instead of assuming absence", async () => {
		const { ops } = setup({ window: true, verification: true });
		api.encodingsList.mockResolvedValue({
			items: Array.from({ length: 100 }, (_, i) => ({ id: `enc-${i}` })),
		});
		api.encodingsCd.mockResolvedValue({ customData: {} });
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_LOOKUP_HORIZON",
		});
		expect(api.encodingsList).toHaveBeenCalledTimes(5);
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it("refuses an ambiguous duplicate exact marker instead of choosing the first", async () => {
		const { ops } = setup({ window: true, verification: true });
		api.encodingsList.mockResolvedValue({
			items: [
				verificationEncodingItem("enc-a"),
				verificationEncodingItem("enc-b"),
			],
		});
		api.encodingsCd.mockResolvedValue(
			verificationStamped(STAMP.job, STAMP.step),
		);
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_DUPLICATE",
		});
		expect(api.encodingsCreate).not.toHaveBeenCalled();
	});

	it("does not turn an unknown post-create lookup into a second create or a false success", async () => {
		const { ops } = setup({ window: false, verification: true });
		api.encodingsCreate.mockRejectedValue(new Error("response lost"));
		api.encodingsList.mockRejectedValue(new Error("list unavailable"));
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_LOOKUP_UNKNOWN",
		});
		expect(api.encodingsCreate).toHaveBeenCalledTimes(1);
	});
});

describe("verification encoding id persistence and bounded compensation", () => {
	it("treats an undefined ownership result as lost ownership without compensation", async () => {
		const { ops } = setup({
			window: false,
			verification: true,
			onEncodingCreated: (async () => undefined) as unknown as NonNullable<
				Parameters<typeof setup>[0]
			>["onEncodingCreated"],
		});
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_OWNERSHIP_LOST",
			providerId: "enc-new",
		});
		expect(api.encodingsStop).not.toHaveBeenCalled();
		expect(api.encodingsDelete).not.toHaveBeenCalled();
	});

	it("persists the provider id before a blocked audit recorder can complete", async () => {
		let releaseAudit!: () => void;
		const auditBlocked = new Promise<void>((resolve) => {
			releaseAudit = resolve;
		});
		const order: string[] = [];
		const { ops } = setup({
			window: false,
			verification: true,
			onEncodingCreated: async (id, source) => {
				order.push(`persist:${source}:${id}`);
				return "PERSISTED";
			},
			recordAudit: async () => {
				order.push("audit-started");
				await auditBlocked;
				order.push("audit-finished");
			},
		});
		const pending = ops.createEncoding(ENCODING_PAYLOAD);
		await vi.waitFor(() => {
			expect(order).toEqual(["persist:created:enc-new", "audit-started"]);
		});
		releaseAudit();
		expect(await pending).toBe("enc-new");
		expect(order).toEqual([
			"persist:created:enc-new",
			"audit-started",
			"audit-finished",
		]);
	});

	it("persists the returned provider id before resolving createEncoding", async () => {
		const order: string[] = [];
		api.encodingsCreate.mockImplementation(async () => {
			order.push("provider-created");
			return { id: "enc-new" };
		});
		const { ops } = setup({
			window: false,
			verification: true,
			onEncodingCreated: async (id, source) => {
				order.push(`persist:${source}:${id}`);
				return "PERSISTED";
			},
		});
		expect(await ops.createEncoding(ENCODING_PAYLOAD)).toBe("enc-new");
		expect(order).toEqual(["provider-created", "persist:created:enc-new"]);
	});

	it("attempts stop and delete when a newly-created id cannot be persisted", async () => {
		const { ops } = setup({
			window: false,
			verification: true,
			onEncodingCreated: async () => {
				throw new VerificationProviderIdDefinitelyNotPersistedError();
			},
		});
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_ID_PERSIST_FAILED",
			providerId: "enc-new",
		});
		expect(api.encodingsStop).toHaveBeenCalledWith("enc-new");
		expect(api.encodingsDelete).toHaveBeenCalledWith("enc-new");
	});

	it("still attempts delete when stop compensation fails", async () => {
		api.encodingsStop.mockRejectedValue(new Error("stop unavailable"));
		const { ops } = setup({
			window: false,
			verification: true,
			onEncodingCreated: async () => {
				throw new VerificationProviderIdDefinitelyNotPersistedError();
			},
		});
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_ID_PERSIST_FAILED",
		});
		expect(api.encodingsDelete).toHaveBeenCalledWith("enc-new");
	});

	it("still attempts delete when the SDK stop method throws synchronously", async () => {
		api.encodingsStop.mockImplementation(() => {
			throw new Error("stop exploded before returning a promise");
		});
		const { ops } = setup({
			window: false,
			verification: true,
			onEncodingCreated: async () => {
				throw new VerificationProviderIdDefinitelyNotPersistedError();
			},
		});
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_ID_PERSIST_FAILED",
			compensation: { stop: "FAILED", delete: "SUCCEEDED" },
		});
		expect(api.encodingsDelete).toHaveBeenCalledTimes(1);
		expect(api.encodingsDelete).toHaveBeenCalledWith("enc-new");
	});

	it("bounds a hung stop and still reaches delete compensation", async () => {
		vi.useFakeTimers();
		try {
			api.encodingsStop.mockImplementation(
				() => new Promise<never>(() => undefined),
			);
			const { ops } = setup({
				window: false,
				verification: true,
				onEncodingCreated: async () => {
					throw new VerificationProviderIdDefinitelyNotPersistedError();
				},
			});
			const pending = ops.createEncoding(ENCODING_PAYLOAD);
			const rejected = expect(pending).rejects.toMatchObject({
				code: "VERIFICATION_PROVIDER_ID_PERSIST_FAILED",
				compensation: { stop: "TIMED_OUT", delete: "SUCCEEDED" },
			});
			await vi.advanceTimersByTimeAsync(10_000);
			await rejected;
			expect(api.encodingsDelete).toHaveBeenCalledWith("enc-new");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not delete on an ambiguous commit-after-timeout callback failure", async () => {
		const { ops } = setup({
			window: false,
			verification: true,
			onEncodingCreated: async () => {
				throw Object.assign(new Error("database response timed out"), {
					code: "P1002",
				});
			},
		});
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_ID_PERSIST_FAILED",
			durability: "PERSISTENCE_UNKNOWN",
			message: expect.stringContaining("unknown database commit outcome"),
			compensation: {
				stop: "SKIPPED_UNKNOWN",
				delete: "SKIPPED_UNKNOWN",
			},
		});
		expect(api.encodingsStop).not.toHaveBeenCalled();
		expect(api.encodingsDelete).not.toHaveBeenCalled();
	});

	it("surfaces ownership loss without continuing or compensating a new create", async () => {
		const { ops } = setup({
			window: false,
			verification: true,
			onEncodingCreated: async () => "OWNERSHIP_LOST",
		});
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_OWNERSHIP_LOST",
			providerId: "enc-new",
		});
		expect(api.encodingsStop).not.toHaveBeenCalled();
		expect(api.encodingsDelete).not.toHaveBeenCalled();
	});

	it("surfaces ownership loss without deleting an adopted encoding", async () => {
		const { ops } = setup({
			window: true,
			verification: true,
			onEncodingCreated: async () => "OWNERSHIP_LOST",
		});
		api.encodingsList.mockResolvedValue({
			items: [verificationEncodingItem("enc-adopted")],
		});
		api.encodingsCd.mockResolvedValue(
			verificationStamped(STAMP.job, STAMP.step),
		);
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_OWNERSHIP_LOST",
			providerId: "enc-adopted",
		});
		expect(api.encodingsStop).not.toHaveBeenCalled();
		expect(api.encodingsDelete).not.toHaveBeenCalled();
	});
});

describe("provider-side verification recovery discovery", () => {
	it("rejects a swapped step/name cross-product instead of accepting each field independently", async () => {
		const { ops } = setup({ stampless: true });
		const label = `verify-key:${VERIFICATION.key}`;
		api.encodingsList.mockResolvedValue({
			items: [{ id: "enc-swapped", name: "codec H264", labels: [label] }],
		});
		api.encodingsCd.mockResolvedValue(
			verificationStamped("local-job", "encoding:b"),
		);
		await expect(
			ops.findVerificationEncodings({
				jobId: "local-job",
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
				resources: [
					{ step: "encoding:a", name: "codec H264" },
					{ step: "encoding:b", name: "codec H265" },
				],
			}),
		).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
			ownedCandidateIds: ["enc-swapped"],
		});
	});

	it("never persists a secret-shaped unexpected provider step in audit output", async () => {
		const { ops, audits } = setup({ stampless: true });
		const rawSecret = "sk_live_must_not_reach_audit";
		api.encodingsList.mockResolvedValue({
			items: [
				{
					id: "enc-secret-step",
					name: "codec H264",
					labels: [`verify-key:${VERIFICATION.key}`],
				},
			],
		});
		api.encodingsCd.mockResolvedValue(
			verificationStamped("local-job", rawSecret),
		);
		await expect(
			ops.findVerificationEncodings({
				jobId: "local-job",
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
				resources: [{ step: "encoding:a", name: "codec H264" }],
			}),
		).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
			ownedCandidateIds: ["enc-secret-step"],
		});
		expect(JSON.stringify(audits)).not.toContain(rawSecret);
		expect(audits.at(-1)?.response).toMatchObject({ stepMatches: false });
	});

	it("refuses a provider encoding whose key+SHA marker belongs to another local job", async () => {
		const { ops } = setup({ stampless: true });
		const label = `verify-key:${VERIFICATION.key}`;
		api.encodingsList.mockResolvedValue({
			items: [{ id: "enc-wrong-job", name: "codec H264", labels: [label] }],
		});
		api.encodingsCd.mockResolvedValue(
			verificationStamped("local-job-OTHER", "encoding:a"),
		);
		await expect(
			ops.findVerificationEncodings({
				jobId: "local-job",
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
				resources: [{ step: "encoding:a", name: "codec H264" }],
			}),
		).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
			ownedCandidateIds: ["enc-wrong-job"],
		});
	});

	it.each([
		["customData response", undefined, "VERIFICATION_PROVIDER_LOOKUP_UNKNOWN"],
		[
			"verification marker",
			{ customData: {} },
			"VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
		],
	])("retains an exact-label candidate when its %s is absent", async (_case, customData, code) => {
		const { ops } = setup({ stampless: true });
		const label = `verify-key:${VERIFICATION.key}`;
		api.encodingsList.mockResolvedValue({
			items: [{ id: "enc-no-marker", name: "codec H264", labels: [label] }],
		});
		api.encodingsCd.mockResolvedValue(customData);
		await expect(
			ops.findVerificationEncodings({
				jobId: "local-job",
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
				resources: [{ step: "encoding:a", name: "codec H264" }],
			}),
		).rejects.toMatchObject({
			code,
			ownedCandidateIds: ["enc-no-marker"],
		});
	});

	it("refuses an empty submitted encoding-name set before provider lookup", async () => {
		const { ops } = setup({ stampless: true });
		await expect(
			ops.findVerificationEncodings({
				jobId: "local-job",
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
				resources: [],
			}),
		).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
		});
		expect(api.encodingsList).not.toHaveBeenCalled();
	});

	it("returns every encoding whose name, exact label, key and SHA match", async () => {
		const { ops, audits } = setup({ stampless: true });
		const label = `verify-key:${VERIFICATION.key}`;
		api.encodingsList.mockResolvedValue({
			items: [
				{ id: "enc-v1", name: "codec H264", labels: [label] },
				{ id: "enc-v2", name: "codec H265", labels: [label] },
			],
		});
		api.encodingsCd.mockImplementation(async (id: string) => {
			const exact = verificationStamped(
				"local-job",
				id === "enc-v1" ? "encoding:a" : "encoding:b",
			);
			return {
				customData: {
					...exact.customData,
					opaque: "sk_live_must_not_reach_audit",
				},
			};
		});
		expect(
			await ops.findVerificationEncodings({
				jobId: "local-job",
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
				resources: [
					{ step: "encoding:a", name: "codec H264" },
					{ step: "encoding:b", name: "codec H265" },
				],
			}),
		).toEqual([
			{
				encodingId: "enc-v1",
				jobId: "local-job",
				step: "encoding:a",
				name: "codec H264",
				label,
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
			},
			{
				encodingId: "enc-v2",
				jobId: "local-job",
				step: "encoding:b",
				name: "codec H265",
				label,
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
			},
		]);
		expect(api.encodingsList).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 100,
				offset: 0,
				search: expect.stringContaining("verify-key"),
			}),
		);
		expect(audits.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
			"GET /encoding/encodings",
			"GET /encoding/encodings/enc-v1/customData",
			"GET /encoding/encodings/enc-v2/customData",
		]);
		expect(JSON.stringify(audits)).not.toContain(
			"sk_live_must_not_reach_audit",
		);
		expect(JSON.stringify(audits)).not.toContain("opaque");
	});

	it("retains a proven identity even when a conflicting candidate is listed first", async () => {
		const { ops } = setup({ stampless: true });
		const label = `verify-key:${VERIFICATION.key}`;
		api.encodingsList.mockResolvedValue({
			items: [
				{ id: "enc-conflict", name: "codec H265", labels: [label] },
				{ id: "enc-proven", name: "codec H264", labels: [label] },
			],
		});
		api.encodingsCd.mockImplementation(async (id: string) =>
			id === "enc-proven"
				? verificationStamped("local-job", "encoding:a")
				: verificationStamped("local-job", "encoding:b", {
						...VERIFICATION,
						requestSha256: "f".repeat(64),
					}),
		);
		await expect(
			ops.findVerificationEncodings({
				jobId: "local-job",
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
				resources: [
					{ step: "encoding:a", name: "codec H264" },
					{ step: "encoding:b", name: "codec H265" },
				],
			}),
		).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_SHA_CONFLICT",
			ownedCandidateIds: ["enc-conflict", "enc-proven"],
			provenIdentities: [
				expect.objectContaining({
					encodingId: "enc-proven",
					step: "encoding:a",
				}),
			],
		});
	});

	it("fails closed when a marker matches but the exact provider label is absent", async () => {
		const { ops } = setup({ stampless: true });
		api.encodingsList.mockResolvedValue({
			items: [{ id: "enc-no-label", name: "codec H264", labels: [] }],
		});
		api.encodingsCd.mockResolvedValue(
			verificationStamped("local-job", "encoding:a"),
		);
		await expect(
			ops.findVerificationEncodings({
				jobId: "local-job",
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
				resources: [{ step: "encoding:a", name: "codec H264" }],
			}),
		).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
			ownedCandidateIds: [],
		});
	});

	it("fails closed when the provider name is outside the submitted CREATE_ENCODING set", async () => {
		const { ops } = setup({ stampless: true });
		api.encodingsList.mockResolvedValue({
			items: [
				{
					id: "enc-foreign-name",
					name: "not submitted",
					labels: [`verify-key:${VERIFICATION.key}`],
				},
			],
		});
		api.encodingsCd.mockResolvedValue(
			verificationStamped("local-job", "encoding:a"),
		);
		await expect(
			ops.findVerificationEncodings({
				jobId: "local-job",
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
				resources: [{ step: "encoding:a", name: "codec H264" }],
			}),
		).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
			ownedCandidateIds: ["enc-foreign-name"],
		});
	});

	it("fails closed when provider customData cannot be read", async () => {
		const { ops } = setup({ stampless: true });
		api.encodingsList.mockResolvedValue({
			items: [
				{
					id: "enc-unreadable",
					name: "codec H264",
					labels: [`verify-key:${VERIFICATION.key}`],
				},
			],
		});
		api.encodingsCd.mockRejectedValue(new Error("customData unavailable"));
		await expect(
			ops.findVerificationEncodings({
				jobId: "local-job",
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
				resources: [{ step: "encoding:a", name: "codec H264" }],
			}),
		).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_LOOKUP_UNKNOWN",
			ownedCandidateIds: ["enc-unreadable"],
		});
	});

	it("returns an empty set only after an exhaustive short page", async () => {
		const { ops } = setup({ stampless: true });
		api.encodingsList.mockResolvedValue({ items: [] });
		expect(
			await ops.findVerificationEncodings({
				jobId: "local-job",
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
				resources: [{ step: "encoding:a", name: "codec H264" }],
			}),
		).toEqual([]);
		expect(api.encodingsList).toHaveBeenCalledTimes(1);
	});

	it("does not interpret a full scan horizon as provider absence", async () => {
		const { ops } = setup({ stampless: true });
		api.encodingsList.mockResolvedValue({
			items: Array.from({ length: 100 }, (_, i) => ({
				id: `foreign-${i}`,
				name: "foreign",
				labels: [],
			})),
		});
		api.encodingsCd.mockResolvedValue({ customData: {} });
		await expect(
			ops.findVerificationEncodings({
				jobId: "local-job",
				verificationKey: VERIFICATION.key,
				requestSha256: VERIFICATION.requestSha256,
				resources: [{ step: "encoding:a", name: "codec H264" }],
			}),
		).rejects.toMatchObject({
			code: "VERIFICATION_PROVIDER_LOOKUP_HORIZON",
		});
		expect(api.encodingsList).toHaveBeenCalledTimes(5);
	});
});

describe("part 3 — a failed create re-looks and adopts, WINDOW OR NOT", () => {
	it("window OFF: create rejects, the stamped resource exists → adopted", async () => {
		// The stamp rode the failed POST itself: if that POST reached the API,
		// THIS attempt's stamp finds it. Gating this on the window would
		// re-orphan the production mode ("each attempt succeeds server-side
		// and loses its answer").
		const { ops, audits } = setup({ window: false });
		api.encodingsCreate.mockRejectedValue(new Error("Premature close"));
		api.encodingsList.mockResolvedValue({ items: [{ id: "enc-lost" }] });
		api.encodingsCd.mockResolvedValue(stamped(STAMP.job, STAMP.step));
		expect(await ops.createEncoding(ENCODING_PAYLOAD)).toBe("enc-lost");
		expect(
			audits.some(
				(entry) =>
					(entry.request as { phase?: string })?.phase === "post-failure",
			),
		).toBe(true);
	});

	it("create rejects and NOTHING is stamped → the original error surfaces", async () => {
		const { ops } = setup({ window: true });
		api.encodingsCreate.mockRejectedValue(new Error("boom"));
		api.encodingsList.mockResolvedValue({ items: [] });
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toThrow("boom");
	});

	it("treats a malformed create response with no id as unknown and adopts the exact marker", async () => {
		const { ops } = setup({ window: false, verification: true });
		api.encodingsCreate.mockResolvedValue({});
		api.encodingsList.mockResolvedValue({
			items: [verificationEncodingItem("enc-malformed")],
		});
		api.encodingsCd.mockResolvedValue(
			verificationStamped(STAMP.job, STAMP.step),
		);
		expect(await ops.createEncoding(ENCODING_PAYLOAD)).toBe("enc-malformed");
		expect(api.encodingsCreate).toHaveBeenCalledTimes(1);
	});

	it("outside any step (currentStep undefined): no lookup even on failure", async () => {
		const { ops } = setup({ window: true, step: undefined });
		api.encodingsCreate.mockRejectedValue(new Error("boom"));
		await expect(ops.createEncoding(ENCODING_PAYLOAD)).rejects.toThrow("boom");
		expect(api.encodingsList).not.toHaveBeenCalled();
	});
});

describe("per-family wiring — each create reaches the shared discipline", () => {
	it("stream: adopts by stamp from the parent's own children", async () => {
		const { ops } = setup({ window: true, step: "stream:v0" });
		api.streamsList.mockResolvedValue({ items: [{ id: "stream-lost" }] });
		api.streamsCd.mockResolvedValue(stamped(STAMP.job, "stream:v0"));
		const created = await ops.createStream("enc-1", {
			codecConfigId: "cfg-1",
			inputStreamId: "in-1",
			name: "v0",
			mode: "STANDARD",
		});
		expect(created).toBe("stream-lost");
		expect(api.streamsCreate).not.toHaveBeenCalled();
		expect(api.streamsList).toHaveBeenCalledWith(
			"enc-1",
			expect.objectContaining({ limit: 100, offset: 0 }),
		);
		expect(api.streamsCd).toHaveBeenCalledWith("enc-1", "stream-lost");
	});

	const muxingCases = [
		["fmp4", "fmp4List", "fmp4Cd", "fmp4Create", "createFmp4Muxing"],
		["mp4", "mp4List", "mp4Cd", "mp4Create", "createMp4Muxing"],
		["ts", "tsList", "tsCd", "tsCreate", "createTsMuxing"],
		["webm", "webmList", "webmCd", "webmCreate", "createWebmMuxing"],
		[
			"chunkedText",
			"chunkedTextList",
			"chunkedTextCd",
			"chunkedTextCreate",
			"createChunkedTextMuxing",
		],
	] as const;

	for (const [label, listKey, cdKey, createKey, method] of muxingCases) {
		it(`${label} muxing: adopts by stamp under the parent encoding`, async () => {
			const { ops } = setup({ window: true, step: `mux:${label}` });
			api[listKey].mockResolvedValue({ items: [{ id: `${label}-lost` }] });
			api[cdKey].mockResolvedValue(stamped(STAMP.job, `mux:${label}`));
			const created = await ops[method]("enc-1", {
				streamId: "stream-1",
				...(label === "mp4" ? { filename: "out.mp4" } : {}),
			} as never);
			expect(created).toBe(`${label}-lost`);
			expect(api[createKey]).not.toHaveBeenCalled();
			expect(api[cdKey]).toHaveBeenCalledWith("enc-1", `${label}-lost`);
		});
	}

	it("CENC DRM (FMP4): adopts via the muxing-scoped list, paged with NUMBERS", async () => {
		const { ops } = setup({ window: true, step: "drm:cenc" });
		api.cencFmp4List.mockResolvedValue({ items: [{ id: "cenc-lost" }] });
		api.cencFmp4Cd.mockResolvedValue(stamped(STAMP.job, "drm:cenc"));
		const created = await ops.createCencDrm("enc-1", "mux-1", {
			muxingKind: "FMP4",
			key: "0123456789abcdef0123456789abcdef",
			kid: "fedcba9876543210fedcba9876543210",
		});
		expect(created).toBe("cenc-lost");
		expect(api.cencFmp4Create).not.toHaveBeenCalled();
		// The 1.269 quirk this pinned is GONE: fmp4 CENC's generated list params
		// were STRING-typed while mp4 CENC and both FairPlay variants took
		// numbers, so the pager stringified for this one family. SDK 1.277.0
		// types all of them as numbers  and tsc refused the old
		// spelling — the pin moved because the vendor moved, which is exactly
		// what a pin on a vendor quirk is for.
		expect(api.cencFmp4List).toHaveBeenCalledWith(
			"enc-1",
			"mux-1",
			expect.objectContaining({ limit: 100, offset: 0 }),
		);
		expect(api.cencFmp4Cd).toHaveBeenCalledWith("enc-1", "mux-1", "cenc-lost");
	});

	it("FairPlay DRM (TS): adopts via the muxing-scoped list with number paging", async () => {
		const { ops } = setup({ window: true, step: "drm:fp" });
		api.fairplayTsList.mockResolvedValue({ items: [{ id: "fp-lost" }] });
		api.fairplayTsCd.mockResolvedValue(stamped(STAMP.job, "drm:fp"));
		const created = await ops.createFairPlayDrm("enc-1", "mux-1", {
			muxingKind: "TS",
			key: "0123456789abcdef0123456789abcdef",
			iv: "0123456789abcdef0123456789abcdef",
			uri: "skd://key",
		});
		expect(created).toBe("fp-lost");
		expect(api.fairplayTsCreate).not.toHaveBeenCalled();
		expect(api.fairplayTsList).toHaveBeenCalledWith(
			"enc-1",
			"mux-1",
			expect.objectContaining({ limit: 100, offset: 0 }),
		);
	});

	it("muxing create outside the window is a plain POST — no lookup", async () => {
		const { ops } = setup({ window: false, step: "mux:fmp4" });
		const created = await ops.createFmp4Muxing("enc-1", {
			streamId: "stream-1",
		} as never);
		expect(created).toBe("fmp4-new");
		expect(api.fmp4List).not.toHaveBeenCalled();
	});
});

describe("the muxing BODY on the wire — templated naming carries no literal (WP-C6)", () => {
	/**
	 * The SDK's Mapper passes `""` through verbatim and `JSON.stringify` keeps
	 * it, so an empty `segmentNaming` beside `segmentNamingTemplate` would
	 * reach Bitmovin as `"segmentNaming":""` — the pairing the SDK forbids.
	 * `undefined` is dropped by `JSON.stringify`. This reads the model the
	 * adapter built, serialised exactly as the REST client would send it.
	 */
	const bodyOf = (call: unknown[] | undefined) =>
		JSON.parse(JSON.stringify(call?.[1])) as Record<string, unknown>;

	it("TS: the JSON body has segmentNamingTemplate and NO segmentNaming key", async () => {
		const { ops } = setup({ window: false, step: "mux:ts" });
		await ops.createTsMuxing("enc-1", {
			streamId: "stream-1",
			segmentLength: 2,
			segmentNamingTemplate: "seg-{segment_rand_chars:8}-%number%.ts",
			name: "Video TS Muxing 1080p",
		});
		const body = bodyOf(api.tsCreate.mock.calls[0]);
		expect(body.segmentNamingTemplate).toBe(
			"seg-{segment_rand_chars:8}-%number%.ts",
		);
		expect(Object.keys(body)).not.toContain("segmentNaming");
	});

	it("an EMPTY literal would survive to the body — which is why the executor must never pass one", async () => {
		// The counterfactual, asserted so the arm above is known to be judging
		// something the SDK does not fix for us.
		const { ops } = setup({ window: false, step: "mux:ts" });
		await ops.createTsMuxing("enc-1", {
			streamId: "stream-1",
			segmentLength: 2,
			segmentNaming: "",
			segmentNamingTemplate: "seg-{segment_rand_chars:8}-%number%.ts",
		});
		expect(bodyOf(api.tsCreate.mock.calls[0]).segmentNaming).toBe("");
	});
});
