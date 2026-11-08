"use client";
import { createContext, useContext } from "react";
export const CompositionPendingInputs = createContext<
	(id: string, pending: boolean) => void
>(() => {});
export const useCompositionPendingInput = () =>
	useContext(CompositionPendingInputs);
