"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import {
	installTenantFetch,
	ORGANIZATION_CHANGE_KEY,
} from "@/lib/tenant-fetch";

export function Providers({
	children,
	organizationId,
}: {
	children: ReactNode;
	organizationId?: string;
}) {
	installTenantFetch(organizationId);
	useEffect(() => {
		const changed = (event: StorageEvent) => {
			if (event.key === ORGANIZATION_CHANGE_KEY) window.location.reload();
		};
		window.addEventListener("storage", changed);
		return () => window.removeEventListener("storage", changed);
	}, []);
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: false },
				},
			}),
	);
	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}
