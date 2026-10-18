import type { AppPrismaClient } from "@bitovp/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWorkerSdk, withWorkerActor } from "./make-sdk";

/**
 * The boundary test review-163's Mutation A demanded: it drives the SAME
 * function object index.ts wires as `makeSdk`, called exactly the way
 * processor.ts calls it, to the actual wire. Reverting the factory to the
 * shipped destructure (drop `stamp`) fails HERE — the mutation that survived
 * every other test with a clean typecheck, because contravariance accepts a
 * narrower-args function and nothing else crossed the seam.
 */

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("makeWorkerSdk — the production seam, to the wire", () => {
	it("forwards the stamp: a create during a step carries bitovp customData", async () => {
		const bodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: { body?: string }) => {
				bodies.push(init?.body ?? "");
				return new Response(JSON.stringify({ data: { result: { id: "x" } } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);
		const prisma = {
			auditLog: { create: vi.fn(async () => ({})) },
		} as unknown as AppPrismaClient;
		const makeSdk = makeWorkerSdk(prisma);
		// The exact call shape processor.ts uses — stamp included.
		const ops = makeSdk({
			apiKey: "k",
			tenantOrgId: null,
			bitmovinAccountId: "acct",
			stamp: { jobId: "job-1", currentStep: () => "input:main" },
		});
		await ops.createS3Input({
			name: "S3 in",
			bucketName: "b",
			accessKey: "ak",
			secretKey: "sk",
		});
		//  / security-review-212: the orchestrator is the system's
		// highest-volume audit writer and has no Request, so it must name
		// itself rather than persist a NULL that reads as "attribution was
		// never wired" — which is precisely what that row's defect was.
		const auditCreate = prisma.auditLog.create as unknown as ReturnType<
			typeof vi.fn
		>;
		expect(auditCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ actor: "worker:orchestrator" }),
			}),
		);

		const stamped = bodies.find((body) => body.includes('"bitovp"'));
		expect(stamped, bodies.join("\n")).toBeDefined();
		expect(
			(
				JSON.parse(stamped as string) as {
					customData: { bitovp: unknown };
				}
			).customData["bitovp"],
		).toEqual({ job: "job-1", step: "input:main" });
	});

	it("forwards verification key + SHA to the provider and awaits the provider-id barrier", async () => {
		const bodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: { body?: string }) => {
				bodies.push(init?.body ?? "");
				return new Response(
					JSON.stringify({ data: { result: { id: "enc-verified" } } }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}),
		);
		const prisma = {
			auditLog: { create: vi.fn(async () => ({})) },
		} as unknown as AppPrismaClient;
		const persisted: string[] = [];
		const verification = {
			key: "verify:run-1:s1:VOD_JOB",
			requestSha256: "c".repeat(64),
		};
		const ops = makeWorkerSdk(prisma)({
			apiKey: "k",
			tenantOrgId: null,
			bitmovinAccountId: "acct",
			stamp: {
				jobId: "job-1",
				currentStep: () => "encoding",
				verification,
				onEncodingCreated: async (id, source) => {
					persisted.push(`${source}:${id}`);
					return "PERSISTED";
				},
			},
		});
		expect(
			await ops.createEncoding({
				name: "verified encoding",
				cloudRegion: "AWS_AP_NORTHEAST_1",
				encoderVersion: "STABLE",
				labels: [`verify-key:${verification.key}`],
			}),
		).toBe("enc-verified");
		expect(persisted).toEqual(["created:enc-verified"]);
		const sent = bodies.find((body) => body.includes("verified encoding"));
		expect(
			(
				JSON.parse(sent as string) as {
					customData: {
						bitovp: { verification: unknown };
					};
				}
			).customData["bitovp"].verification,
		).toEqual(verification);
	});

	it("forwards adoptWindow: an open window adopts on the wire — no POST", async () => {
		// Review-172's forward note on the live wiring, generalized: the wire
		// test above passes even if the factory drops adoptWindow (customData
		// stamping needs only jobId + currentStep), so a re-introduced
		// destructure would kill adoption with a green suite — the #163 shape,
		// third bite. This drives the WHOLE stack through the same function
		// object index.ts wires: window open + a stamped candidate on the
		// "server" ⇒ the create must ADOPT (zero POSTs), which only happens if
		// adoptWindow survived the seam.
		const calls: Array<{ method: string; url: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown, init?: { method?: string }) => {
				const u = String(url);
				const method = init?.method?.toUpperCase() ?? "GET";
				calls.push({ method, url: u });
				const payload = u.includes("/customData")
					? {
							customData: {
								bitovp: { job: "job-1", step: "encoding" },
							},
						}
					: u.includes("/encoding/encodings")
						? { items: [{ id: "enc-lost" }] }
						: { id: "x" };
				return new Response(JSON.stringify({ data: { result: payload } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);
		const prisma = {
			auditLog: { create: vi.fn(async () => ({})) },
		} as unknown as AppPrismaClient;
		const ops = makeWorkerSdk(prisma)({
			apiKey: "k",
			tenantOrgId: null,
			bitmovinAccountId: "acct",
			stamp: {
				jobId: "job-1",
				currentStep: () => "encoding",
				adoptWindow: () => true,
			},
		});
		const created = await ops.createEncoding({
			name: "job encoding",
			cloudRegion: "AWS_AP_NORTHEAST_1",
			encoderVersion: "STABLE",
		});
		expect(created).toBe("enc-lost");
		expect(calls.filter((c) => c.method === "POST")).toEqual([]);
	});
});

/**
 *  — the sentinel must survive an entry that NAMES `actor` with an
 * undefined value. review-final reverted the composition to
 * `{actor: WORKER_ACTOR, ...entry}` and measured tsc 0 with 965/965 green, so
 * the ordering was right but nothing held it there.
 */
describe("withWorkerActor (ledger #81)", () => {
	it("keeps the sentinel when the entry names actor as undefined", () => {
		// The hostile shape: the KEY EXISTS, so a trailing spread would wipe
		// the sentinel — the #46 trap, in the audit layer.
		const out = withWorkerActor({
			method: "POST",
			path: "/encoding/thing",
			actor: undefined,
		});
		expect(out.actor).toBe("worker:orchestrator");
	});

	it("keeps the sentinel when the entry omits actor entirely", () => {
		const out = withWorkerActor({ method: "POST", path: "/encoding/thing" });
		expect(out.actor).toBe("worker:orchestrator");
	});

	it("lets a caller with a finer identity win", () => {
		const out = withWorkerActor({
			method: "POST",
			path: "/encoding/thing",
			actor: "token:abc",
		});
		expect(out.actor).toBe("token:abc");
	});
});
