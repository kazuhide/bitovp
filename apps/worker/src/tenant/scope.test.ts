import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it } from "vitest";
import { createTenantDispatcher } from "./dispatch";
import {
	contextualTenantPrisma,
	currentOrganizationId,
	forEachTenantService,
	requireOrganizationId,
	runInOrganization,
	tenantService,
} from "./scope";

const A = "ef984a2c-1d65-4f48-8eae-0f4be5c80432",
	B = "aa14e5f0-e526-4af1-886c-a9a1f2f9e1ed";
describe("worker tenant execution scope", () => {
	it("captures organization at lazy command creation and isolates concurrent async continuations", async () => {
		const marker = Symbol();
		const db = contextualTenantPrisma(
			(id) =>
				({
					encodingJob: {
						findMany: () => ({
							// biome-ignore lint/suspicious/noThenProperty: Models Prisma commands intentionally resolving at await.
							then: (resolve: (value: string) => unknown) =>
								Promise.resolve(resolve(id)),
						}),
					},
				}) as unknown as AppPrismaClient,
			marker,
		);
		const pending = runInOrganization(A, () => db.encodingJob.findMany());
		expect(await runInOrganization(B, () => Promise.resolve(pending))).toBe(A);
		const ids = await Promise.all(
			[A, B].map((id) =>
				runInOrganization(id, async () => {
					await new Promise((resolve) => setTimeout(resolve, id === A ? 4 : 1));
					return currentOrganizationId();
				}),
			),
		);
		expect(ids).toEqual([A, B]);
		expect(currentOrganizationId()).toBeUndefined();
		expect(() => db.encodingJob.findMany()).toThrow("Organization context");
	});
	it("keeps service state separate and can drain existing services without organization discovery", () => {
		let creates = 0;
		const service = tenantService(() => {
			creates++;
			let count = 0;
			return { next: () => ++count, stop: () => currentOrganizationId() };
		});
		expect(runInOrganization(A, () => service.next())).toBe(1);
		expect(runInOrganization(B, () => service.next())).toBe(1);
		expect(runInOrganization(A, () => service.next())).toBe(2);
		expect(forEachTenantService(service, (s) => s.stop())).toEqual([A, B]);
		expect(creates).toBe(2);
		expect(() => service.next()).toThrow("Organization context");
	});
	it("dispatches metadata only, continues other tenants after failure and never fans out from existing scope", async () => {
		let queries = 0;
		const dispatch = createTenantDispatcher({
			organization: {
				findMany: async (args) => {
					queries++;
					expect(args.select).toEqual({ id: true });
					return [{ id: A }, { id: B }];
				},
			},
		});
		const seen: string[] = [];
		await expect(
			dispatch(() => {
				seen.push(requireOrganizationId());
				if (currentOrganizationId() === A) throw Error("retry");
			}),
		).rejects.toThrow("sweep failed");
		expect(seen).toEqual([A, B]);
		await runInOrganization(B, () =>
			dispatch(() => seen.push(requireOrganizationId())),
		);
		expect(queries).toBe(1);
		expect(seen).toEqual([A, B, B]);
		expect(currentOrganizationId()).toBeUndefined();
	});
	it("rejects malformed org identifiers", () =>
		expect(() => runInOrganization("invalid", () => {})).toThrow());
});
