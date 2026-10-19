import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { forwardHttpRequest } from "../../../runtime/http-forwarding";

const servers: Server[] = [];
async function listen(server: Server) {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}
afterEach(async () => {
	for (const server of servers.splice(0).reverse()) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

async function fixture(earlyResponse = false) {
	const received = { requests: 0, bytes: 0, bodies: [] as Buffer[] };
	let firstData: () => void = () => {};
	const forwarded = new Promise<void>((resolve) => {
		firstData = resolve;
	});
	const upstreamPort = await listen(
		createServer((incoming, outgoing) => {
			received.requests += 1;
			incoming.on("error", () => {});
			if (earlyResponse) {
				outgoing.writeHead(404);
				outgoing.end("Not found");
				return;
			}
			const chunks: Buffer[] = [];
			incoming.on("data", (chunk: Buffer) => {
				received.bytes += chunk.byteLength;
				chunks.push(chunk);
				firstData();
			});
			incoming.on("end", () => {
				const body = Buffer.concat(chunks);
				received.bodies.push(body);
				outgoing.end(body);
			});
		}),
	);
	const port = await listen(
		createServer((incoming, outgoing) =>
			forwardHttpRequest(incoming, outgoing, {
				hostname: "127.0.0.1",
				port: upstreamPort,
				method: incoming.method,
				path: incoming.url,
				headers: incoming.headers,
			}),
		),
	);
	return { port, received, forwarded };
}

function client(
	port: number,
	path: string,
	headers: Record<string, string> = {},
) {
	const connection = request({
		hostname: "127.0.0.1",
		port,
		path,
		method: "POST",
		headers,
	});
	const result = new Promise<{ status: number; body: Buffer }>(
		(resolve, reject) => {
			connection.on("response", (response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						body: Buffer.concat(chunks),
					}),
				);
				response.on("error", reject);
			});
			connection.on("error", reject);
			connection.setTimeout(5000, () =>
				connection.destroy(
					new Error("Timed out waiting for an early HTTP response"),
				),
			);
		},
	);
	return { connection, result };
}

