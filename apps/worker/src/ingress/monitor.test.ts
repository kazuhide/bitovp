import {
	INGRESS_SETTING_KEY,
	type IngressResolution,
	type IngressSnapshot,
	parseIngressConfig,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { createIngressMonitor } from "./monitor";

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
			return {};
		},
	};
}

const T0 = new Date("2026-09-02T09:00:00.000Z");

function harness(resolutions: IngressResolution[]) {
	const appSetting = fakeAppSetting();
	const emitEvent = vi.fn(async () => {});
	const onChange = vi.fn(async () => {});
	const log = vi.fn();
	let tickIndex = 0;
	let clock = T0.getTime();
	const monitor = createIngressMonitor({
		prisma: { appSetting } as unknown as AppPrismaClient,
		config: parseIngressConfig({ INGRESS_MODE: "quick-tunnel" }),
		emitEvent,
		onChange,
		log,
		now: () => new Date(clock),
		resolve: async () => {
			const resolution =
				resolutions[Math.min(tickIndex, resolutions.length - 1)];
			tickIndex += 1;
			clock += 30_000;
			if (!resolution) {
				throw new Error("harness: no resolution scripted");
			}
			return resolution;
		},
	});
	const stored = () =>
		appSetting.rows.get(INGRESS_SETTING_KEY) as IngressSnapshot | undefined;
	return { monitor, emitEvent, onChange, log, stored };
}

const up = (host: string): IngressResolution => ({
	ok: true,
	current: {
		baseUrl: `https://${host}`,
		source: "cloudflared-quicktunnel",
		observedAt: T0.toISOString(),
	},
});
const down: IngressResolution = { ok: false, reason: "sidecar unreachable" };

describe("ingress monitor tick", () => {
	it("persists the first resolved URL and announces it as a change from nothing", async () => {
		const h = harness([up("a.trycloudflare.com")]);
		const next = await h.monitor.tick();
		expect(h.stored()).toEqual(next);
		expect(next.current?.baseUrl).toBe("https://a.trycloudflare.com");
		expect(h.emitEvent).toHaveBeenCalledWith({
			kind: "INGRESS_CHANGED",
			mode: "quick-tunnel",
			baseUrl: "https://a.trycloudflare.com",
			previousBaseUrl: null,
			path: "/settings/webhooks",
		});
		expect(h.onChange).toHaveBeenCalledTimes(1);
	});

	it("an unchanged URL re-stamps checkedAt, keeps observedAt, and emits nothing", async () => {
		const h = harness([up("a.trycloudflare.com"), up("a.trycloudflare.com")]);
		const first = await h.monitor.tick();
		const second = await h.monitor.tick();
		expect(second.current?.observedAt).toBe(first.current?.observedAt);
		expect(second.checkedAt).not.toBe(first.checkedAt);
		expect(h.emitEvent).toHaveBeenCalledTimes(1);
		expect(h.onChange).toHaveBeenCalledTimes(1);
		expect(h.stored()?.checkedAt).toBe(second.checkedAt);
	});

	it("a rotated tunnel URL emits with both URLs and re-fires onChange", async () => {
		const h = harness([up("a.trycloudflare.com"), up("b.trycloudflare.com")]);
		await h.monitor.tick();
		await h.monitor.tick();
		expect(h.emitEvent).toHaveBeenLastCalledWith(
			expect.objectContaining({
				baseUrl: "https://b.trycloudflare.com",
				previousBaseUrl: "https://a.trycloudflare.com",
			}),
		);
		expect(h.onChange).toHaveBeenCalledTimes(2);
	});

	it("losing the sidecar persists current:null with the reason and is itself a change", async () => {
		const h = harness([up("a.trycloudflare.com"), down]);
		await h.monitor.tick();
		const lost = await h.monitor.tick();
		expect(lost.current).toBeNull();
		expect(lost.reason).toBe("sidecar unreachable");
		expect(h.stored()?.current).toBeNull();
		expect(h.emitEvent).toHaveBeenLastCalledWith(
			expect.objectContaining({
				baseUrl: null,
				previousBaseUrl: "https://a.trycloudflare.com",
			}),
		);
	});

	it("no ingress from the start is persisted but NOT announced — a fresh laptop does not notify", async () => {
		const h = harness([down, down]);
		await h.monitor.tick();
		await h.monitor.tick();
		expect(h.stored()?.current).toBeNull();
		expect(h.emitEvent).not.toHaveBeenCalled();
		expect(h.onChange).not.toHaveBeenCalled();
	});

	it("a throwing onChange hook is logged; the snapshot stays persisted and the tick resolves", async () => {
		const h = harness([up("a.trycloudflare.com")]);
		h.onChange.mockRejectedValueOnce(new Error("re-register exploded"));
		const next = await h.monitor.tick();
		expect(h.stored()).toEqual(next);
		expect(h.log).toHaveBeenCalledWith(
			expect.stringContaining("onChange hook failed"),
		);
	});
});

describe("ingress monitor across a worker restart", () => {
	it("a restarted worker (new monitor, same row) does not re-announce the same URL", async () => {
		// The previous snapshot must come from the ROW, not process memory: a
		// restart/deploy with an intact row must be silent (G-2 hangs
		// re-registration on the change event, so a false change is churn).
		const prisma = {
			appSetting: fakeAppSetting(),
		} as unknown as AppPrismaClient;
		const emitEvent = vi.fn(async () => {});
		const mk = () =>
			createIngressMonitor({
				prisma,
				config: parseIngressConfig({ INGRESS_MODE: "quick-tunnel" }),
				emitEvent,
				resolve: async () => up("a.trycloudflare.com"),
				log: () => {},
			});
		await mk().tick(); // boot 1: (none) → URL, announced once
		await mk().tick(); // boot 2 (restart): same row, same URL → silence
		expect(emitEvent).toHaveBeenCalledTimes(1);
	});
});
