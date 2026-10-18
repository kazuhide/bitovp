import { createHash, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	GetObjectCommand,
	ListBucketsCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Browser } from "./s3";

/**
 * `?x-id=<Operation>` must not reach an S3-COMPATIBLE endpoint.
 *
 * aws-sdk-js adds that parameter to identify a request. It means nothing to the
 * service, but it IS part of the canonical query string, and both Akamai
 * Object Storage and GCS's HMAC interop endpoint refuse the SERVICE-LEVEL
 * request that carries it — 403 SignatureDoesNotMatch and 400 InvalidArgument
 * respectively, so the signature gets the blame.
 *
 * Not a blanket canonicalisation bug, and saying so would repeat the error
 * being fixed: the SDK sends `x-id` on GetObject and PutObject as well, and
 * both stores accept those. Only the bare-endpoint call is refused; why is
 * unknown.
 *
 * That misreading cost the app two features. `factory.ts` carried a
 * `withoutBucketEnumeration` wrapper for Akamai Object Storage and GCS-HMAC,
 * each with a confident explanation of why that store "cannot" list buckets —
 * one citing a measured 403 under both signing regions, the other a structural
 * project-id requirement. Both were written as vendor facts and both were
 * wrong. Stripping this one parameter makes Akamai return 3 buckets and GCS
 * return 69, measured against the real credentials
 * .
 *
 * It talks to a LOCAL SERVER rather than a mock. `factory.test.ts` replaces
 * `@aws-sdk/client-s3` wholesale, and a mocked client has no middleware stack —
 * so the defect, and its fix, are invisible to every test in that file. Here
 * the real client builds, signs and sends, and the assertion is on the bytes
 * that arrived.
 */

const SECRET = "s";

/**
 * Recompute SigV4 the way the SERVICE does, over the request as it ARRIVED.
 *
 * This is what makes the local server a faithful stand-in rather than a
 * bit-bucket. Without it the server accepts anything, and a middleware that
 * strips `x-id` AFTER signing looks identical on the wire to one that strips it
 * before — the request has no x-id either way. But the signature would then
 * cover a parameter that never arrived, which is the same 403 by the opposite
 * route. That mutation SURVIVED an earlier version of this file; verifying here
 * is what kills it.
 */
function signatureFor(
	method: string,
	url: string,
	headers: Record<string, string | string[] | undefined>,
): string {
	const auth = String(headers.authorization ?? "");
	const scope = /Credential=[^/]+\/([^,]+)/.exec(auth)?.[1] ?? "";
	const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? "";
	// The regex above already consumed the access key, so the scope starts at
	// the DATE — destructuring with a leading hole silently signs with
	// (date=region, region=service) and rejects every valid request.
	const [date = "", region = "", service = ""] = scope.split("/");
	const [path, query = ""] = url.split("?");
	const canonicalQuery = query.split("&").filter(Boolean).sort().join("&");
	const canonicalHeaders = signedHeaders
		.split(";")
		.map((h) => `${h}:${String(headers[h] ?? "").trim()}\n`)
		.join("");
	const canonicalRequest = [
		method,
		path,
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		String(headers["x-amz-content-sha256"] ?? ""),
	].join("\n");
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		String(headers["x-amz-date"] ?? ""),
		`${date}/${region}/${service}/aws4_request`,
		createHash("sha256").update(canonicalRequest).digest("hex"),
	].join("\n");
	const hmac = (key: Buffer | string, data: string) =>
		createHmac("sha256", key).update(data).digest();
	const signingKey = hmac(
		hmac(hmac(hmac(`AWS4${SECRET}`, date), region), service),
		"aws4_request",
	);
	return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
}

const requests: { url: string; method: string; signatureOk: boolean }[] = [];
let server: Server;
let origin: string;

