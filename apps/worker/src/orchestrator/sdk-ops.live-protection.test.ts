import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileLiveChannel,
	curlForStep,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());
const key = "0".repeat(32);
for (const kind of ["CENC", "FAIRPLAY", "SPEKE"] as const)
	it(`serializes Live ${kind} encrypted outputs and manifest references through the installed SDK`, async () => {
		const calls: { path: string; body: Record<string, unknown> }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push({
					path: new URL(url).pathname,
					body: JSON.parse(init.body as string),
				});
				return new Response(
					JSON.stringify({ data: { result: { id: "created" } } }),
					{ status: 201, headers: { "content-type": "application/json" } },
				);
			}),
		);
		const raw = JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				),
				"utf8",
			),
		);
		raw.bitmovin.fallbackCloudRegions = ["AWS_US_WEST_2", "AUTO"];
		raw.drm = raw.muxings.map(
			(m: { key: string; destination: Record<string, unknown> }) => ({
				key: `${m.key}-enc`,
				kind,
				muxingKey: m.key,
				credentialId: "00000000-0000-4000-8000-000000000003",
				destination: m.destination,
				...(kind === "CENC"
					? {
							kid: "a".repeat(32),
							encryptionMode: "CBC",
							fairPlay: { iv: "b".repeat(32), uri: "skd://synthetic" },
						}
					: kind === "FAIRPLAY"
						? { iv: "b".repeat(32), uri: "skd://synthetic" }
						: { systemIds: ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"] }),
			}),
		);
		raw.muxings = raw.muxings.map((m: Record<string, unknown>) => {
			const { destination: _d, ...rest } = m;
			return rest;
		});
		raw.liveManifests = raw.liveManifests.map((m: Record<string, unknown>) => ({
			...m,
			drmKind: kind,
		}));
		const ops = compileLiveChannel(liveChannelPlanSchema.parse(raw));
		const ids = new Map(ops.map((o, i) => [o.step, `resource-${i}`]));
		const snapshots: unknown[] = [];
		const sdk = createBitmovinSdkOps(
			{
				apiKey: "synthetic-only",
				tenantOrgId: null,
				bitmovinAccountId: "synthetic-account",
			},
			async (s) => {
				snapshots.push(s);
			},
		);
		const resolveCredential = vi.fn(
			async (): Promise<{
				provider: string;
				config: Record<string, unknown>;
				secret: Record<string, string>;
			}> => ({
				provider: kind === "SPEKE" ? "DRM_SPEKE" : "DRM_CENC",
				config: {},
				secret:
					kind === "SPEKE"
						? {
								url: "https://keys.example.test/speke",
								username: "synthetic-user",
								password: "never-log",
							}
						: { key },
			}),
		);

		for (const op of ops.filter((o) =>
			[
				"CREATE_ENCODING",
				`CREATE_DRM_${kind}`,
				"CREATE_HLS_STREAM_INFO",
				"CREATE_HLS_AUDIO_MEDIA",
				"CREATE_DASH_CONTENT_PROTECTION",
			].includes(o.kind),
		)) {
			const result = await executeStep(op, {
				sdk,
				ids,
				resolveCredential,
				poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
			});
			const call = calls.at(-1);
			expect(call).toBeDefined();
			if (op.kind === "CREATE_ENCODING")
				expect(call?.body.fallbackCloudRegions).toEqual([
					"AWS_US_WEST_2",
					"AUTO",
				]);
			if (op.kind === `CREATE_DRM_${kind}`) {
				expect(call?.path).toContain(`/drm/${kind.toLowerCase()}`);
				expect(call?.body.outputs).toEqual([
					{
						outputId: ids.get(String(op.refs.outputId)),
						outputPath: op.payload.outputPath,
					},
				]);
				if (kind !== "SPEKE") expect(call?.body.key).toBe(key);
			}
			if (
				[
					"CREATE_HLS_STREAM_INFO",
					"CREATE_HLS_AUDIO_MEDIA",
					"CREATE_DASH_CONTENT_PROTECTION",
				].includes(op.kind)
			) {
				expect(call?.body.drmId).toBe(ids.get(String(op.refs.drmId)));
				if (op.kind !== "CREATE_DASH_CONTENT_PROTECTION")
					expect(call?.body.segmentPath).toBe(op.payload.segmentPath);
				const entry = {
					...op,
					status: "DONE" as const,
					request: result.request,
				};
				const before = JSON.stringify(entry);
				const curl = curlForStep(entry);
				expect(curl.ok).toBe(true);
				if (!curl.ok) throw new Error("Missing manifest cURL command");
				const data = curl.command.match(/--data '([\s\S]*)'$/)?.[1];
				expect(data).toBeDefined();
				expect(JSON.parse((data as string).replaceAll("'\\''", "'"))).toEqual(
					call?.body,
				);
				expect(curl.command).toContain(call?.path);
				expect(JSON.stringify(entry)).toBe(before);
			}
			if (op.kind === `CREATE_DRM_${kind}`) {
				const curl = curlForStep({
					...op,
					status: "DONE",
					request: result.request,
				});
				expect(curl).toEqual({
					ok: false,
					code: "VAULT_FIELDS_OMITTED",
					kind: op.kind,
				});
			}
		}
		expect(JSON.stringify(snapshots)).not.toContain(key);
		expect(JSON.stringify(snapshots)).not.toContain("never-log");
	});
