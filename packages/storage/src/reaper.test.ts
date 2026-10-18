import { beforeEach, describe, expect, it, vi } from "vitest";

const s3Send = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
	S3Client: class {
		send = s3Send;
		middlewareStack = { add: vi.fn() };
	},
	ListObjectsV2Command: class {
		readonly kind = "ListObjectsV2";
		constructor(readonly input: Record<string, unknown>) {}
	},
	DeleteObjectsCommand: class {
		readonly kind = "DeleteObjects";
		constructor(readonly input: Record<string, unknown>) {}
	},
	DeleteObjectCommand: class {
		readonly kind = "DeleteObject";
		constructor(readonly input: Record<string, unknown>) {}
	},
	PutObjectCommand: class {
		readonly kind = "PutObject";
		constructor(readonly input: Record<string, unknown>) {}
	},
}));

const gcsSave = vi.fn();
const gcsDelete = vi.fn();
const gcsGetFiles = vi.fn(async (_opts: unknown) => [[]]);
vi.mock("@google-cloud/storage", () => ({
	Storage: class {
		bucket() {
			return {
				file: (name: string) => ({
					save: (body: string) => gcsSave(name, body),
					delete: () => gcsDelete(name),
				}),
				getFiles: (opts: unknown) => gcsGetFiles(opts),
			};
		}
	},
}));

const azureUpload = vi.fn();
const azureDeleteBlob = vi.fn();
vi.mock("@azure/storage-blob", () => ({
	BlobServiceClient: class {
		getContainerClient() {
			return {
				uploadBlockBlob: (name: string, body: string, length: number) =>
					azureUpload(name, body, length),
				deleteBlob: (name: string) => azureDeleteBlob(name),
				listBlobsFlat: () => ({
					async *[Symbol.asyncIterator]() {},
					byPage: () => ({
						next: async () => ({ done: true, value: undefined }),
					}),
				}),
			};
		}
	},
	StorageSharedKeyCredential: class {},
}));

import {
	assertSafeProbePrefix,
	MIN_PROBE_PREFIX_LENGTH,
	probeReaperForCredential,
	UnsafeProbePrefixError,
} from "./reaper";
import { UnsupportedBrowseError } from "./types";

function s3Credential() {
	return {
		provider: "AWS_S3" as const,
		config: { region: "ap-northeast-1" },
		secret: { accessKeyId: "a", secretAccessKey: "s" },
	};
}

/**
 *  PR4 control 3 — the hard prefix refusal. The #155 precedent:
 * an output-prefix derivation bug persisted "" and was harmless in a WRITE;
 * the same class inside a DELETE sweeps the bucket. Every branch is pinned
 * from BOTH directions (a guard whose failure mode is "allows everything"
 * needs its violating fixtures — the repo's own negative-assertion lesson).
 */
