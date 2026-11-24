import { loadEnv } from "@bitovp/core";
import { Redis } from "ioredis";
import { NextResponse } from "next/server";
import { authError } from "@/lib/auth/route-context";
import { requirePlatformOwner } from "@/lib/auth/tenancy";
import { redisMemorySchema } from "@/lib/platform-redis-memory";

async function readMemory() {
	const redis = new Redis(loadEnv().REDIS_URL, {
		lazyConnect: true,
		enableReadyCheck: false,
		enableOfflineQueue: false,
		connectTimeout: 1_000,
		commandTimeout: 1_000,
		maxRetriesPerRequest: 0,
		retryStrategy: () => null,
	});
	// ioredis emits a separate error event as well as rejecting the read.
	redis.on("error", () => {});
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		const info = await Promise.race([
			redis.connect().then(() => redis.info("memory")),
			new Promise<never>((_, reject) => {
				deadline = setTimeout(() => reject(new Error("Redis timeout")), 2_000);
			}),
		]);
		const usedBytes = Number(/^used_memory:(\d+)\r?$/m.exec(info)?.[1]);
		const maxBytes = Number(/^maxmemory:(\d+)\r?$/m.exec(info)?.[1]);
		return redisMemorySchema.parse({
			usedBytes,
			limitBytes: maxBytes === 0 ? null : maxBytes,
		});
	} finally {
		clearTimeout(deadline);
		redis.disconnect();
	}
}

export async function GET(request: Request) {
	try {
		await requirePlatformOwner(request.headers);
	} catch (error) {
		const response = authError(error);
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	}
	const headers = { "Cache-Control": "private, no-store" };
	try {
		return NextResponse.json(await readMemory(), { headers });
	} catch {
		return NextResponse.json(
			{ error: "Redis memory is unavailable" },
			{ status: 503, headers },
		);
	}
}