describe("HTTP ingress body limits with a loopback upstream", () => {
	it.each([
		"(.)",
		"(..)",
		"(...)",
		"(..)(..)",
	])("rejects indexed %s interception aliases before the client ends", async (marker) => {
		for (const tail of ["token", ""]) {
			const { port, received, forwarded } = await fixture();
			const { connection, result } = client(
				port,
				`/_next/data/current-build/index/api/webhooks/bitmovin/[x]/${marker}${tail}.json`,
				{ "transfer-encoding": "chunked" },
			);
			try {
				connection.write(Buffer.alloc(1_000_000));
				await forwarded;
				connection.write(Buffer.from("!"));
				expect((await result).status).toBe(413);
				expect(received.bytes).toBeLessThanOrEqual(1_000_000);
				expect(received.bodies).toEqual([]);
			} finally {
				connection.destroy();
			}
		}
	});
	const limitedRoutes = [
		["/api/auth/login", 4096],
		["/api/auth/setup", 8192],
		["/api/webhooks/bitmovin/j/token", 1_000_000],
	] as const;
	it.each(
		limitedRoutes,
	)("rejects declared oversize on %s before creating an upstream request", async (path, limit) => {
		const { port, received } = await fixture();
		const { connection, result } = client(port, path, {
			"content-length": String(limit + 1),
		});
		try {
			connection.flushHeaders();
			const response = await result;
			expect(response.status).toBe(413);
			expect(JSON.parse(response.body.toString())).toEqual({
				error: path.includes("webhooks")
					? "Payload too large"
					: "Request body is too large",
			});
			expect(received.requests).toBe(0);
		} finally {
			connection.destroy();
		}
	});
	it.each(
		limitedRoutes,
	)("returns chunked 413 on %s before the client ends and bounds forwarding", async (path, limit) => {
		const { port, received, forwarded } = await fixture();
		const { connection, result } = client(port, path, {
			"transfer-encoding": "chunked",
		});
		try {
			connection.write(Buffer.alloc(limit, 32));
			await forwarded;
			connection.write(Buffer.from("!"));
			const response = await result;
			expect(response.status).toBe(413);
			expect(response.body.toString()).not.toContain("unavailable");
			expect(received.bytes).toBeGreaterThan(0);
			expect(received.bytes).toBeLessThanOrEqual(limit);
			expect(received.bodies).toEqual([]);
		} finally {
			connection.destroy();
		}
	});
	it("rejects declared oversize before the client sends or ends its body", async () => {
		const { port, received } = await fixture();
		const { connection, result } = client(port, "/api/auth/login", {
			"content-length": "4097",
		});
		try {
			connection.flushHeaders();
			expect((await result).status).toBe(413);
			expect(received.requests).toBe(0);
		} finally {
			connection.destroy();
		}
	});
	it.each([
		"/api/%61uth/login",
		"/api%2fauth%2flogin",
		"/api/auth/login/?q=1",
		"/api/other/../auth/login",
		"//api//auth/login",
		"/api\\auth\\login",
		"/_next/data/current-build/api/auth/login.json",
		"/_next/data/current-build/index/api/auth/login.json",
		"/_next/data/current-build/api/%61uth/login.json",
	])("applies the limit to normalized route %s", async (path) => {
		const { port, received } = await fixture();
		const { connection, result } = client(port, path);
		connection.end(Buffer.alloc(4097, 32));
		expect((await result).status).toBe(413);
		expect(received.bytes).toBeLessThanOrEqual(4096);
	});
	it.each([
		["/_next/data/current-build/api/auth/login.json", 4096],
		["/_next/data/current-build/api/auth/setup.json", 8192],
		["/_next/data/current-build/api/webhooks/bitmovin/j/token.json", 1_000_000],
	] as const)("limits a streamed data alias %s before the client ends", async (path, limit) => {
		const { port, received, forwarded } = await fixture();
		const { connection, result } = client(port, path, {
			"transfer-encoding": "chunked",
		});
		try {
			connection.write(Buffer.alloc(limit));
			await forwarded;
			connection.write(Buffer.from("!"));
			expect((await result).status).toBe(413);
			expect(received.bytes).toBeLessThanOrEqual(limit);
			expect(received.bodies).toEqual([]);
		} finally {
			connection.destroy();
		}
	});
	it.each([
		["/api/auth/login", 4096],
		["/api/auth/setup", 8192],
		["/api/webhooks/bitmovin/j/token", 1_000_000],
		["/api/encoding-jobs", 20_000],
		["/api/live-channels", 20_000],
		["/_next/data/current-build/api/auth/login.json", 4096],
		["/_next/data/current-build/api/auth/setup.json", 8192],
		["/_next/data/current-build/api/webhooks/bitmovin/j/token.json", 1_000_000],
		["/_next/data/current-build/api/encoding-jobs.json", 20_000],
		["/_next/data/current-build/api/live-channels.json", 20_000],
		["/_next/data/current-build/index/api/encoding-jobs.json", 20_000],
		["/_next/data/current-build/index/api/live-channels.json", 20_000],
	] as const)("preserves every byte on %s", async (path, length) => {
		const { port, received } = await fixture();
		const body = Buffer.alloc(length, 0xc3);
		const { connection, result } = client(port, path, {
			"content-length": String(body.length),
		});
		connection.end(body);
		const response = await result;
		expect(response.status).toBe(200);
		expect(response.body).toEqual(body);
		expect(received.bodies).toEqual([body]);
	});
	it("preserves a route response that arrives before the size limit is reached", async () => {
		const { port } = await fixture(true);
		const { connection, result } = client(
			port,
			"/api/webhooks/bitmovin/acct/unknown",
		);
		try {
			connection.write("small prefix");
			const response = await result;
			expect(response.status).toBe(404);
			expect(response.body.toString()).toBe("Not found");
		} finally {
			connection.destroy();
		}
	});
});