beforeAll(async () => {
	server = createServer((req, res) => {
		const auth = String(req.headers.authorization ?? "");
		const provided = /Signature=([0-9a-f]+)/.exec(auth)?.[1] ?? "";
		const expected = signatureFor(
			req.method ?? "",
			req.url ?? "",
			req.headers as Record<string, string>,
		);
		const signatureOk = provided === expected && provided.length > 0;
		requests.push({
			url: req.url ?? "",
			method: req.method ?? "",
			signatureOk,
		});
		if (!signatureOk) {
			// Exactly what Linode and GCS answered.
			res.writeHead(403, { "content-type": "application/xml" });
			res.end(
				"<Error><Code>SignatureDoesNotMatch</Code><Message>The request " +
					"signature we calculated does not match the signature you " +
					"provided.</Message></Error>",
			);
			return;
		}
		res.writeHead(200, { "content-type": "application/xml" });
		res.end(
			'<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult>' +
				"<Buckets><Bucket><Name>b1</Name></Bucket></Buckets>" +
				"</ListAllMyBucketsResult>",
		);
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => {
		server.close(() => {
			resolve();
		});
	});
});

function queryOfLastRequest(): string {
	const last = requests.at(-1);
	if (!last) throw new Error("no request reached the server");
	return last.url.includes("?")
		? last.url.slice(last.url.indexOf("?") + 1)
		: "";
}

describe("the x-id query parameter on S3-compatible endpoints", () => {
	it("never reaches a custom endpoint", async () => {
		const browser = createS3Browser({
			credentials: { accessKeyId: "a", secretAccessKey: "s" },
			region: "jp-osa-1",
			endpoint: origin,
		});
		const buckets = await browser.listBuckets();
		expect(buckets).toEqual(["b1"]);
		expect(
			queryOfLastRequest(),
			"x-id is what Akamai and GCS refused to count in the signature",
		).not.toContain("x-id");
	});

	it("is added by the SDK when nothing strips it — so the test above measures the fix", async () => {
		// The counterfactual, and the reason it is worth its lines: if a future
		// SDK stops adding `x-id`, the assertion above would pass for a reason
		// that has nothing to do with our middleware, and the middleware could
		// be deleted without a single test turning red. This arm fails instead,
		// which is the signal to go re-verify rather than to delete.
		const bare = new S3Client({
			region: "jp-osa-1",
			credentials: { accessKeyId: "a", secretAccessKey: "s" },
			endpoint: origin,
			forcePathStyle: true,
		});
		await bare.send(new ListBucketsCommand({}));
		expect(
			queryOfLastRequest(),
			"the SDK no longer adds x-id — re-verify whether the middleware is still needed",
		).toContain("x-id");
	});

	it("strips it from object operations too, which is a CHOICE not a measurement", async () => {
		// The SDK attaches `x-id` to GetObject and PutObject as well, and both
		// stores ACCEPT those — GetObject returned 276 MB from Akamai with the
		// parameter present. So the blanket strip goes beyond the measured
		// defect on purpose: the parameter is meaningless, and a per-operation
		// rule would encode a guess about a mechanism nobody has established.
		// Pinned so the scope is a decision on the record rather than a
		// side-effect nobody noticed.
		const browser = createS3Browser({
			credentials: { accessKeyId: "a", secretAccessKey: "s" },
			region: "jp-osa-1",
			endpoint: origin,
		});
		// `getObject` is optional on the interface (Azure and GCS-SA implement a
		// subset), so assert it exists rather than reaching past the type — a
		// non-null assertion here would hide the S3 driver quietly losing it.
		expect(browser.getObject, "the S3 driver must expose getObject").toBeTypeOf(
			"function",
		);
		await browser.getObject?.({ bucket: "b", key: "k" }).catch(() => undefined);
		expect(queryOfLastRequest()).not.toContain("x-id");
		expect(requests.at(-1)?.url).toContain("/b/k");
	});

	it("pins WHICH operations the SDK attaches x-id to", async () => {
		/**
		 * The instrument that caught all three wrong explanations in this
		 * saga — Akamai's, GCS's, and mine — was the same one every time:
		 * checking what the client actually SENDS instead of what the story
		 * says it sends. It was not in the suite. This is it.
		 *
		 * Three of these operations are ones we issue. `PutObject` is here
		 * because the SDK attaches the parameter to it and the strip therefore
		 * applies — a fact worth a red test on the day someone adds a write
		 * path, since nothing about PutObject against a customer store has
		 * been measured.
		 */
		const bare = new S3Client({
			region: "jp-osa-1",
			credentials: { accessKeyId: "a", secretAccessKey: "s" },
			endpoint: origin,
			forcePathStyle: true,
		});
		const attaches: Record<string, boolean> = {};
		for (const [name, command] of [
			["ListBuckets", new ListBucketsCommand({})],
			["ListObjectsV2", new ListObjectsV2Command({ Bucket: "b", MaxKeys: 1 })],
			["GetObject", new GetObjectCommand({ Bucket: "b", Key: "k" })],
			["PutObject", new PutObjectCommand({ Bucket: "b", Key: "k", Body: "x" })],
		] as const) {
			// Assert a NEW request arrived. `queryOfLastRequest` reads
			// `requests.at(-1)`, so an arm whose command never sends silently
			// inherits the previous arm's query and reports its answer. The
			// first three arms are protected by accident — a stale read gives
			// them the wrong expected value — but `PutObject` inherits
			// `GetObject`'s `x-id=GetObject`, reads `true`, and passes without
			// ever being sent. Measured: that mutation SURVIVED until this
			// line, and it is the one arm the app never issues, so nothing
			// else would notice it had stopped working.
			const before = requests.length;
			await bare.send(command as never).catch(() => undefined);
			expect(requests.length, `${name} never reached the server`).toBe(
				before + 1,
			);
			attaches[name] = queryOfLastRequest().includes("x-id");
		}
		expect(attaches).toEqual({
			ListBuckets: true,
			// The one we issue that does NOT carry it — which is why
			// bucket-scoped listing worked throughout and the defect looked
			// like a service-level capability gap.
			ListObjectsV2: false,
			// Carries it AND is accepted by both stores. This pair is what
			// refutes "these stores drop x-id when recomputing the signature".
			GetObject: true,
			PutObject: true,
		});
	});

	it("leaves no retry attempt carrying x-id", async () => {
		// Measured, because my first guess was wrong and the test title said so
		// for a while: for one retried command the `build` step runs ONCE and
		// `finalizeRequest` runs per attempt (attempts=3, buildRuns=1,
		// finalizeRuns=3). The retry reuses the built request, so a strip
		// applied at `build` persists across every attempt and each attempt is
		// re-signed over the already-clean query.
		//
		// Which means a "only strip the first time" mutation SURVIVES this test
		// — not a hole, a no-op: the middleware already only runs once. Said
		// out loud so the next reader does not mistake survival for weakness
		// and "strengthen" the test into something that pins the SDK's
		// internals instead of our property.
		//
		// What it does pin is the property that matters: no request that leaves
		// this client carries the parameter, however many attempts there are.
		const seen: string[] = [];
		let n = 0;
		const flaky = createServer((req, res) => {
			seen.push(req.url ?? "");
			n += 1;
			if (n < 3) {
				res.writeHead(500, { "content-type": "application/xml" });
				res.end("<Error><Code>InternalError</Code></Error>");
				return;
			}
			res.writeHead(200, { "content-type": "application/xml" });
			res.end(
				'<?xml version="1.0"?><ListAllMyBucketsResult><Buckets>' +
					"<Bucket><Name>b1</Name></Bucket></Buckets></ListAllMyBucketsResult>",
			);
		});
		await new Promise<void>((r) => {
			flaky.listen(0, "127.0.0.1", r);
		});
		try {
			const browser = createS3Browser({
				credentials: { accessKeyId: "a", secretAccessKey: "s" },
				region: "jp-osa-1",
				endpoint: `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`,
			});
			expect(await browser.listBuckets()).toEqual(["b1"]);
			// Without this the loop below is vacuous over a single attempt.
			expect(seen.length, "the SDK did not actually retry").toBeGreaterThan(1);
			for (const url of seen) expect(url).not.toContain("x-id");
		} finally {
			await new Promise<void>((r) => {
				flaky.close(() => {
					r();
				});
			});
		}
	});

	it("strips it before SIGNING, not after — a late strip is the same 403", async () => {
		// Signing covers the canonical query string, so removing `x-id` after
		// the signature is computed leaves a signature over a parameter that
		// never arrives: the identical mismatch, reached from the other side.
		// The server above recomputes the signature over what it RECEIVED, so
		// this arm fails if the strip moves to `finalizeRequest`.
		const browser = createS3Browser({
			credentials: { accessKeyId: "a", secretAccessKey: "s" },
			region: "jp-osa-1",
			endpoint: origin,
		});
		await browser.listBuckets();
		const last = requests.at(-1);
		expect(
			last?.signatureOk,
			"the request that arrived does not verify against its own signature",
		).toBe(true);
	});
});
