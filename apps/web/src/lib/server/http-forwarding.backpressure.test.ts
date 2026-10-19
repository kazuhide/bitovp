import { once } from "node:events";
import {
	type ClientRequest,
	IncomingMessage,
	type ServerResponse,
} from "node:http";
import { Socket } from "node:net";
import { Readable, type Transform, Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { forwardHttpRequest } from "../../../runtime/http-forwarding";

it("keeps an early response when ended input still has an oversized tail queued under backpressure", async () => {
	const incoming = new IncomingMessage(new Socket());
	incoming.method = "POST";
	incoming.url = "/api/webhooks/bitmovin/acct/unknown";
	const received: Buffer[] = [];
	const errors: unknown[] = [];
	let headersSent = false;
	let status = 0;
	const outgoing = new Writable({
		write(chunk, _encoding, callback) {
			received.push(Buffer.from(chunk));
			callback();
		},
	});
	const writeHead = vi.fn((code: number) => {
		if (headersSent) throw new Error("ERR_HTTP_HEADERS_SENT");
		headersSent = true;
		status = code;
	});
	Object.defineProperty(outgoing, "headersSent", { get: () => headersSent });
	Object.assign(outgoing, { writeHead });
	outgoing.on("error", (error) => errors.push(error));
	let hold = false;
	const upstream = new Writable({
		highWaterMark: 1,
		write(_chunk, _encoding, callback) {
			if (!hold) callback();
		},
	});
	upstream.on("error", (error) => errors.push(error));
	let counter: Transform | undefined;
	upstream.on("pipe", (source) => {
		counter = source as Transform;
	});
	let respond: ((response: IncomingMessage) => void) | undefined;
	const mockedRequest = vi.fn((...args: unknown[]) => {
		respond = args.find((arg) => typeof arg === "function") as typeof respond;
		return upstream as unknown as ClientRequest;
	});
	const response = Readable.from([Buffer.from("Not found")]) as IncomingMessage;
	response.statusCode = 404;
	response.headers = {};
	try {
		forwardHttpRequest(
			incoming,
			outgoing as unknown as ServerResponse,
			{},
			mockedRequest,
		);
		expect(mockedRequest).toHaveBeenCalledTimes(1);
		if (!counter)
			throw new Error("The upstream did not receive the counting pipe");
		incoming.push(Buffer.alloc(1_000_000 - 4 * 32768 + 1));
		await new Promise<void>((resolve) => setImmediate(resolve));
		hold = true;
		for (let i = 0; i < 4; i += 1) incoming.push(Buffer.alloc(32768));
		incoming.complete = true;
		incoming.push(null);
		incoming.read(0);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(incoming.readableEnded).toBe(true);
		if (!counter || !respond)
			throw new Error("The forwarding pipeline was not initialized");
		expect(counter.writableFinished).toBe(false);
		expect(counter.writableLength).toBeGreaterThan(0);
		counter.on("error", (error) => errors.push(error));
		const finished = once(outgoing, "finish");
		respond(response);
		let lateError: unknown;
		try {
			while (counter.read() !== null) {
				// Release queued input after the upstream response has won.
			}
		} catch (error) {
			lateError = error;
		}
		counter.destroy();
		await finished;
		expect(lateError).toBeUndefined();
		expect(status).toBe(404);
		expect(Buffer.concat(received).toString()).toBe("Not found");
		expect(writeHead.mock.calls.map(([code]) => code)).toEqual([404]);
		expect(errors).toEqual([]);
	} finally {
		counter?.destroy();
		incoming.destroy();
		response.destroy();
		upstream.destroy();
		outgoing.destroy();
	}
});
