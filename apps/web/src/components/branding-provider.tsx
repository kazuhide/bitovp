"use client";
import {
	type BrandingSettings,
	brandingSettingsSchema,
	DEFAULT_BRANDING_SETTINGS,
} from "@bitovp/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";

const BrandingContext = createContext<{
	organization?: string;
	value: BrandingSettings;
	pending: boolean;
	error: boolean;
	retry: () => void;
	saved: (value: BrandingSettings) => Promise<void>;
} | null>(null);

/** Mounted only inside the signed-in shell. Every organization has a separate
 * cache key; pending/error/session changes never display another tenant's brand. */
export function BrandingProvider({ children }: { children: ReactNode }) {
	const session = useSession();
	const trusted =
		session.status === "success" &&
		session.data?.authenticated &&
		session.data.configured
			? session.data
			: undefined;
	const organization =
		trusted?.organizationId ??
		(trusted && trusted.mode !== "users"
			? "00000000-0000-4000-8000-000000000001"
			: undefined);
	const client = useQueryClient();
	const key = ["workspace-branding", organization] as const;
	const query = useQuery({
		queryKey: key,
		enabled: Boolean(organization),
		queryFn: async ({ signal }) =>
			brandingSettingsSchema.parse(
				await apiFetch("/api/settings/branding", { cache: "no-store", signal }),
			),
	});
	return (
		<BrandingContext.Provider
			value={{
				organization,
				value:
					organization && query.isSuccess
						? query.data
						: DEFAULT_BRANDING_SETTINGS,
				pending:
					session.status === "pending" ||
					(Boolean(organization) && query.isPending),
				error:
					session.status === "error" ||
					(session.status === "success" && !organization) ||
					query.isError,
				retry: () => {
					if (organization) void query.refetch();
					else void session.refetch();
				},
				saved: async (value) => {
					await client.cancelQueries({ queryKey: key, exact: true });
					client.setQueryData(key, value);
				},
			}}
		>
			{children}
		</BrandingContext.Provider>
	);
}
export function useBranding() {
	return useContext(BrandingContext);
}
