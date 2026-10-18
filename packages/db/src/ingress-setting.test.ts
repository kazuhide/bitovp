import { INGRESS_SETTING_KEY, type IngressSnapshot } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { AppPrismaClient } from "./client";
import { readIngressSnapshot, writeIngressSnapshot } from "./ingress-setting";

function fakeAppSetting() {
	const rows = new Map<string, unknown>();
	return {
		rows,
		async findUnique(args: { where: { key: string } }) {
			return rows.has(args.where.key)
				? { value: rows.get(args.where.key) }
				: null;
		},
		async upsert(args: {
			where: { key: string };
			create: { key: string; value: unknown };
			update: { value: unknown };
		}) {
			rows.set(
				args.where.key,
				rows.has(args.where.key) ? args.update.value : args.create.value,
			);
			return { key: args.where.key, value: rows.get(args.where.key) };
		},
	};
}

const snapshot: IngressSnapshot = {
	v: 1,
	mode: "quick-tunnel",
	current: {
		baseUrl: "https://abc.trycloudflare.com",
		source: "cloudflared-quicktunnel",
		observedAt: "2026-09-02T09:00:00.000Z",
	},
	checkedAt: "2026-09-02T09:00:30.000Z",
};

describe("ingress snapshot persistence", () => {
	it("writes under ingress.current and reads back the same value", async () => {
		const table = fakeAppSetting();
		const prisma = { appSetting: table } as unknown as AppPrismaClient;
		expect(await readIngressSnapshot(prisma)).toBeNull();
		await writeIngressSnapshot(prisma, snapshot);
		expect(table.rows.has(INGRESS_SETTING_KEY)).toBe(true);
		expect(await readIngressSnapshot(prisma)).toEqual(snapshot);
		// A second write replaces, never duplicates.
		await writeIngressSnapshot(prisma, { ...snapshot, current: null });
		expect((await readIngressSnapshot(prisma))?.current).toBeNull();
	});

	it("a malformed row reads as null instead of throwing into a page render", async () => {
		const table = fakeAppSetting();
		table.rows.set(INGRESS_SETTING_KEY, { v: 1, mode: "static" });
		const prisma = { appSetting: table } as unknown as AppPrismaClient;
		expect(await readIngressSnapshot(prisma)).toBeNull();
	});
});