describe("assertSafeProbePrefix (control 3)", () => {
	const AREA = "probes/startup/";

	it("accepts children STRICTLY below the area — and refuses the area itself (review-161-162 M9)", () => {
		expect(() => assertSafeProbePrefix(`${AREA}p-123/`, AREA)).not.toThrow();
		// Deleting the whole designated area is never a legitimate reap:
		// every caller targets one probe's subtree, and area-equality is the
		// door through which a slash-less area's ListObjectsV2 prefix would
		// match sibling areas.
		expect(() => assertSafeProbePrefix(AREA, AREA)).toThrow(
			UnsafeProbePrefixError,
		);
	});

	it("refuses an EMPTY deletion target — the bucket-sweep case", () => {
		expect(() => assertSafeProbePrefix("", AREA)).toThrow(
			UnsafeProbePrefixError,
		);
	});

	it("refuses a target OUTSIDE the designated area", () => {
		expect(() => assertSafeProbePrefix("customer-masters/", AREA)).toThrow(
			UnsafeProbePrefixError,
		);
		// A PREFIX of the area is not INSIDE the area.
		expect(() => assertSafeProbePrefix("probes/", AREA)).toThrow(
			UnsafeProbePrefixError,
		);
	});

	it("refuses a SHORT configured area outright — every deletion under it, not just some", () => {
		const short = "p/";
		expect(short.length).toBeLessThan(MIN_PROBE_PREFIX_LENGTH);
		// Even a well-formed child is refused when the AREA itself is suspect.
		expect(() => assertSafeProbePrefix("p/child/", short)).toThrow(
			UnsafeProbePrefixError,
		);
		// And the empty configured area (the #155 shape verbatim).
		expect(() => assertSafeProbePrefix("anything/", "")).toThrow(
			UnsafeProbePrefixError,
		);
	});

	it("a slash-less area cannot bless its SIBLINGS (review-pr34 M1)", () => {
		// The designation route normalizes a trailing slash, but the guard is
		// the last line at the deletion site and trusts no caller: with area
		// "probes/startup", the sibling "probes/startup-customer-masters/…"
		// passes raw startsWith and must still be refused at the segment
		// boundary.
		expect(() =>
			assertSafeProbePrefix(
				"probes/startup-customer-masters/vault/",
				"probes/startup",
			),
		).toThrow(UnsafeProbePrefixError);
		// The legitimate child of the same slash-less area still passes …
		expect(() =>
			assertSafeProbePrefix("probes/startup/p-1/", "probes/startup"),
		).not.toThrow();
		// … and the area itself is REFUSED (M9): "probes/startup" as a
		// ListObjectsV2 prefix matches "probes/startup-customer-masters/*" —
		// the sibling this guard exists to protect.
		expect(() =>
			assertSafeProbePrefix("probes/startup", "probes/startup"),
		).toThrow(UnsafeProbePrefixError);
	});

	it("whitespace cannot smuggle a short prefix past the bar", () => {
		expect(() => assertSafeProbePrefix("   p/   ", "   p/   ")).toThrow(
			UnsafeProbePrefixError,
		);
	});
});

/**
 * review-pr34 M4 — driver-level pins for the two response-shape traps the
 * mocked-reaper tests in probe-runner.test.ts could never see:
 *  B3: S3 BATCH delete answers a denied key with 200 + body Errors — the
 *      permission check must ride the single-object endpoint, whose denial
 *      is a thrown 403.
 *  B4: the reap must count the server's Deleted list and refuse to continue
 *      past body Errors — never count keys ASKED as keys DELETED.
 */
