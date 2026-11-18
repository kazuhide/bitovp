import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const CHANNEL = "00000000-0000-4000-8000-000000000001";
const CREDENTIAL = "00000000-0000-4000-8000-000000000002";
const ORGANIZATION = "00000000-0000-4000-8000-000000000003";
const PUBLISH_TOKEN = "publish-token-must-stay-server-side";
const SUBSCRIBE_TOKEN = "subscribe-token-must-stay-server-side";
const PLAYER_KEY = "test-player-key-must-stay-server-side";
const bundle = vi.hoisted(() => vi.fn());
const getServerContext = vi.hoisted(() => vi.fn());
const readPlayerSettings = vi.hoisted(() => vi.fn());
const findUnique = vi.fn();
const revealVersioned = vi.fn();

vi.mock("@/lib/server/context", () => ({ getServerContext }));
vi.mock("@/lib/server/moq-player-asset", () => ({
	readMoqPlayerBundle: bundle,
}));
vi.mock("@/lib/server/player-config", () => ({ readPlayerSettings }));

function vault({
	provider = "MOQ",
	playbackUrl,
	updatedAt = new Date("2026-11-17T00:00:00.000Z"),
}: {
	provider?: string;
	playbackUrl?: string;
	updatedAt?: Date;
} = {}) {
	revealVersioned.mockResolvedValue({
		id: CREDENTIAL,
		provider,
		updatedAt,
		secret: JSON.stringify({
			relayUrl: "moqt://publisher.example.test:443/session",
			authToken: PUBLISH_TOKEN,
			playbackUrl,
		}),
	});
}

function request(extra = "") {
	return new Request(
		`https://app.example.test/api/live-channels/moq-readiness?credentialId=${CREDENTIAL}&draftVersion=DRAFT_16&namespaceComponents=1${extra}`,
	);
}

function channelRequest() {
	return new Request(
		`https://app.example.test/api/live-channels/moq-readiness?channelId=${CHANNEL}`,
	);
}

const savedPlan = (trackNamespace: string[]) => ({
	outputs: [
		{
			kind: "MOQ",
			credentialId: CREDENTIAL,
			draftVersion: "DRAFT_16",
			trackNamespace,
		},
	],
});

const pendingMoqOutput = {
	step: "output:moq",
	kind: "CREATE_OUTPUT_MOQ",
	status: "PENDING",
	payload: {
		credentialId: CREDENTIAL,
		draftVersion: "DRAFT_16",
		trackNamespace: ["pending"],
	},
	refs: {},
};
const committedMoqOutput = {
	...pendingMoqOutput,
	status: "DONE",
	resourceId: "00000000-0000-4000-8000-000000000004",
	startedAt: "2026-11-17T00:00:02.000Z",
	finishedAt: "2026-11-17T00:00:04.000Z",
};

function cloudflarePlayback({
	operations = ["subscribe"],
	exp = 4_000_000_000,
	draft = 16,
}: {
	operations?: string[];
	exp?: number;
	draft?: number;
} = {}) {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const header = encode({ alg: "EdDSA", typ: "JWT" });
	const payload = encode({
		iss: "cloudflare",
		aud: "moq.cloudflare.com",
		sub: "0123456789abcdef0123456789abcdef",
		exp,
		operations,
	});
	const signature = Buffer.alloc(64, 1).toString("base64url");
	return `https://draft-${draft}.cloudflare.mediaoverquic.com/${header}.${payload}.${signature}`;
}

beforeEach(() => {
	vi.resetAllMocks();
	getServerContext.mockResolvedValue({
		tenant: {
			role: "OPERATOR",
			isImpersonating: false,
			organizationId: ORGANIZATION,
		},
		prisma: { liveChannel: { findUnique } },
		credentials: { revealVersioned },
	});
	vault({
		playbackUrl: `https://subscriber.example.test/${SUBSCRIBE_TOKEN}`,
	});
	readPlayerSettings.mockResolvedValue({ playerLicenseKey: PLAYER_KEY });
	bundle.mockResolvedValue(new ArrayBuffer(5));
});

