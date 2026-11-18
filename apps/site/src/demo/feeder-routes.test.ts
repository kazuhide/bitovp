import { describe, expect, it, vi } from "vitest";
import { DEMO_BUCKET, DEMO_LIVE_CHANNEL_ID, DEMO_STORAGE_ID } from "./fixtures";
import { createDemoTransport } from "./transport";

const sessions = "/api/feeder-sessions";
const sampleId = "00000000-0000-4000-8000-000000000801";
const sampleKey = "samples/big-buck-bunny-10s.mp4";
const post = (body: unknown): RequestInit => ({
	method: "POST",
	body: JSON.stringify(body),
});

const sampleRequest = {
	liveChannelId: DEMO_LIVE_CHANNEL_ID,
	source: {
		credentialId: DEMO_STORAGE_ID,
		bucket: DEMO_BUCKET,
		key: sampleKey,
	},
	protocol: "RTMP",
	target: { url: "rtmp://203.0.113.10/live", streamKey: "demo-stream-key" },
};

function fixture() {
	const assetFetch = vi.fn<typeof fetch>();
	let time = Date.parse("2026-11-19T00:00:00Z");
	return {
		transport: createDemoTransport({ now: () => time, assetFetch }),
		assetFetch,
		advance(ms: number) {
			time += ms;
		},
	};
}

describe("simulated pseudo-live file input", () => {
	it("lists an ended session and opens its log only through diagnostics", async () => {
		const { transport, assetFetch } = fixture();
		const list = await transport.fetch(
			`${sessions}?liveChannelId=${DEMO_LIVE_CHANNEL_ID}`,
		);
		expect(list.status).toBe(200);
		const { items } = await list.json();
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			id: sampleId,
			liveChannelId: DEMO_LIVE_CHANNEL_ID,
			status: "STOPPED",
			sourceKey: sampleKey,
		});
		expect(items[0]).not.toHaveProperty("logTail");
		const detail = await (
			await transport.fetch(`${sessions}/${sampleId}`)
		).json();
		expect(detail).toMatchObject({ id: sampleId, stoppable: false });
		expect(detail).not.toHaveProperty("logTail");
		expect(detail.target).not.toHaveProperty("streamKey");
		const log = await (
			await transport.fetch(`${sessions}/${sampleId}?diagnostics=1`)
		).json();
		expect(log.logTail).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/\[demo\] RTMP input connected/),
				expect.stringMatching(/\[demo\] File input stopped/),
			]),
		);
		expect(log.loopBoundaryCount).toBeGreaterThan(0);
		expect(log.recentLoopBoundaries[0]).toMatchObject({
			loopIndex: 1,
			streamTimeSec: 10,
		});
		expect(assetFetch).not.toHaveBeenCalled();
	});

	it("simulates starting a sample and stopping or removing it in the browser", async () => {
		const { transport, advance } = fixture();
		async function listFeederCount() {
			const { items } = (await (
				await transport.fetch("/api/live-channels")
			).json()) as {
				items: { id: string; health: { activeFeeders: number } }[];
			};
			return items.find(({ id }) => id === DEMO_LIVE_CHANNEL_ID)?.health
				.activeFeeders;
		}
		const response = await transport.fetch(sessions, post(sampleRequest));
		expect(response.status).toBe(201);
		const { id } = await response.json();
		const selected = `${sessions}/${id}`;
		expect(await (await transport.fetch(selected)).json()).toMatchObject({
			status: "PUSHING",
			stoppable: true,
		});
		expect(await listFeederCount()).toBe(1);
		expect((await transport.fetch(selected, { method: "DELETE" })).status).toBe(
			409,
		);
		advance(25_000);
		const stop = await transport.fetch(
			`${selected}/actions`,
			post({ action: "stop" }),
		);
		expect(stop.status).toBe(200);
		expect(await (await transport.fetch(selected)).json()).toMatchObject({
			status: "STOPPED",
			stoppable: false,
		});
		expect(await listFeederCount()).toBe(0);
		const diagnostics = await (
			await transport.fetch(`${selected}?diagnostics=1`)
		).json();
		expect(diagnostics.loopBoundaryCount).toBe(2);
		expect((await transport.fetch(selected, { method: "DELETE" })).status).toBe(
			204,
		);
		expect((await transport.fetch(selected)).status).toBe(404);
		transport.reset();
		expect(await (await transport.fetch(sessions)).json()).toMatchObject({
			items: [{ id: sampleId, status: "STOPPED" }],
		});
	});

	it("refuses a custom input or destination without recording it", async () => {
		const { transport, assetFetch } = fixture();
		for (const request of [
			{
				...sampleRequest,
				source: { ...sampleRequest.source, key: "private.mp4" },
			},
			{
				...sampleRequest,
				target: {
					...sampleRequest.target,
					url: "rtmp://elsewhere.invalid/live",
				},
			},
		]) {
			expect((await transport.fetch(sessions, post(request))).status).toBe(501);
		}
		const { items } = await (await transport.fetch(sessions)).json();
		expect(items).toHaveLength(1);
		expect(assetFetch).not.toHaveBeenCalled();
	});

	it("keeps one active file input per channel and follows the channel lifecycle", async () => {
		const { transport } = fixture();
		const channel = `/api/live-channels/${DEMO_LIVE_CHANNEL_ID}`;
		const first = await transport.fetch(sessions, post(sampleRequest));
		expect(first.status).toBe(201);
		const { id: previousId } = await first.json();
		expect((await transport.fetch(sessions, post(sampleRequest))).status).toBe(
			409,
		);
		const switched = await transport.fetch(
			sessions,
			post({ ...sampleRequest, switchFromActive: true }),
		);
		expect(switched.status).toBe(201);
		const { id } = await switched.json();
		expect(
			await (await transport.fetch(`${sessions}/${previousId}`)).json(),
		).toMatchObject({
			status: "STOPPED",
		});
		expect(
			(await transport.fetch(`${channel}/actions`, post({ action: "stop" })))
				.status,
		).toBe(200);
		expect(
			await (await transport.fetch(`${sessions}/${id}`)).json(),
		).toMatchObject({
			status: "STOPPED",
		});
		expect((await transport.fetch(sessions, post(sampleRequest))).status).toBe(
			409,
		);
		expect((await transport.fetch(channel, { method: "DELETE" })).status).toBe(
			204,
		);
		expect(await (await transport.fetch(sessions)).json()).toMatchObject({
			items: [],
		});
	});
});
