const definitiveRefusals = new Set([400, 401, 403, 404, 422, 429]);

export class ProviderCreateRefusal extends Error {
	constructor(readonly status: number) {
		super(`Provider refused resource creation (HTTP ${status})`);
	}
}

/** Wrap only the provider call so a later local failure cannot authorize replay. */
export async function withProviderCreateRefusal<T>(
	send: () => Promise<T>,
): Promise<T> {
	try {
		return await send();
	} catch (error) {
		const status =
			error instanceof Error && "httpStatusCode" in error
				? error.httpStatusCode
				: undefined;
		if (typeof status === "number" && definitiveRefusals.has(status))
			throw new ProviderCreateRefusal(status);
		throw error;
	}
}
