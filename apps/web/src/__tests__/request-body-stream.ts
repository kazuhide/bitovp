export function streamedRequest(
	url: string,
	chunks: Uint8Array[],
	options: {
		contentLength?: string;
		cancel?: () => Promise<void> | void;
		headers?: Record<string, string>;
	} = {},
) {
	const reads = { pulls: 0, cancellations: 0 };
	let index = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				reads.pulls += 1;
				const chunk = chunks[index++];
				if (chunk) controller.enqueue(chunk);
				else controller.close();
			},
			cancel() {
				reads.cancellations += 1;
				return options.cancel?.();
			},
		},
		{ highWaterMark: 0 },
	);
	const init: RequestInit & { duplex: "half" } = {
		method: "POST",
		body,
		duplex: "half",
		headers: {
			...options.headers,
			...(options.contentLength === undefined
				? {}
				: { "content-length": options.contentLength }),
		},
	};
	return { request: new Request(url, init), reads };
}
