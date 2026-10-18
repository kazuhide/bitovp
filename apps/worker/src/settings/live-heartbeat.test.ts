import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it } from "vitest";
import { readLiveHeartbeatConfig } from "./live-heartbeat";

/**
 * hb-life finding 1: the registrar's read of Settings → Live must fall back
 * to the deployment default when the row cannot be READ — never to `null`,
 * because null is the OFF switch and a database blip would otherwise retire
 * every live account's heartbeat hook with nothing red.
 */
function prisma(findUnique: () => Promise<unknown>): AppPrismaClient {
	return { appSetting: { findUnique } } as unknown as AppPrismaClient;
}

describe("readLiveHeartbeatConfig — the worker's at-use read", () => {
	it("a throwing read is the deployment default (env), not OFF", async () => {
		const failing = prisma(async () => {
			throw new Error("connection reset");
		});
		await expect(
			readLiveHeartbeatConfig(failing, {
				HEARTBEAT_WEBHOOK_INTERVAL_S: "7",
				HEARTBEAT_WEBHOOK_IDLE_MINUTES: "3",
			}),
		).resolves.toEqual({ mode: "PER_ENCODING", intervalS: 7, idleMs: 180_000 });
		await expect(readLiveHeartbeatConfig(failing, {})).resolves.toEqual({
			intervalS: 20,
			idleMs: 3_600_000,
			mode: "PER_ENCODING",
		});
	});

	it("a malformed row is the deployment default; a good row wins over it", async () => {
		const env = {
			HEARTBEAT_WEBHOOK_INTERVAL_S: "7",
			HEARTBEAT_WEBHOOK_IDLE_MINUTES: "3",
		};
		await expect(
			readLiveHeartbeatConfig(
				prisma(async () => ({ value: "garbage" })),
				env,
			),
		).resolves.toEqual({ mode: "PER_ENCODING", intervalS: 7, idleMs: 180_000 });
		await expect(
			readLiveHeartbeatConfig(
				prisma(async () => ({ value: { intervalS: 30, idleMinutes: 2 } })),
				env,
			),
		).resolves.toEqual({
			mode: "PER_ENCODING",
			intervalS: 30,
			idleMs: 120_000,
		});
	});

	it("OFF is null from either source: a stored 0, or env `off` with no row", async () => {
		await expect(
			readLiveHeartbeatConfig(
				prisma(async () => ({ value: { intervalS: 0, idleMinutes: 60 } })),
				{ HEARTBEAT_WEBHOOK_INTERVAL_S: "7" },
			),
		).resolves.toBeNull();
		await expect(
			readLiveHeartbeatConfig(
				prisma(async () => null),
				{
					HEARTBEAT_WEBHOOK_INTERVAL_S: "off",
				},
			),
		).resolves.toBeNull();
	});
});
