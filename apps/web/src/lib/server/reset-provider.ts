import { classifyProviderStatusWord } from "@bitovp/core";
import type { ProviderEncoderState } from "./reset";

export type ResetAccountSnapshot = {
	id: string;
	updatedAt: Date;
	tenantOrgId: string | null;
	encryptedApiKey: string;
};
type ResetEncodingApi = {
	encoding: {
		encodings: {
			status(id: string): Promise<{ status?: string }>;
			get(id: string): Promise<{ id?: string }>;
			list(query: { limit: number }): Promise<{ items?: { id?: string }[] }>;
		};
	};
};

/** Require provider code 1001 from each exact encoding endpoint, not bare 404. */
function encodingAbsent(error: unknown): boolean {
	const e = error as { httpStatusCode?: number; errorCode?: number } | null;
	return e?.httpStatusCode === 404 && e.errorCode === 1001;
}

export function sameResetAccount(
	a: ResetAccountSnapshot,
	b: ResetAccountSnapshot | null,
): boolean {
	return (
		b !== null &&
		a.id === b.id &&
		a.updatedAt.getTime() === b.updatedAt.getTime() &&
		a.tenantOrgId === b.tenantOrgId &&
		a.encryptedApiKey === b.encryptedApiKey
	);
}

export async function readResetEncoding(
	api: ResetEncodingApi,
	encodingId: string,
	account: ResetAccountSnapshot,
): Promise<ProviderEncoderState> {
	try {
		const { status } = await api.encoding.encodings.status(encodingId);
		const state = classifyProviderStatusWord(status);
		if (state === "TERMINAL" || status === "CREATED")
			return { kind: "stopped", providerStatus: String(status) };
		if (state !== "UNKNOWN")
			return { kind: "running", providerStatus: String(status) };
		return {
			kind: "unverified",
			message: status
				? `Bitmovin reported a status this app does not classify (${status})`
				: "Bitmovin did not report a status for this encoding",
		};
	} catch (error) {
		if (encodingAbsent(error)) {
			try {
				await api.encoding.encodings.get(encodingId);
			} catch (entityError) {
				if (encodingAbsent(entityError)) {
					try {
						const page = await api.encoding.encodings.list({ limit: 1 });
						// A successful empty page is authenticated too. Never use list
						// absence itself as proof; this only checks access/contradictions.
						if (
							Array.isArray(page.items) &&
							page.items.every(
								(item) => typeof item.id === "string" && item.id !== encodingId,
							)
						)
							return { kind: "missing", account };
					} catch {
						/* Ambiguous access: leave blocking, no raw SDK error. */
					}
				}
			}
		}
		return {
			kind: "unverified",
			message: "Bitmovin encoding status could not be verified",
		};
	}
}