describe("advisory MoQ preview readiness", () => {
	it("reports only configuration status after checking the tenant's subscriber and local bundle", async () => {
		const response = await GET(request());
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toEqual({ status: "ready", issues: [] });
		expect(revealVersioned).toHaveBeenCalledWith(CREDENTIAL);
		expect(bundle).toHaveBeenCalledOnce();
	});

	it("returns publishing-only for an omitted playback URL", async () => {
		vault();
		const response = await GET(request());
		expect(await response.json()).toEqual({
			status: "publisher-only",
			issues: ["subscriber-url-missing"],
		});
	});

	it("lists both unavailable Player settings with no provider probe", async () => {
		readPlayerSettings.mockResolvedValue({});
		bundle.mockRejectedValue(new Error("private bundle path"));
		const response = await GET(request());
		expect(await response.json()).toEqual({
			status: "needs-configuration",
			issues: ["player-license-unavailable", "player-bundle-unavailable"],
		});
	});

	it.each([
		[
			`https://relay.example.test/?credential=${PUBLISH_TOKEN}`,
			"subscribe-only-required",
		],
		[
			cloudflarePlayback({ operations: ["publish", "subscribe"] }),
			"subscribe-only-required",
		],
		[cloudflarePlayback({ exp: 1 }), "subscriber-expired"],
		[cloudflarePlayback({ draft: 18 }), "subscriber-draft-mismatch"],
	])("reports a locally detectable subscriber setup problem (%#)", async (playbackUrl, issue) => {
		vault({ playbackUrl });
		const response = await GET(request());
		expect(await response.json()).toEqual({
			status: "needs-configuration",
			issues: [issue],
		});
	});

	it.each([
		"VIEWER",
		"OWNER",
	])("enforces the OPERATOR floor and denies view-as (%s)", async (role) => {
		getServerContext.mockResolvedValue({
			tenant: { role, isImpersonating: role === "OWNER" },
		});
		const response = await GET(request());
		expect(response.status).toBe(403);
		expect(revealVersioned).not.toHaveBeenCalled();
		expect(bundle).not.toHaveBeenCalled();
	});

	it("rejects ambiguous parameters before touching tenant storage", async () => {
		const response = await GET(request(`&channelId=${CHANNEL}`));
		expect(response.status).toBe(400);
		expect(getServerContext).not.toHaveBeenCalled();
		expect((await GET(request("&namespaceComponents=2"))).status).toBe(400);
	});

	it("uses the tenant-scoped saved channel plan for a re-air", async () => {
		findUnique.mockResolvedValue({
			status: "STOPPED",
			runs: [{ status: "STOPPED" }],
			stepLog: [committedMoqOutput],
			plan: savedPlan(["one", "two"]),
		});
		const response = await GET(channelRequest());
		expect(findUnique).toHaveBeenCalledWith({
			where: { id: CHANNEL, organizationId: ORGANIZATION },
			select: expect.objectContaining({
				plan: true,
				stepLog: true,
				status: true,
			}),
		});
		expect(await response.json()).toEqual({
			status: "publisher-only",
			issues: ["namespace-unsupported"],
		});
	});

	it("does not call a resumed output ready after the subscription credential was changed", async () => {
		vault({
			playbackUrl: `https://subscriber.example.test/${SUBSCRIBE_TOKEN}`,
			updatedAt: new Date("2026-11-17T00:00:06.000Z"),
		});
		findUnique.mockResolvedValue({
			status: "ERROR",
			runs: [{ status: "ERROR", providerStatus: null }],
			stepLog: [committedMoqOutput],
			plan: savedPlan(["current"]),
		});
		const response = await GET(channelRequest());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "binding-unverified",
			issues: [],
		});
		expect(revealVersioned).not.toHaveBeenCalled();
	});

	it("checks the current configuration for a fresh re-air after a provider-terminal error", async () => {
		findUnique.mockResolvedValue({
			status: "ERROR",
			runs: [
				{
					status: "ERROR",
					providerTerminalAt: new Date("2026-11-17T00:01:00.000Z"),
				},
			],
			stepLog: [committedMoqOutput],
			plan: savedPlan(["current"]),
		});
		expect(await (await GET(channelRequest())).json()).toEqual({
			status: "ready",
			issues: [],
		});
		expect(revealVersioned).toHaveBeenCalledWith(CREDENTIAL);
	});

	it("checks the pristine output that the same-run start will actually execute", async () => {
		findUnique.mockResolvedValue({
			status: "ERROR",
			runs: [{ status: "ERROR" }],
			stepLog: [pendingMoqOutput],
			plan: savedPlan(["imported", "name"]),
		});
		expect(await (await GET(channelRequest())).json()).toEqual({
			status: "ready",
			issues: [],
		});
	});

	it("does not treat an unavailable publishing credential as publishing-only", async () => {
		vault({ provider: "AWS_S3" });
		const response = await GET(request());
		expect(await response.json()).toEqual({
			status: "needs-configuration",
			issues: ["credential-unavailable"],
		});
	});
});
