import { randomBytes } from "node:crypto";
import {
	AesGcmCipher,
	deriveScopedToken,
	INGRESS_SETTING_KEY,
} from "@bitovp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import {
	accountReceiver,
	currentIngressBaseUrl,
	readCurrentIngress,
} from "./ingress";

vi.mock("./context", () => ({
	getServerContext: () => {
		throw new Error("tests pass an explicit context");
	},
}));

const rows = new Map<string, unknown>();
const appSetting = {
	async findUnique(args: { where: { key: string } }) {
		return rows.has(args.where.key)
			? { value: rows.get(args.where.key) }
			: null;
	},
	async create(args: { data: { key: string; value: unknown } }) {
		rows.set(args.data.key, args.data.value);
		return args.data;
	},
};
const cipher = new AesGcmCipher(randomBytes(32));
const ctx = { prisma: { appSetting }, cipher } as unknown as ServerContext;

const snapshot = (baseUrl: string | null) => ({
	v: 1,
	mode: "static",
	current:
		baseUrl === null
			? null
			: {
					baseUrl,
					source: "PUBLIC_BASE_URL",
					observedAt: "2026-09-02T09:00:00.000Z",
				},
	checkedAt: "2026-09-02T09:00:30.000Z",
});

beforeEach(() => {
	rows.clear();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("readCurrentIngress / currentIngressBaseUrl", () => {
	it("reads the persisted row; no row or a DB fault is null, never a throw", async () => {
		expect(await readCurrentIngress(ctx.prisma)).toBeNull();
		rows.set(INGRESS_SETTING_KEY, snapshot("https://ovp.example.com"));
		expect(await currentIngressBaseUrl(ctx.prisma)).toBe(
			"https://ovp.example.com",
		);
		const broken = {
			appSetting: {
				findUnique: async () => {
					throw new Error("db down");
				},
			},
		} as unknown as ServerContext["prisma"];
		expect(await readCurrentIngress(broken)).toBeNull();
	});
});

describe("accountReceiver", () => {
	it("is null without a public ingress — and touches no secret", async () => {
		rows.set(INGRESS_SETTING_KEY, snapshot(null));
		expect(await accountReceiver(ctx)).toBeNull();
		expect(rows.size).toBe(1);
	});

	it("composes the signed acct endpoint + legacy endpoint from the ingress base and the env master — never a key (rev407 #3; the account-level POST is gone with G-2b)", async () => {
		vi.stubEnv("BITMOVIN_WEBHOOK_SECRET", "env-master");
		rows.set(INGRESS_SETTING_KEY, snapshot("https://ovp.example.com"));
		const receiver = await accountReceiver(ctx);
		const token = deriveScopedToken("env-master", "acct");
		// toEqual is exact on defined keys: a `signatureKey` here is red.
		expect(receiver).toEqual({
			endpoint: `https://ovp.example.com/api/webhooks/bitmovin/acct/${token}`,
			legacyEndpoint: "https://ovp.example.com/api/webhooks/bitmovin",
			secretSource: "env",
		});
		expect(receiver).not.toHaveProperty("signatureKey");
	});

	it("without the env secret, generates and persists the master on first use — the endpoint is then stable", async () => {
		rows.set(INGRESS_SETTING_KEY, snapshot("https://ovp.example.com"));
		const first = await accountReceiver(ctx);
		const second = await accountReceiver(ctx);
		expect(first?.secretSource).toBe("generated");
		expect(second).toEqual(first);
		expect(rows.has("webhook.masterSecret")).toBe(true);
	});
});
