import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import {
	addVodInputFavorite,
	deleteVodInputFavorite,
	listVodInputFavorites,
} from "./vod-input-favorites";

const mocks = vi.hoisted(() => ({ context: null as unknown as ServerContext }));
vi.mock("./context", () => ({ getServerContext: async () => mocks.context }));
const id = "00000000-0000-4000-8000-000000000001";
const source = {
	credentialId: id,
	bucket: "input",
	objectKey: "intro.mp4",
	label: "Intro",
	kind: "VIDEO",
};
let value: unknown;
let prisma: {
	appSetting: {
		findUnique: ReturnType<typeof vi.fn>;
		create: ReturnType<typeof vi.fn>;
		updateMany: ReturnType<typeof vi.fn>;
	};
};
let get: ReturnType<typeof vi.fn>;

beforeEach(() => {
	value = undefined;
	get = vi.fn().mockResolvedValue({ id, provider: "AWS_S3", config: {} });
	prisma = {
		appSetting: {
			findUnique: vi.fn(async () =>
				value === undefined ? null : { value: structuredClone(value) },
			),
			create: vi.fn(async ({ data }) => {
				if (value !== undefined)
					throw Object.assign(new Error("unique"), { code: "P2002" });
				value = structuredClone(data.value);
				return data;
			}),
			updateMany: vi.fn(async ({ where, data }) => {
				if (JSON.stringify(value) !== JSON.stringify(where.value.equals))
					return { count: 0 };
				value = structuredClone(data.value);
				return { count: 1 };
			}),
		},
	};
	mocks.context = {
		prisma,
		credentials: { get },
		tenant: { organizationId: id, role: "OPERATOR", isImpersonating: false },
	} as unknown as ServerContext;
});

describe("organization VOD fixed sources", () => {
	it("persists a reference without decrypting credentials, deduplicates retries and returns copied DTOs", async () => {
		const first = await addVodInputFavorite(source);
		const again = await addVodInputFavorite({ ...source, label: "New label" });
		expect(again.id).toBe(first.id);
		expect(await listVodInputFavorites()).toEqual({
			favorites: [{ ...first, availability: "AVAILABLE", inputKind: "S3" }],
		});
		first.label = "Local edit";
		expect(JSON.stringify(value)).not.toContain("Local edit");
		expect(value).toMatchObject({ schemaVersion: 1, items: [{ ...source }] });
	});
	it.each([
		"VIEWER",
		"missing",
		"impersonating",
	])("refuses %s before reading or writing registry", async (mode) => {
		if (mode === "missing") mocks.context.tenant = undefined;
		else if (mocks.context.tenant) {
			mocks.context.tenant.role = mode === "VIEWER" ? "VIEWER" : "OPERATOR";
			mocks.context.tenant.isImpersonating = mode === "impersonating";
		}
		for (const request of [
			() => listVodInputFavorites(),
			() => addVodInputFavorite(source),
			() => deleteVodInputFavorite(id),
		]) {
			await expect(request()).rejects.toMatchObject({ status: 403 });
		}
		expect(prisma.appSetting.findUnique).not.toHaveBeenCalled();
		expect(prisma.appSetting.create).not.toHaveBeenCalled();
	});
	it("refuses missing or foreign credentials and unsupported image providers", async () => {
		get.mockResolvedValue(null);
		await expect(addVodInputFavorite(source)).rejects.toMatchObject({
			status: 404,
			code: "SOURCE_CREDENTIAL_NOT_FOUND",
		});
		get.mockResolvedValue({ id, provider: "GCS_SERVICE_ACCOUNT" });
		await expect(
			addVodInputFavorite({ ...source, kind: "IMAGE", objectKey: "logo.png" }),
		).rejects.toMatchObject({
			status: 422,
			code: "FAVORITE_PROVIDER_UNSUPPORTED",
		});
		expect(prisma.appSetting.create).not.toHaveBeenCalled();
	});
	it("marks a deleted credential unavailable but still allows removing the reference", async () => {
		const favorite = await addVodInputFavorite(source);
		get.mockResolvedValue(null);
		expect(await listVodInputFavorites()).toMatchObject({
			favorites: [
				{
					id: favorite.id,
					availability: "CREDENTIAL_UNAVAILABLE",
					inputKind: null,
				},
			],
		});
		await deleteVodInputFavorite(favorite.id);
		await deleteVodInputFavorite(favorite.id);
		expect(await listVodInputFavorites()).toEqual({ favorites: [] });
	});
	it("keeps corrupted JSON intact rather than silently resetting it", async () => {
		value = { schemaVersion: 1, items: "invalid" };
		const before = structuredClone(value);
		for (const request of [
			() => listVodInputFavorites(),
			() => addVodInputFavorite(source),
			() => deleteVodInputFavorite(id),
		]) {
			await expect(request()).rejects.toMatchObject({
				status: 409,
				code: "FAVORITES_INVALID",
			});
		}
		expect(value).toEqual(before);
		expect(prisma.appSetting.updateMany).not.toHaveBeenCalled();
	});
	it("merges after a compare-and-swap conflict without replacing another browser's addition", async () => {
		await addVodInputFavorite(source);
		prisma.appSetting.updateMany.mockImplementationOnce(async () => {
			const current = value as { items: unknown[] };
			current.items.push({
				...source,
				id: "00000000-0000-4000-8000-000000000003",
				objectKey: "other.mp4",
			});
			return { count: 0 };
		});
		await addVodInputFavorite({ ...source, objectKey: "third.mp4" });
		expect(
			(await listVodInputFavorites()).favorites.map((item) => item.objectKey),
		).toEqual(["intro.mp4", "other.mp4", "third.mp4"]);
	});
	it("bounds contention and fails without reporting a successful write", async () => {
		await addVodInputFavorite(source);
		prisma.appSetting.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			addVodInputFavorite({ ...source, objectKey: "never-saved.mp4" }),
		).rejects.toMatchObject({ status: 409, code: "FAVORITES_CONFLICT" });
		expect(prisma.appSetting.updateMany.mock.calls.length).toBeLessThanOrEqual(
			8,
		);
		expect(JSON.stringify(value)).not.toContain("never-saved");
	});
	it("rejects invalid input and enforces the list cap", async () => {
		await expect(
			addVodInputFavorite({ ...source, signedUrl: "secret" }),
		).rejects.toThrow();
		value = {
			schemaVersion: 1,
			items: Array.from({ length: 64 }, (_, n) => ({
				...source,
				id: `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`,
				objectKey: `${n}.mp4`,
			})),
		};
		await expect(addVodInputFavorite(source)).rejects.toMatchObject({
			status: 409,
			code: "FAVORITES_LIMIT",
		});
	});
});
