import type { ReactNode } from "react";

/**
 * Explicit owner-mode boundary for component tests whose subject is not RBAC.
 *
 * The real role matrix (including unresolved and VIEWER fail-closed behaviour)
 * is exercised against production components in
 * `lib/auth/mutation-controls.production.test.tsx`. Behavioural tests that
 * mock their subject's API must not accidentally hand that payload to the
 * independent session query and thereby test an unresolved user instead.
 */
export function RoleAccess({ children }: { children: ReactNode }): ReactNode {
	return children;
}

export function useRoleAccess(): boolean {
	return true;
}

export function useMutationAccess(): boolean {
	return true;
}
