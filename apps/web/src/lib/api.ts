export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export async function apiFetch<T>(
	input: string,
	init?: RequestInit,
): Promise<T> {
	const res = await fetch(input, {
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	});
	if (res.status === 204) {
		return undefined as T;
	}
	const data: unknown = await res.json().catch(() => null);
	if (!res.ok) {
		const body = data as { error?: string; details?: unknown } | null;
		throw new ApiError(
			res.status,
			body?.error ?? `Request failed (${res.status})`,
			body?.details,
		);
	}
	return data as T;
}
