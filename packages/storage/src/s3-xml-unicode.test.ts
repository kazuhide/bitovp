import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createS3Browser } from "./s3";

describe("S3 XML numeric character references", () => {
	it.each([
		{ form: "hexadecimal", reference: "&#x1F600;" },
		{ form: "decimal", reference: "&#128512;" },
	])("preserves a supplementary character from a $form reference through list and GET", async ({
		reference,
	}) => {
		// Exercise the installed SDK's response decoder, without mocking send.
		// String.fromCharCode truncates this valid XML character to U+F600 and
		// makes a subsequent read address a different object.
		const key = "media-😀.mp4";
		const content = Buffer.from("object content");
		const requests: { method: string | undefined; pathname: string }[] = [];
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			requests.push({ method: req.method, pathname: url.pathname });
			if (
				req.method === "GET" &&
				url.pathname === "/test-bucket/" &&
				url.searchParams.get("list-type") === "2"
			) {
				res.writeHead(200, { "content-type": "application/xml" });
				res.end(
					'<?xml version="1.0" encoding="UTF-8"?>' +
						'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
						`<Contents><Key>media-${reference}.mp4</Key><Size>${content.length}</Size></Contents>` +
						"<IsTruncated>false</IsTruncated></ListBucketResult>",
				);
				return;
			}
			if (
				req.method === "GET" &&
				decodeURIComponent(url.pathname) === `/test-bucket/${key}`
			) {
				res.writeHead(200, {
					"content-type": "application/octet-stream",
					"content-length": content.length,
				});
				res.end(content);
				return;
			}
			res.writeHead(404, { "content-type": "application/xml" });
			res.end("<Error><Code>NoSuchKey</Code></Error>");
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const browser = createS3Browser({
			credentials: { accessKeyId: "a", secretAccessKey: "s" },
			region: "us-east-1",
			endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			readTimeoutMs: 1000,
		});
		try {
			const listing = await browser.listObjects({ bucket: "test-bucket" });
			expect(listing.objects).toEqual([
				{ key, size: content.length, lastModified: undefined },
			]);
			const listedKey = listing.objects[0]?.key;
			if (!listedKey) throw new Error("the object was not listed");
			expect(browser.getObject).toBeTypeOf("function");
			const stream = await browser.getObject?.({
				bucket: "test-bucket",
				key: listedKey,
			});
			if (!stream) throw new Error("S3 did not return an object stream");
			const chunks: Buffer[] = [];
			for await (const chunk of stream as Readable) {
				chunks.push(Buffer.from(chunk));
			}
			expect(Buffer.concat(chunks)).toEqual(content);
			expect(requests).toEqual([
				{ method: "GET", pathname: "/test-bucket/" },
				{
					method: "GET",
					pathname: "/test-bucket/media-%F0%9F%98%80.mp4",
				},
			]);
		} finally {
			browser.dispose?.();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		}
	});
});
