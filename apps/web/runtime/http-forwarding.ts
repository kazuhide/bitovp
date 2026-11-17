import {
	type IncomingMessage,
	type RequestOptions,
	request,
	type ServerResponse,
} from "node:http";
import { Transform } from "node:stream";
import {
	MOQ_ARCHIVE_BODY_TIMEOUT_MS,
	MOQ_ARCHIVE_MAX_UPLOADS,
} from "../config/moq-policy";
import {
	declaredBodyTooLarge,
	publicRequestBodyPolicy,
} from "../src/lib/server/request-body-limits";

function rejectBody(
	incoming: IncomingMessage,
	outgoing: ServerResponse,
	error: string,
	status = 413,
) {
	incoming.pause();
	const body = JSON.stringify({ error });
	outgoing.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		connection: "close",
	});
	// Destroying IncomingMessage sooner also destroys the response's socket.
	outgoing.end(body, () => incoming.destroy());
}

let archiveUploads = 0;

export function forwardHttpRequest(
	incoming: IncomingMessage,
	outgoing: ServerResponse,
	options: RequestOptions,
	connect: typeof request = request,
) {
	const policy = publicRequestBodyPolicy(incoming.method, incoming.url);
	if (
		policy &&
		declaredBodyTooLarge(incoming.headers["content-length"], policy.limit)
	) {
		rejectBody(incoming, outgoing, policy.error);
		return;
	}
	if (policy?.archive && archiveUploads >= MOQ_ARCHIVE_MAX_UPLOADS) {
		rejectBody(incoming, outgoing, "MoQ archive upload is busy", 429);
		return;
	}
	let bodyDeadline: ReturnType<typeof setTimeout> | undefined;
	if (policy?.archive) {
		archiveUploads++;
		let held = true;
		const release = () => {
			if (!held) return;
			held = false;
			clearTimeout(bodyDeadline);
			archiveUploads--;
		};
		outgoing.once("finish", release);
		outgoing.once("close", release);
	}
	let rejected = false;
	let counter: Transform | undefined;
	const upstream = connect(options, (response) => {
		clearTimeout(bodyDeadline);
		if (rejected) {
			response.resume();
			return;
		}
		if (policy && !counter?.writableFinished) {
			// Input can end while unchecked chunks remain queued in the transform.
			incoming.unpipe(counter);
			incoming.pause();
			counter?.unpipe(upstream);
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
		clearTimeout(bodyDeadline);
		if (rejected || outgoing.writableEnded) return;
		if (outgoing.headersSent) {
			outgoing.destroy();
			return;
		}
		outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
		outgoing.end("Application is starting or unavailable");
	});
	incoming.on("aborted", () => {
		clearTimeout(bodyDeadline);
		counter?.destroy();
		upstream.destroy();
	});
	outgoing.on("close", () => {
		clearTimeout(bodyDeadline);
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
	if (policy.archive) {
		bodyDeadline = setTimeout(() => {
			if (rejected || outgoing.writableEnded || outgoing.headersSent) return;
			rejected = true;
			incoming.unpipe(counter);
			counter?.destroy();
			upstream.destroy();
			rejectBody(incoming, outgoing, "MoQ archive body timed out", 408);
		}, MOQ_ARCHIVE_BODY_TIMEOUT_MS);
		bodyDeadline.unref();
		upstream.once("finish", () => clearTimeout(bodyDeadline));
	}
	incoming.pipe(counter).pipe(upstream);
}
