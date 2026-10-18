import { currentOrganizationId, runInOrganization } from "./scope";

export type OrganizationReader = {
	organization: {
		findMany(args: {
			select: { id: true };
			orderBy: { id: "asc" };
			take: number;
			where?: { id: { gt: string } };
		}): Promise<{ id: string }[]>;
	};
};

/** Only this dispatcher receives identity metadata; org services never get a global DB. */
export function createTenantDispatcher(identity: OrganizationReader) {
	return async function forEachOrganization<T>(
		run: () => Promise<T> | T,
	): Promise<void> {
		if (currentOrganizationId()) {
			await run();
			return;
		}
		let after: string | undefined;
		const errors: unknown[] = [];
		for (;;) {
			const rows = await identity.organization.findMany({
				select: { id: true },
				orderBy: { id: "asc" },
				take: 100,
				...(after ? { where: { id: { gt: after } } } : {}),
			});
			for (const row of rows) {
				try {
					await runInOrganization(row.id, run);
				} catch (error) {
					errors.push(error);
				}
			}
			if (rows.length < 100) break;
			const next = rows.at(-1)?.id;
			if (!next || next === after)
				throw new Error("Organization pagination did not advance");
			after = next;
		}
		if (errors.length)
			throw new AggregateError(errors, "Organization sweep failed");
	};
}
