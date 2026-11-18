import {
	validateVodInputTimeline,
	vodInputFavoritesResponseSchema,
	vodInputPreviewTaskSchema,
} from "@bitovp/core/vod-input-timeline";
import { describe, expect, it, vi } from "vitest";
import { DEMO_BUCKET, DEMO_STORAGE_ID } from "./fixtures";
import { createDemoTransport } from "./transport";

const previewUrl = "/api/vod/input-previews";
const favoritesUrl = "/api/vod/input-favorites";
const sample = {
	key: "selected_sample",
	credentialId: DEMO_STORAGE_ID,
	bucket: DEMO_BUCKET,
	objectKey: "samples/big-buck-bunny-10s.mp4",
};
const body = (value: unknown) => ({
	method: "POST",
	body: JSON.stringify(value),
});

describe("VOD demo source editing", () => {
	it("supplies placement facts matching the source selected in the wizard", async () => {
		const assetFetch = vi.fn<typeof fetch>();
		const demo = createDemoTransport({ assetFetch });
		const response = await demo.fetch(
			previewUrl,
			body({ kind: "PROBE", sources: [sample] }),
		);
		expect(response.status).toBe(200);
		const task = vodInputPreviewTaskSchema.parse((await response.json()).task);
		expect(task).toMatchObject({
			kind: "PROBE",
			status: "SUCCEEDED",
			result: {
				sources: [
					{
						key: sample.key,
						durationMs: 10_000,
						video: { streamIndex: 0 },
						audio: { streamIndex: 1 },
					},
				],
			},
		});
		const clip = {
			id: "00000000-0000-4000-8000-000000000091",
			sourceKey: sample.key,
			startMs: 500,
			inMs: 1000,
			outMs: 7000,
		};
		expect(
			validateVodInputTimeline(
				{
					schemaVersion: 2,
					id: "00000000-0000-4000-8000-000000000092",
					audioEnabled: true,
					durationMs: 6500,
					videoClips: [clip],
					audioClips: [clip],
				},
				task.result?.sources ?? [],
			),
		).toEqual([]);
		const queried = await demo.fetch(`${previewUrl}/${task.id}`);
		expect(await queried.json()).toEqual({ task });
		expect(assetFetch).not.toHaveBeenCalled();
		demo.reset();
		expect((await demo.fetch(`${previewUrl}/${task.id}`)).status).toBe(404);
	});

	it("accepts only the sample reference and keeps fixed sources in demo state", async () => {
		const demo = createDemoTransport();
		const external = await demo.fetch(
			previewUrl,
			body({
				kind: "PROBE",
				sources: [{ ...sample, objectKey: "customer-source.mp4" }],
			}),
		);
		expect(external.status).toBe(422);
		const malformed = await demo.fetch(previewUrl, body({ kind: "PROBE" }));
		expect(malformed.status).toBe(400);
		const empty = vodInputFavoritesResponseSchema.parse(
			await (await demo.fetch(favoritesUrl)).json(),
		);
		expect(empty.favorites).toEqual([]);
		const { credentialId, bucket, objectKey } = sample;
		const pin = body({
			credentialId,
			bucket,
			objectKey,
			label: "Sample",
			kind: "VIDEO",
		});
		expect((await demo.fetch(favoritesUrl, pin)).status).toBe(201);
		await demo.fetch(favoritesUrl, pin);
		const {
			favorites: [saved, ...duplicates],
		} = vodInputFavoritesResponseSchema.parse(
			await (await demo.fetch(favoritesUrl)).json(),
		);
		expect(saved).toMatchObject({ availability: "AVAILABLE", inputKind: "S3" });
		expect(duplicates).toEqual([]);
		expect(
			(await demo.fetch(`${favoritesUrl}/${saved?.id}`, { method: "DELETE" }))
				.status,
		).toBe(204);
		expect(await (await demo.fetch(favoritesUrl)).json()).toEqual({
			favorites: [],
		});
		await demo.fetch(favoritesUrl, pin);
		demo.reset();
		expect(await (await demo.fetch(favoritesUrl)).json()).toEqual({
			favorites: [],
		});
	});
});
