import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aisaLiveAccessAllowed } from "./aisa-live-access";

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const owner = {
	actorUserId: ownerId,
	effectiveUserId: ownerId,
	actor: `user:${ownerId}`,
	role: "ADMIN",
	actorRole: "ADMIN",
	isImpersonating: false,
};

beforeEach(() => {
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW_USER_ID", ownerId);
});
afterEach(() => vi.unstubAllEnvs());

describe("AISA Live access", () => {
	it("allows only the configured human administrator's own session", () => {
		expect(aisaLiveAccessAllowed(owner)).toBe(true);
	});
	it.each(["", "false", "1"])("requires the exact Preview flag: %s", (flag) => {
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", flag);
		expect(aisaLiveAccessAllowed(owner)).toBe(false);
	});
	it.each([
		undefined,
		"",
		" ",
		"not-a-uuid",
		`${ownerId},${otherId}`,
	])("fails closed for an unavailable or ambiguous configured user: %s", (value) => {
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW_USER_ID", value);
		expect(aisaLiveAccessAllowed(owner)).toBe(false);
	});
	it.each([
		undefined,
		null,
		{},
		[],
		{ ...owner, actorUserId: otherId },
		{ ...owner, effectiveUserId: otherId },
		{ ...owner, actor: `user:${otherId}` },
		{ ...owner, role: "OPERATOR" },
		{ ...owner, role: "VIEWER" },
		{ ...owner, actorRole: "OPERATOR" },
		{ ...owner, isImpersonating: true },
		{ ...owner, isImpersonating: undefined },
		{ ...owner, actor: "session", actorUserId: null, effectiveUserId: null },
		{ ...owner, actor: "none", actorUserId: null, effectiveUserId: null },
		{
			...owner,
			actor: "token:owned-token",
			effectiveUserId: null,
			tokenRoleKnown: true,
		},
		{ ...owner, actor: "token:owned-token", tokenRoleKnown: true },
		{ ...owner, actor: `user:${ownerId}`, actorUserId: undefined },
	])("denies unproven, different, delegated, or lower-privilege principals %#", (tenant) => {
		expect(aisaLiveAccessAllowed(tenant)).toBe(false);
	});
});