describe("s3 reaper drivers (review-pr34 B3/B4/M4)", () => {
	beforeEach(() => {
		s3Send.mockReset();
	});

	it("verify is a CANARY: PutObject → List → DeleteObject of the just-written key (never an absent-key delete)", async () => {
		s3Send.mockResolvedValue({});
		const reaper = probeReaperForCredential(s3Credential());
		const verdict = await reaper.verifyDeletePermission({
			bucket: "b",
			prefix: "probes/startup/",
		});
		expect(verdict.ok).toBe(true);
		// The sequence IS the contract (review-161-162 B3): a delete of a
		// known-absent key cannot give an unambiguous positive — S3 204s it,
		// and the 404=permitted arm blessed mistyped buckets on the others.
		expect(
			s3Send.mock.calls.map((call) => (call[0] as { kind: string }).kind),
		).toEqual(["PutObject", "ListObjectsV2", "DeleteObject"]);
		expect(
			(s3Send.mock.calls[0]?.[0] as { input: { Key?: string } }).input.Key,
		).toBe("probes/startup/.bitovp-permission-probe");
	});

	it("a mistyped BUCKET fails the designation — NoSuchBucket at the canary PUT", async () => {
		const reaper = probeReaperForCredential(s3Credential());
		s3Send.mockRejectedValueOnce(
			Object.assign(new Error("The specified bucket does not exist"), {
				name: "NoSuchBucket",
				$metadata: { httpStatusCode: 404 },
			}),
		);
		await expect(
			reaper.verifyDeletePermission({
				bucket: "probe-bucekt",
				prefix: "probes/startup/",
			}),
		).resolves.toMatchObject({ ok: false, detail: "bucket does not exist" });
	});

	it("a LIST-leg failure still SWEEPS the canary — no write left behind (review-161-162 n-1)", async () => {
		const denied = () =>
			Object.assign(new Error("Access Denied"), {
				name: "AccessDenied",
				$metadata: { httpStatusCode: 403 },
			});
		const reaper = probeReaperForCredential(s3Credential());
		// PUT ok, LIST denied — the credential can write+delete but not list.
		s3Send.mockResolvedValueOnce({}).mockRejectedValueOnce(denied());
		// The sweep DeleteObject after the failed list resolves.
		s3Send.mockResolvedValueOnce({});
		await expect(
			reaper.verifyDeletePermission({ bucket: "b", prefix: "probes/startup/" }),
		).resolves.toMatchObject({ ok: false });
		const kinds = s3Send.mock.calls.map(
			(call) => (call[0] as { kind: string }).kind,
		);
		// PutObject → ListObjectsV2 (throws) → DeleteObject (the sweep): the
		// canary the PUT wrote is removed even though the designation failed.
		expect(kinds).toEqual(["PutObject", "ListObjectsV2", "DeleteObject"]);
		const sweep = s3Send.mock.calls[2]?.[0] as { input: { Key?: string } };
		expect(sweep.input.Key).toBe("probes/startup/.bitovp-permission-probe");
	});

	it("each leg names its own denial: write, list (reaps page with List), delete", async () => {
		const denied = () =>
			Object.assign(new Error("Access Denied"), {
				name: "AccessDenied",
				$metadata: { httpStatusCode: 403 },
			});
		const reaper = probeReaperForCredential(s3Credential());
		s3Send.mockRejectedValueOnce(denied());
		await expect(
			reaper.verifyDeletePermission({ bucket: "b", prefix: "probes/startup/" }),
		).resolves.toMatchObject({ ok: false, detail: "access denied (write)" });
		s3Send.mockReset();
		// PUT ok, LIST denied, then the n-1 sweep DeleteObject (ok).
		s3Send
			.mockResolvedValueOnce({})
			.mockRejectedValueOnce(denied())
			.mockResolvedValueOnce({});
		await expect(
			reaper.verifyDeletePermission({ bucket: "b", prefix: "probes/startup/" }),
		).resolves.toMatchObject({
			ok: false,
			detail: "access denied (list — reaps page with List)",
		});
		s3Send.mockReset();
		s3Send
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({})
			.mockRejectedValueOnce(denied());
		await expect(
			reaper.verifyDeletePermission({ bucket: "b", prefix: "probes/startup/" }),
		).resolves.toMatchObject({ ok: false, detail: "access denied (delete)" });
	});

	it("deleteObjectsUnderPrefix THROWS on 200-with-Errors instead of reporting a clean reap", async () => {
		s3Send.mockImplementation(async (command: { kind: string }) => {
			if (command.kind === "ListObjectsV2") {
				return {
					Contents: [
						{ Key: "probes/startup/p-1/a" },
						{ Key: "probes/startup/p-1/b" },
					],
					IsTruncated: false,
				};
			}
			return {
				Deleted: [{ Key: "probes/startup/p-1/a" }],
				Errors: [{ Key: "probes/startup/p-1/b", Code: "AccessDenied" }],
			};
		});
		const reaper = probeReaperForCredential(s3Credential());
		await expect(
			reaper.deleteObjectsUnderPrefix({
				bucket: "b",
				prefix: "probes/startup/p-1/",
			}),
		).rejects.toThrow(/1\/2 keys.*AccessDenied/);
	});

	it("the count is the server's Deleted list, requested WITHOUT Quiet", async () => {
		s3Send.mockImplementation(
			async (command: { kind: string; input: Record<string, unknown> }) => {
				if (command.kind === "ListObjectsV2") {
					return {
						Contents: [
							{ Key: "probes/startup/p-1/a" },
							{ Key: "probes/startup/p-1/b" },
						],
						IsTruncated: false,
					};
				}
				// Quiet:true would suppress this very list — the old code both
				// asked quietly AND counted keys asked, a double blindness.
				expect(
					(command.input.Delete as { Quiet?: boolean } | undefined)?.Quiet,
				).toBeUndefined();
				return { Deleted: [{ Key: "a" }, { Key: "b" }], Errors: [] };
			},
		);
		const reaper = probeReaperForCredential(s3Credential());
		await expect(
			reaper.deleteObjectsUnderPrefix({
				bucket: "b",
				prefix: "probes/startup/p-1/",
			}),
		).resolves.toEqual({ deleted: 2 });
	});
});

