import { always } from "@antithesishq/bombadil";
import {
	actions,
	extract,
	getFingerprint,
	registerCustomAction,
} from "@antithesishq/bombadil/browser";

type Observation = {
	ready: boolean;
	violations: string[];
	controls: string[];
	rows: number;
};

type Exploration = {
	summary: HTMLElement;
	disclosure: HTMLDetailsElement;
	openHistory: number;
	closeHistory: number;
	scrollHeader: number;
	historyObscured: boolean;
};

type LayoutWindow = Window & {
	__bitovpLiveLayoutProbe?: { read(): Observation };
	__bitovpLiveLayoutExploration?: Exploration;
};

const state = extract(({ document, window }) => {
	const view = window as typeof window & LayoutWindow;
	const layout = view.__bitovpLiveLayoutProbe?.read();
	const exploration = view.__bitovpLiveLayoutExploration;
	const summary = exploration?.summary;
	const bounds = summary?.getBoundingClientRect();
	const point = bounds
		? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
		: null;
	const hit =
		point &&
		point.x >= 0 &&
		point.x < window.innerWidth &&
		point.y >= 0 &&
		point.y < window.innerHeight &&
		document.elementFromPoint(point.x, point.y);
	return {
		ready:
			layout?.ready === true &&
			exploration?.disclosure.isConnected === true &&
			summary?.parentElement === exploration.disclosure,
		controls: layout?.controls ?? [],
		rows: layout?.rows ?? 0,
		violations: [
			...(layout?.violations ?? []),
			...(exploration?.historyObscured ? ["history-summary-obscured"] : []),
		],
		historyOpen: exploration?.disclosure.open,
		openHistory: exploration?.openHistory ?? 0,
		closeHistory: exploration?.closeHistory ?? 0,
		scrollHeader: exploration?.scrollHeader ?? 0,
		scrollY: window.scrollY,
		toggleTarget:
			summary && point && hit && summary.contains(hit)
				? { fingerprint: getFingerprint(summary), point }
				: null,
	};
});

export const liveLayoutRemainsValid = always(
	() => state.current?.ready === true && state.current.violations.length === 0,
);

const scroll = registerCustomAction(
	"scrollLiveLayout",
	async (document, window, destination: string) => {
		const exploration = (window as typeof window & LayoutWindow)
			.__bitovpLiveLayoutExploration;
		if (!exploration) throw new Error("Missing prepared history target");
		const previous = window.scrollY;
		if (destination === "header") {
			window.scrollTo({ top: 0, behavior: "instant" });
		} else if (destination === "history") {
			exploration.summary.scrollIntoView({
				block: "center",
				behavior: "instant",
			});
		} else {
			throw new Error("Unknown Live scroll destination");
		}
		await new Promise<void>((done) =>
			window.requestAnimationFrame(() =>
				window.requestAnimationFrame(() => done()),
			),
		);
		if (destination === "header") {
			if (previous > 0 && window.scrollY === 0) exploration.scrollHeader++;
		} else {
			const bounds = exploration.summary.getBoundingClientRect();
			exploration.historyObscured = !exploration.summary.contains(
				document.elementFromPoint(
					bounds.left + bounds.width / 2,
					bounds.top + bounds.height / 2,
				),
			);
		}
	},
);

export const liveHistoryActions = actions(() => {
	const current = state.current;
	if (!current?.ready || current.violations.length > 0) return [];
	const toggle = current.toggleTarget ? { Click: current.toggleTarget } : null;
	// Qualify each operation once before random exploration. Bombadil drives
	// the disclosure with a native click at the observed summary hit point.
	if (!current.openHistory || !current.closeHistory)
		return [toggle ?? scroll("history")];
	if (!current.scrollHeader && current.scrollY > 0) return [scroll("header")];
	return [
		...(toggle ? [toggle] : []),
		scroll("history"),
		...(current.scrollY > 0 ? [scroll("header")] : []),
	];
});
