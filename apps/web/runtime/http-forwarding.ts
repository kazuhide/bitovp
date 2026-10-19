import {
	type IncomingMessage,
	type RequestOptions,
	request,
	type ServerResponse,
} from "node:http";
import { Transform } from "node:stream";
import {
	declaredBodyTooLarge,
	publicRequestBodyPolicy,
} from "../src/lib/server/request-body-limits";

function rejectBody(
	incoming: IncomingMessage,
	outgoing: ServerResponse,
	error: string,
) {
	incoming.pause();
	const body = JSON.stringify({ error });
	outgoing.writeHead(413, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		connection: "close",
	});
	// Destroying IncomingMessage sooner also destroys the response's socket.
	outgoing.end(body, () => incoming.destroy());
}

export function forwardHttpRequest(
	incoming: IncomingMessage,
	outgoing: ServerResponse,
	options: RequestOptions,
) {
	const policy = publicRequestBodyPolicy(incoming.method, incoming.url);
	if (
		policy &&
		declaredBodyTooLarge(incoming.headers["content-length"], policy.limit)
	) {
		rejectBody(incoming, outgoing, policy.error);
		return;
	}
	let rejected = false;
	let counter: Transform | undefined;
	const upstream = request(options, (response) => {
		if (rejected) {
			response.resume();
			return;
		}
		if (policy && !incoming.readableEnded) {
			// A completed early route response wins before any size violation.
			incoming.unpipe(counter);
			incoming.pause();
			counter?.destroy();
			outgoing.once("finish", () => {
				upstream.destroy();
				incoming.destroy();
			});
		}
		outgoing.writeHead(response.statusCode ?? 502, response.headers);
		response.pipe(outgoing);
		response.on("error", () => outgoing.destroy());
	});
	upstream.on("error", () => {
		if (rejected || outgoing.writableEnded) return;
		if (outgoing.headersSent) {
			outgoing.destroy();
			return;
		}
		outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
		outgoing.end("Application is starting or unavailable");
	});
	incoming.on("aborted", () => {
		counter?.destroy();
		upstream.destroy();
	});
	outgoing.on("close", () => {
		if (!outgoing.writableFinished) {
			counter?.destroy();
			upstream.destroy();
		}
	});
	if (!policy) {
		incoming.pipe(upstream);
		return;
	}
	let received = 0;
	counter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			if (chunk.byteLength > policy.limit - received) {
				rejected = true;
				incoming.unpipe(counter);
				incoming.pause();
				counter?.unpipe(upstream);
				upstream.destroy();
				rejectBody(incoming, outgoing, policy.error);
				callback(new Error("Request body is too large"));
				return;
			}
			received += chunk.byteLength;
			callback(null, chunk);
		},
	});
	counter.on("error", () => {});
	incoming.pipe(counter).pipe(upstream);
}
