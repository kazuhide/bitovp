/**
 * Pilot assertions for the named Live actions in a settled fixture.
 * A null hit records a button deliberately outside the vertical viewport.
 */
export function evaluateLiveActionLayout({
	buttons,
	expected,
	viewportWidth,
	scrollWidth,
	maxGap,
}) {
	const violations = [];
	const controls = buttons.map((button) => button.action);
	const centre = (button) => (button.top + button.bottom) / 2;
	const rowCentres = [];
	for (const button of buttons) {
		const y = centre(button);
		if (!rowCentres.some((other) => Math.abs(other - y) <= 1)) {
			rowCentres.push(y);
		}
	}
	const rows = rowCentres.length;
	const leftToRight = [...buttons].sort((a, b) => a.left - b.left);
	const gaps = leftToRight
		.slice(1)
		.map((button, index) => button.left - leftToRight[index].right);
	if (
		JSON.stringify([...controls].sort()) !==
		JSON.stringify([...expected].sort())
	) {
		violations.push("unexpected-actions");
	}
	if (scrollWidth > viewportWidth + 1) {
		violations.push("document-overflow");
	}
	if (
		buttons.some(
			(button) => button.left < -1 || button.right > viewportWidth + 1,
		)
	) {
		violations.push("clipped-action");
	}
	if (buttons.some((button) => button.hit === false)) {
		violations.push("obscured-action");
	}
	const overlap = buttons.some((button, index) =>
		buttons
			.slice(index + 1)
			.some(
				(other) =>
					Math.min(button.right, other.right) -
						Math.max(button.left, other.left) >
						1 &&
					Math.min(button.bottom, other.bottom) -
						Math.max(button.top, other.top) >
						1,
			),
	);
	if (overlap) {
		violations.push("overlapping-actions");
	}
	if (maxGap !== null && (rows > 1 || gaps.some((gap) => gap > maxGap))) {
		violations.push("separated-actions");
	}
	return { controls, rows, gaps: rows === 1 ? gaps : [], violations };
}

function installProbe(config, evaluateLayout) {
	const names = new Map([
		["新しい配信を開始", "start-new"],
		["設定をコピーして編集", "copy-settings"],
		["チャンネルを停止", "stop"],
		["チャンネルを再起動", "restart"],
	]);
	window.__bitovpLiveLayoutProbe = {
		read() {
			const heading = document.querySelector("main h1");
			if (heading?.textContent?.trim() !== config.title) {
				return { ready: false, controls: [], rows: 0, violations: [] };
			}
			const root = document.documentElement;
			const viewportWidth = root.clientWidth;
			const scrollWidth = root.scrollWidth;
			const historyOpen =
				document.querySelector("#sec-manifests")?.open === true;
			const expected = config.expectedByHistory[String(historyOpen)];
			const buttons = Array.from(
				document.querySelectorAll("main button"),
			).flatMap((button) => {
				const label = (
					button.getAttribute("aria-label") ??
					button.textContent ??
					""
				).trim();
				const action = names.get(label);
				if (!action || getComputedStyle(button).visibility !== "visible")
					return [];
				const { left, top, right, bottom, width, height } =
					button.getBoundingClientRect();
				if (!width || !height) return [];
				const x = (left + right) / 2;
				const y = (top + bottom) / 2;
				const outsideViewport =
					y < 0 || y >= root.clientHeight || x < 0 || x >= viewportWidth;
				const hit = outsideViewport
					? null
					: !button.disabled &&
						button.contains(document.elementFromPoint(x, y));
				return [{ action, label, left, top, right, bottom, hit }];
			});
			return {
				ready: true,
				historyOpen,
				expected,
				buttons,
				viewportWidth,
				scrollWidth,
				...evaluateLayout({
					buttons,
					expected,
					viewportWidth,
					scrollWidth,
					maxGap: config.maxGap,
				}),
			};
		},
	};
}

export async function attachLiveLayoutProbe(page, config) {
	const script = `(${installProbe})(${JSON.stringify(config)}, ${evaluateLiveActionLayout})`;
	await page.addInitScript({ content: script });
	await page.evaluate(script);
}