describe("gcs / azure verify drivers (review-pr34 M4)", () => {
	it("GCS: save→list→delete canary; a missing bucket fails at the SAVE", async () => {
		const reaper = probeReaperForCredential({
			provider: "GCS_SERVICE_ACCOUNT",
			config: {},
			secret: { serviceAccountJson: '{"project_id":"p"}' },
		});
		gcsSave.mockResolvedValueOnce(undefined);
		gcsDelete.mockResolvedValueOnce(undefined);
		await expect(
			reaper.verifyDeletePermission({ bucket: "b", prefix: "probes/startup/" }),
		).resolves.toMatchObject({ ok: true });
		expect(gcsSave).toHaveBeenCalledWith(
			"probes/startup/.bitovp-permission-probe",
			"",
		);
		gcsSave.mockRejectedValueOnce(
			Object.assign(new Error("nf"), { code: 404 }),
		);
		await expect(
			reaper.verifyDeletePermission({
				bucket: "missing",
				prefix: "probes/startup/",
			}),
		).resolves.toMatchObject({ ok: false, detail: "bucket does not exist" });
		gcsSave.mockRejectedValueOnce(
			Object.assign(new Error("denied"), { code: 403 }),
		);
		await expect(
			reaper.verifyDeletePermission({ bucket: "b", prefix: "probes/startup/" }),
		).resolves.toMatchObject({ ok: false, detail: "access denied (write)" });
	});

	it("Azure: upload→list→delete canary; a missing container fails at the UPLOAD", async () => {
		const reaper = probeReaperForCredential({
			provider: "AZURE_BLOB",
			config: { accountName: "acct" },
			secret: { accountKey: "a2V5" },
		});
		azureUpload.mockResolvedValueOnce(undefined);
		azureDeleteBlob.mockResolvedValueOnce(undefined);
		await expect(
			reaper.verifyDeletePermission({ bucket: "c", prefix: "probes/startup/" }),
		).resolves.toMatchObject({ ok: true });
		azureUpload.mockRejectedValueOnce(
			Object.assign(new Error("nf"), { statusCode: 404 }),
		);
		await expect(
			reaper.verifyDeletePermission({
				bucket: "missing",
				prefix: "probes/startup/",
			}),
		).resolves.toMatchObject({ ok: false, detail: "container does not exist" });
		azureUpload.mockResolvedValueOnce(undefined);
		azureDeleteBlob.mockRejectedValueOnce(
			Object.assign(new Error("denied"), { statusCode: 403 }),
		);
		await expect(
			reaper.verifyDeletePermission({ bucket: "c", prefix: "probes/startup/" }),
		).resolves.toMatchObject({ ok: false, detail: "access denied (delete)" });
	});

	it("a provider with no deletion driver is a LOUD refusal, not a fallthrough", () => {
		expect(() =>
			probeReaperForCredential({
				provider: "AKAMAI_NETSTORAGE",
				config: {},
				secret: {},
			}),
		).toThrow(UnsupportedBrowseError);
	});
});
