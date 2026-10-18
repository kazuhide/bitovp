import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import {
	playbackLinksForLivePlan,
	playbackLinksForPlan,
} from "./playback-links";

/**
 * The server half of the derivation move . The URL
 * shapes are pinned in `packages/core/src/playback`; what belongs here is the
 * database access, and two properties of it that no rendering test can see:
 * only the credentials the plan REFERENCES are read, and only the non-secret
 * columns are selected.
 */

const PLAN = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"../../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
		),
		"utf8",
	),
) as { outputs: { credentialId: string }[] };

const OUT_CRED = PLAN.outputs[0]?.credentialId ?? "";

function ctxFor(
	rows: { id: string; provider: string; config: unknown }[],
	spy?: (args: unknown) => void,
): ServerContext {
	return {
		prisma: {
			credential: {
				findMany: vi.fn(async (args: unknown) => {
					spy?.(args);
					return rows;
				}),
			},
		},
	} as unknown as ServerContext;
}

describe("playbackLinksForPlan", () => {
	it("derives the link from the referenced credential's config", async () => {
		const links = await playbackLinksForPlan(
			ctxFor([
				{
					id: OUT_CRED,
					provider: "AWS_S3",
					config: { region: "ap-northeast-1" },
				},
			]),
			PLAN,
		);
		expect(links).toHaveLength(1);
		expect(links[0]?.url).toBe(
			"https://sample-output-bucket.s3.ap-northeast-1.amazonaws.com/output/h264-aac-fmp4-fixed-bitrate-hls-aws/stream.m3u8",
		);
	});

	it("reads only the plan's own credentials, and only its non-secret columns", async () => {
		const seen: unknown[] = [];
		await playbackLinksForPlan(
			ctxFor(
				[{ id: OUT_CRED, provider: "AWS_S3", config: { region: "eu-west-1" } }],
				(args) => seen.push(args),
			),
			PLAN,
		);
		expect(seen).toHaveLength(1);
		const args = seen[0] as {
			where: { id: { in: string[] } };
			select: Record<string, boolean>;
		};
		// Not `list`: a page that renders one job has no business reading every
		// credential in the vault.
		expect(args.where.id.in).toEqual([OUT_CRED]);
		expect(args.select).toEqual({ id: true, provider: true, config: true });
		// The ciphertext column is never named. Selecting it would decrypt
		// nothing, but it would put encrypted secret material one `...row` away
		// from a JSON response.
		expect(Object.keys(args.select)).not.toContain("secret");
	});

	it("returns nothing, and does not query, for a plan that does not parse", async () => {
		const seen: unknown[] = [];
		const links = await playbackLinksForPlan(
			ctxFor([], (args) => seen.push(args)),
			{ planVersion: 1, name: "draft" },
		);
		// A DRAFT row reaches this route; the page must render without manifests
		// rather than 500.
		expect(links).toEqual([]);
		expect(seen).toEqual([]);
	});

	it("still returns a named reason when the credential row is gone", async () => {
		const links = await playbackLinksForPlan(ctxFor([]), PLAN);
		expect(links[0]?.url).toBeNull();
		expect(links[0]?.reason?.code).toBe("NO_CREDENTIAL");
	});

	it("de-duplicates credential ids shared by several outputs", async () => {
		const seen: unknown[] = [];
		const plan = {
			...PLAN,
			outputs: [...PLAN.outputs, ...PLAN.outputs.map((o) => ({ ...o }))],
		};
		// Two outputs, one credential — the query must not ask for it twice.
		await playbackLinksForPlan(
			ctxFor(
				[{ id: OUT_CRED, provider: "AWS_S3", config: { region: "eu-west-1" } }],
				(args) => seen.push(args),
			),
			plan,
		);
		const args = seen[0] as { where: { id: { in: string[] } } };
		expect(args.where.id.in).toEqual([OUT_CRED]);
	});
});

/**
 * The Akamai MSL channel (2026-09-02). Measured on channel 0645c2f1 before
 * this: `{ url: null, via: "none", reason: NO_PATTERN/OTHER }` for every
 * manifest, because MSL has no bucket. The credential's `edgeBaseUrl` is
 * plain config, so the same `{id, provider, config}` select the route already
 * makes is enough — no wider read, and never the ciphertext column.
 */
describe("playbackLinksForLivePlan — an AKAMAI_MSL channel", () => {
	const LIVE_PLAN = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../packages/core/src/live/__fixtures__/live-akamai-msl.plan.json",
			),
			"utf8",
		),
	) as { outputs: { credentialId: string }[] };
	const MSL_CRED = LIVE_PLAN.outputs[0]?.credentialId ?? "";
	const ROOT =
		"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/bitmovinhlsjp20260821";

	it("hands out <edgeBaseUrl>/<manifestName> from the credential row's config", async () => {
		const seen: unknown[] = [];
		const links = await playbackLinksForLivePlan(
			ctxFor(
				[
					{
						id: MSL_CRED,
						provider: "AKAMAI_MSL",
						config: {
							streamId: 2126636,
							eventName: "bitmovinhlsjp20260821",
							edgeBaseUrl: ROOT,
						},
					},
				],
				(args) => seen.push(args),
			),
			LIVE_PLAN,
		);
		expect(links.map((l) => [l.kind, l.url, l.via])).toEqual([
			["HLS", `${ROOT}/stream.m3u8`, "credential-edge"],
			["DASH", `${ROOT}/stream.mpd`, "credential-edge"],
		]);
		const args = seen[0] as { select: Record<string, boolean> };
		expect(args.select).toEqual({ id: true, provider: true, config: true });
	});

	it("names the credential to configure when the row has no edge root", async () => {
		const links = await playbackLinksForLivePlan(
			ctxFor([
				{
					id: MSL_CRED,
					provider: "AKAMAI_MSL",
					config: { streamId: 2126636, eventName: "bitmovinhlsjp20260821" },
				},
			]),
			LIVE_PLAN,
		);
		for (const link of links) {
			expect(link.url).toBeNull();
			expect(link.reason).toEqual({
				code: "MSL_EDGE_URL_NOT_CONFIGURED",
				credentialId: MSL_CRED,
			});
		}
	});
});
