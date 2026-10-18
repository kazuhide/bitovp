import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { validateIpCidrs } from "@bitovp/core";
import { ingressHeaders } from "./ip-forwarding";

const envFile = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const port = Number(process.env.PORT ?? 3100);
const privatePort = Number(process.env.BITOVP_INTERNAL_PORT ?? 3105);
if (
	!Number.isInteger(port) ||
	!Number.isInteger(privatePort) ||
	port === privatePort ||
	port < 1 ||
	port > 65535 ||
	privatePort < 1 ||
	privatePort > 65535
)
	throw new Error("Invalid ingress port configuration");
const trusted = (process.env.TRUSTED_PROXY_CIDRS ?? "")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);
if (!validateIpCidrs(trusted)) throw new Error("Invalid TRUSTED_PROXY_CIDRS");
const secret = process.env.AUTH_SESSION_SECRET;
if (process.env.AUTH_MODE === "users" && !secret)
	throw new Error("AUTH_SESSION_SECRET is required");
const cli = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(
	process.execPath,
	[
		cli,
		process.argv.includes("--dev") ? "dev" : "start",
		"-p",
		String(privatePort),
		"-H",
		"127.0.0.1",
	],
	{ stdio: "inherit", env: process.env },
);

const server = createServer((incoming, outgoing) => {
	const headers = ingressHeaders(
		incoming.headers,
		incoming.socket.remoteAddress,
		secret,
		trusted,
	);
	const upstream = request(
		{
			hostname: "127.0.0.1",
			port: privatePort,
			method: incoming.method,
			path: incoming.url,
			headers,
		},
		(response) => {
			outgoing.writeHead(response.statusCode ?? 502, response.headers);
			response.pipe(outgoing);
			response.on("error", () => outgoing.destroy());
		},
	);
	upstream.on("error", () => {
		if (!outgoing.headersSent)
			outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
		outgoing.end("Application is starting or unavailable");
	});
	incoming.on("aborted", () => upstream.destroy());
	outgoing.on("close", () => {
		if (!outgoing.writableFinished) upstream.destroy();
	});
	incoming.pipe(upstream);
});
server.on("upgrade", (incoming, socket, head) => {
	const headers = ingressHeaders(
		incoming.headers,
		incoming.socket.remoteAddress,
		secret,
		trusted,
	);
	const upstream = request({
		hostname: "127.0.0.1",
		port: privatePort,
		method: incoming.method,
		path: incoming.url,
		headers,
	});
	upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
		socket.write(
			`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n${response.rawHeaders.reduce((text, value, i) => text + (i % 2 === 0 ? `${value}: ` : `${value}\r\n`), "")}\r\n`,
		);
		if (head.length) upstreamSocket.write(head);
		if (upstreamHead.length) socket.write(upstreamHead);
		upstreamSocket.pipe(socket).pipe(upstreamSocket);
		upstreamSocket.on("error", () => socket.destroy());
		socket.on("error", () => upstreamSocket.destroy());
	});
	upstream.on("response", () => socket.destroy());
	upstream.on("error", () => socket.destroy());
	upstream.end();
});
server.listen(port, process.env.BITOVP_BIND_HOST ?? "127.0.0.1");
let stopping = false;
function stop() {
	if (stopping) return;
	stopping = true;
	server.close();
	child.kill("SIGTERM");
	setTimeout(() => {
		child.kill("SIGKILL");
		process.exit(1);
	}, 5000).unref();
}
server.on("error", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", stop);
child.on("exit", (code) => {
	server.close();
	process.exit(stopping ? 0 : (code ?? 1));
});
