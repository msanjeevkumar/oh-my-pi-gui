import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron, type Locator, type Page } from "playwright";

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
const errors: string[] = [];

async function command(text: string) {
	const composer = page.locator("textarea").first();
	await composer.fill(text);
	await page.getByRole("button", { name: "Send (Enter)", exact: true }).click();
}
async function recorded(type: string) {
	const text = await fs.readFile(record, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line))
		.filter(command => command.type === type);
}

test.beforeAll(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-audit-"));
	const project = path.join(profile, "project");
	const userData = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(userData), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(path.join(userData, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const fixture = path.resolve("e2e/sidecar-fixture.ts");
	await fs.chmod(fixture, 0o755);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_BUNDLED_OMP: fixture,
		OMP_GUI_TEST_RECORD: record,
		OMP_GUI_TEST_STATS_BINARY: path.resolve("resources/omp"),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${userData}`],
		env,
	});
	page = await app.firstWindow();
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	await page.screenshot({ path: "test-results/desktop-start.png", scale: "css", animations: "disabled" });
});

test.afterAll(async () => {
	if (app) await app.close();
	if (record) await fs.copyFile(record, "test-results/desktop-rpc.jsonl").catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true });
});

async function selectResponse(source: Locator, selector: string, start?: number, end?: number) {
	const target = source.locator(selector);
	await target.scrollIntoViewIfNeeded();
	const selected = await target.evaluate(
		(node, offsets) => {
			const range = document.createRange();
			range.selectNodeContents(node);
			if (offsets.start !== undefined && offsets.end !== undefined && node.firstChild) {
				range.setStart(node.firstChild, offsets.start);
				range.setEnd(node.firstChild, offsets.end);
			}
			const selection = window.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
			node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 1, clientY: 1 }));
			return selection.toString();
		},
		{ start, end },
	);
	const toolbar = page.getByRole("toolbar", { name: "Add to chat" });
	await expect(toolbar).toBeVisible();
	await expect
		.poll(() =>
			toolbar.evaluate(node => {
				const box = node.getBoundingClientRect();
				const range = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
				return Math.min(Math.abs(box.bottom - range.top), Math.abs(box.top - range.bottom));
			}),
		)
		.toBeLessThan(12);
	await toolbar.hover();
	await expect(toolbar).toHaveCSS("opacity", "1");
	await expect(toolbar).toHaveCSS("pointer-events", "auto");
	expect(await toolbar.evaluate(node => getComputedStyle(node).backgroundColor)).toMatch(/^rgb\(/);
	await page.getByRole("button", { name: "Add to chat", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const ranges = Array.from(CSS.highlights.get("response-annotations") ?? []);
				const range = ranges.at(-1)!;
				const endpoint = document.createRange();
				endpoint.setStart(range.endContainer, range.endOffset);
				endpoint.collapse(true);
				const end = endpoint.getBoundingClientRect();
				const badge = document
					.querySelector('.omp-annotation-badge[aria-expanded="true"]')!
					.getBoundingClientRect();
				return Math.max(
					Math.abs(badge.left - end.right),
					Math.min(Math.abs(badge.bottom - end.top), Math.abs(badge.top - end.bottom)),
				);
			}),
		)
		.toBeLessThan(12);
	return selected;
}

test("response annotations preserve source ranges, comments and exact submitted content", async () => {
	await command("fixture annotations");
	const source = page.locator("[data-response-annotation-text]").filter({ hasText: "Annotation example:" }).last();
	await expect(source).toBeVisible();
	const highlighted = () =>
		page.evaluate(() => Array.from(CSS.highlights.get("response-annotations") ?? []).map(range => range.toString()));
	const editor = page.getByRole("dialog", { name: /^Annotation \d+$/ });
	const comment = editor.getByRole("textbox", { name: "Comment (optional)" });
	const quote = await selectResponse(source, "strong");
	await expect(comment).toBeFocused();
	await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
	await comment.fill("  ");
	await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
	await comment.fill("Discard this draft");
	await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
	await editor.getByRole("button", { name: "Cancel", exact: true }).click();
	const badge = page.getByRole("button", { name: "Annotation 1", exact: true });
	await expect(badge).toHaveText("1");
	await expect(badge).toBeFocused();
	await expect.poll(highlighted).toContain(quote);
	await badge.press("Enter");
	await expect(comment).toHaveValue("");
	await comment.fill("  Explain this wording.  ");
	await editor.getByRole("button", { name: "Save", exact: true }).click();
	await selectResponse(source, "p:nth-of-type(2)");
	await comment.fill("Remove this comment too.");
	await editor.getByRole("button", { name: "Save", exact: true }).click();
	const code = await selectResponse(source, "code");
	expect(code).toBe("const value = 1;\n  return value;");
	await comment.fill("Keep the code indentation.");
	await editor.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("region", { name: "Annotation preview" })).toHaveCount(0);
	await page.getByRole("button", { name: "3 annotations", exact: true }).hover();
	const preview = page.getByRole("region", { name: "Annotation preview" });
	await expect(preview).toBeVisible();
	await preview.hover();
	await expect(preview.getByRole("button", { name: /^Delete annotation/ })).toHaveCount(3);
	await preview.getByRole("button", { name: "Delete annotation 2", exact: true }).focus();
	await preview.getByRole("button", { name: "Delete annotation 2", exact: true }).press("Enter");
	await expect(preview).toBeFocused();
	await expect(preview.getByRole("button", { name: /^Delete annotation/ })).toHaveCount(2);
	await expect(page.getByRole("button", { name: "Annotation 3", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Annotation 2", exact: true })).toHaveText("2");
	await expect.poll(highlighted).toEqual([quote, code]);
	const chip = page.getByRole("button", { name: "2 annotations", exact: true });
	await expect(chip).toBeVisible();
	await expect(preview.locator("pre")).toHaveText([quote, code], { useInnerText: false });
	await expect(preview).toContainText("Annotation 1");
	await expect(preview).toContainText("Annotation 2");
	await expect(preview).toContainText("Explain this wording.");
	await expect(preview).toContainText("Keep the code indentation.");
	await page.screenshot({ path: "test-results/annotations-preview.png", scale: "css", animations: "disabled" });
	await chip.focus();
	await chip.press("Escape");
	await expect(preview).toHaveCount(0);
	await command("Apply these comments.");
	const sent = (await recorded("prompt")).at(-1).message;
	expect(sent).toContain(quote);
	expect(sent).toContain(code);
	expect(sent).toContain("Explain this wording.");
	expect(sent).toContain("Keep the code indentation.");
	expect(sent).not.toContain("Remove this passage.");
	expect(sent).not.toContain("Remove this comment too.");
	expect(sent).not.toContain("Discard this draft");
	await expect(chip).toHaveCount(0);
	await expect.poll(highlighted).toEqual([]);
	await expect(page.locator(".omp-annotation-badge")).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("response annotations restore the exact occurrence across tabs and renumber after removal", async () => {
	await command("fixture annotations");
	const source = page.locator("[data-response-annotation-text]").filter({ hasText: "Annotation example:" }).last();
	await selectResponse(source, "strong");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await selectResponse(source, "p:nth-of-type(3)", 18, 35);
	const editor = page.getByRole("dialog", { name: "Annotation 2", exact: true });
	await editor.getByRole("textbox").fill("Explain the second occurrence.");
	await editor.getByRole("button", { name: "Save", exact: true }).click();
	await page.getByRole("button", { name: "Annotation 1", exact: true }).click();
	await page.getByRole("button", { name: "Delete annotation 1", exact: true }).click();
	await expect(page.getByRole("button", { name: "Annotation 2", exact: true })).toHaveCount(0);
	const badge = page.getByRole("button", { name: "Annotation 1", exact: true });
	await expect(badge).toHaveText("1");
	const exactOccurrence = () =>
		page.evaluate(() =>
			Array.from(CSS.highlights.get("response-annotations") ?? []).map(range => ({
				text: range.toString(),
				start: range.startOffset,
				end: range.endOffset,
			})),
		);
	await expect.poll(exactOccurrence).toEqual([{ text: "Duplicate phrase.", start: 18, end: 35 }]);
	await page.keyboard.press("Meta+t");
	const tabs = page.locator('[role="tablist"] [role="tab"]');
	await expect(tabs).toHaveCount(2);
	await expect(page.locator(".omp-annotation-badge")).toHaveCount(0);
	await expect.poll(exactOccurrence).toEqual([]);
	await tabs.first().click();
	await expect(badge).toHaveText("1");
	await expect.poll(exactOccurrence).toEqual([{ text: "Duplicate phrase.", start: 18, end: 35 }]);
	await badge.click();
	const restoredEditor = page.getByRole("dialog", { name: "Annotation 1", exact: true });
	await expect(restoredEditor.getByRole("textbox")).toHaveValue("Explain the second occurrence.");
	await restoredEditor.getByRole("textbox").fill("Abandoned edit");
	await restoredEditor.getByRole("button", { name: "Cancel", exact: true }).click();
	await badge.click();
	await expect(restoredEditor.getByRole("textbox")).toHaveValue("Explain the second occurrence.");
	await page.keyboard.press("Escape");
	await expect(badge).toBeFocused();
	await selectResponse(source, "strong");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	const earlierBadge = page.getByRole("button", { name: "Annotation 2", exact: true });
	const earlierBox = await earlierBadge.boundingBox();
	const laterBox = await badge.boundingBox();
	if (!earlierBox || !laterBox) throw new Error("Missing numbered source badge");
	expect(earlierBox.y).toBeLessThan(laterBox.y);
	await page.getByRole("button", { name: "Clear annotations", exact: true }).click();
	await expect(badge).toHaveCount(0);
	await expect.poll(exactOccurrence).toEqual([]);
	await command("After clearing annotations.");
	expect((await recorded("prompt")).at(-1).message).toBe("After clearing annotations.");
	await tabs.nth(1).click();
	await tabs.nth(1).getByRole("button", { name: "Close tab", exact: true }).click();
	await expect(tabs).toHaveCount(1);
	expect(errors).toEqual([]);
});

test("initially closed modal receives focus and Escape closes it", async () => {
	await command("/jobs");
	const modal = page.getByRole("dialog");
	await expect(modal).toBeVisible();
	await expect.poll(() => modal.evaluate(node => node.contains(document.activeElement))).toBe(true);
	await page.keyboard.press("Escape");
	await expect(modal).toHaveCount(0);
});

test("opening sharing performs local preview only, upload needs a button click", async () => {
	await command("/share");
	const modal = page.getByRole("dialog");
	await expect(modal.getByRole("button", { name: "Upload and create link" })).toBeVisible();
	expect(await recorded("share_session")).toHaveLength(0);
	await modal.getByRole("button", { name: "Upload and create link" }).click();
	await expect(modal).toContainText("http://127.0.0.1/shared#local");
	expect(await recorded("share_session")).toHaveLength(1);
	await page.keyboard.press("Escape");
});

test("a running task keeps both send and stop reachable", async () => {
	await command("fixture running");
	await expect(page.getByRole("button", { name: "Abort", exact: true })).toBeVisible();
	const composer = page.locator("textarea").first();
	await composer.fill("queued instruction");
	await page.getByRole("button", { name: "Send (Enter)", exact: true }).click();
	await expect.poll(async () => (await recorded("steer")).length + (await recorded("follow_up")).length).toBe(1);
	await page.getByRole("button", { name: "Abort", exact: true }).click();
	await expect(composer).toHaveValue("");
});

test("long approval remains complete and Enter is neutral", async () => {
	await command("fixture approval");
	const modal = page.getByRole("dialog");
	await expect(modal.locator("pre")).toContainText("critical final argument");
	await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).not.toBe("Approve");
	await page.keyboard.press("Escape");
	await expect(modal).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("settings expose eight groups, translated search and independent display preferences", async () => {
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = page.getByRole("dialog");
	await expect(settings.locator(".settings-nav-group-label")).toHaveCount(8);
	await settings.getByRole("button", { name: "Appearance & use", exact: true }).click();
	await expect(settings).toContainText("Choose GUI theme");
	await page.screenshot({ path: "test-results/01-settings.png", scale: "css", animations: "disabled" });
	const search = settings.getByPlaceholder("Search settings and managed resources…");
	await search.fill("压缩");
	await expect(settings).toContainText("Auto compaction");
	await search.fill("paste.largeMenuThreshold");
	await expect(settings).toContainText("paste");
	await page.keyboard.press("Escape");
	await expect(settings).toHaveCount(0);
});

test("voice and side question require an explicit start", async () => {
	const voiceBefore = (await recorded("live_start")).length;
	await command("/live");
	let modal = page.getByRole("dialog");
	await expect(modal).toBeVisible();
	expect(await recorded("live_start")).toHaveLength(voiceBefore);
	await page.screenshot({ path: "test-results/02-voice.png", scale: "css", animations: "disabled" });
	await page.keyboard.press("Escape");
	const before = (await recorded("btw")).length;
	await command("/btw explain the current approach");
	modal = page.getByRole("dialog");
	await expect(modal).toBeVisible();
	expect(await recorded("btw")).toHaveLength(before);
	await page.keyboard.press("Escape");
});

test("Escape cancels a settings edit without saving its abandoned value", async () => {
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = page.getByRole("dialog");
	await settings.getByPlaceholder("Search settings and managed resources…").fill("compaction.reserveTokens");
	await settings.getByRole("button", { name: "Reserve tokens compaction.reserveTokens", exact: true }).click();
	const input = settings.locator('input[type="number"]').first();
	await expect(input).toHaveValue("8192");
	const before = (await recorded("set_setting")).length;
	await input.fill("12345");
	await input.press("Escape");
	await expect(settings).toHaveCount(0);
	expect((await recorded("set_setting")).length).toBe(before);
	const response = await page.evaluate(() => window.omp.rpc.getSettings(["compaction.reserveTokens"]));
	expect(response.data).toMatchObject({ values: { "compaction.reserveTokens": 8192 } });
});

test("math survives history reload and scrolls inside its column in both themes", async () => {
	await command("fixture math");
	const markdown = page.locator(".markdown-body").filter({ has: page.locator(".katex-display") });
	await expect(markdown.locator(".katex-display")).toHaveCount(4);
	await expect(markdown).toContainText("只有统计口径相同时");
	await page.reload();
	await expect(markdown.locator(".katex-display")).toHaveCount(4);
	await expect(markdown.locator(".katex-html").filter({ hasText: "显存有效带宽" })).toHaveCount(1);
	await expect(markdown.locator("h1, h2, .katex-error")).toHaveCount(0);
	const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	for (const theme of ["Graphite", "Porcelain"]) {
		await command("/theme");
		const picker = page.getByRole("dialog");
		await picker.getByPlaceholder("Search themes…").fill(theme);
		await picker.locator("button[aria-pressed]").filter({ hasText: theme }).click();
		await expect(picker).toHaveCount(0);
		await page.setViewportSize({ width: 900, height: 1050 });
		await markdown.scrollIntoViewIfNeeded();
		await page.evaluate(() => document.fonts.ready);
		expect(await page.evaluate(() => document.fonts.check("16px KaTeX_Main"))).toBe(true);
		const layout = await markdown.evaluate(element => {
			const displays = Array.from(element.querySelectorAll<HTMLElement>(".katex-display"));
			return {
				columnFits: element.scrollWidth <= element.clientWidth + 1,
				formulasFit: displays.every(node => node.getBoundingClientRect().width <= element.clientWidth + 1),
				canScroll: displays.some(node => node.scrollWidth > node.clientWidth),
				startsVisible: displays.every(node => {
					const formula = node.querySelector(".katex-html");
					return formula && formula.getBoundingClientRect().left >= node.getBoundingClientRect().left - 1;
				}),
			};
		});
		expect(layout).toEqual({ columnFits: true, formulasFit: true, canScroll: true, startsVisible: true });
		expect(
			await markdown
				.locator(".katex-display")
				.last()
				.evaluate(node => {
					node.scrollLeft = node.scrollWidth;
					const moved = node.scrollLeft > 0;
					node.scrollLeft = 0;
					return moved;
				}),
		).toBe(true);
		await page.screenshot({ path: `test-results/math-${theme}.png`, scale: "css", animations: "disabled" });
	}
	await page.setViewportSize(viewport);
	expect(errors).toEqual([]);
});

test("all named themes apply with readable primary text and no stale scheme tokens", async () => {
	test.setTimeout(90_000);
	const labels = [
		"Graphite",
		"Slate",
		"Deep Sea",
		"Espresso",
		"Ember",
		"Porcelain",
		"Ivory",
		"Sand",
		"Rose Quartz",
		"Glacier",
		"Sage",
	];
	const colors: Record<string, string> = {};
	const contrastValues: Record<string, { body: number; send: number }> = {};
	for (const label of labels) {
		await command("/theme");
		const picker = page.getByRole("dialog");
		await picker.getByPlaceholder("Search themes…").fill(label);
		const option = picker.locator("button[aria-pressed]").filter({ hasText: label });
		await option.click();
		await expect(picker).toHaveCount(0);
		colors[label] = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary"),
		);
		await page.locator("textarea").first().fill("Theme contrast sample");
		const send = page.getByRole("button", { name: "Send (Enter)", exact: true });
		await expect(send).toBeEnabled();
		await send.click({ trial: true, timeout: 1000 });
		await send.evaluate(async button => {
			await Promise.all(button.getAnimations().map(animation => animation.finished.catch(() => {})));
		});
		contrastValues[label] = await send.evaluate(button => {
			const luminance = (color: string) => {
				const match = color.match(/^rgb\(([\d.]+), ([\d.]+), ([\d.]+)\)$/);
				if (!match) throw new Error(`Expected an opaque computed RGB color, received ${color}`);
				const [r, g, b] = match.slice(1).map(value => {
					const channel = Number(value) / 255;
					return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
				});
				return 0.2126 * r + 0.7152 * g + 0.0722 * b;
			};
			const ratio = (element: Element) => {
				const style = getComputedStyle(element);
				const light = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
				return (light[1] + 0.05) / (light[0] + 0.05);
			};
			return { body: ratio(document.body), send: ratio(button) };
		});
		expect(contrastValues[label].body, `${label} body text`).toBeGreaterThanOrEqual(4.5);
		expect(contrastValues[label].send, `${label} send icon`).toBeGreaterThanOrEqual(4.5);
		await page.screenshot({
			path: `test-results/theme-${label.replaceAll(" ", "-")}.png`,
			scale: "css",
			animations: "disabled",
		});
	}
	expect(new Set(Object.values(colors)).size).toBeGreaterThan(8);
	await fs.writeFile("test-results/theme-values.json", JSON.stringify(colors, null, 2));
	await fs.writeFile("test-results/theme-contrast.json", JSON.stringify(contrastValues, null, 2));
});

test("uncertain delivery preserves the draft and blocks duplicate sending until reviewed", async () => {
	const before = (await recorded("prompt")).length;
	await command("fixture uncertain");
	const input = page.locator("textarea").first();
	await expect(input).toHaveValue("fixture uncertain");
	await expect(page.getByRole("button", { name: "Send (Enter)", exact: true })).toBeDisabled();
	await input.press("Enter");
	expect(await recorded("prompt")).toHaveLength(before + 1);
	await page.getByRole("button", { name: "I checked; allow sending", exact: true }).click();
	await expect(page.getByRole("button", { name: "Send (Enter)", exact: true })).toBeEnabled();
	await input.fill("");
});

test("collaboration permission events immediately gate the originating composer and restore editing", async () => {
	const input = page.locator("textarea").first();
	await input.fill("retained collaboration draft");
	await page.evaluate(() => window.omp.rpc.bash("fixture:readonly"));
	await expect(input).not.toBeEditable();
	await expect(page.getByRole("button", { name: "Send (Enter)", exact: true })).toBeDisabled();
	await expect(input).toHaveValue("retained collaboration draft");
	await page.evaluate(() => window.omp.rpc.bash("fixture:writable"));
	await expect(input).toBeEditable();
	await expect(input).toHaveValue("retained collaboration draft");
	await input.fill("");
	expect(errors).toEqual([]);
});

test("security distinguishes unavailable, disabled, unscanned, running, failed and completed scans", async () => {
	test.setTimeout(90_000);
	const states = {
		disabled: "Security disabled",
		unscanned: "This project has not been scanned",
		unavailable: "Scan status unavailable",
		running: "Scan in progress",
		failed: "The selected scan failed",
		incomplete: "The selected scan did not complete",
		clear: "No findings in this scan",
		findings: "Untrusted path reaches file access",
	};
	for (const [state, expected] of Object.entries(states)) {
		await page.evaluate(value => window.omp.rpc.bash(`fixture:security:${value}`), state);
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const modal = page.getByRole("dialog");
		await modal.getByRole("button", { name: "Permissions & security", exact: true }).click();
		await expect(modal).toContainText(expected);
		if (state !== "clear") await expect(modal).not.toContainText("No findings in this scan");
		await page.screenshot({ path: `test-results/security-${state}.png`, scale: "css", animations: "disabled" });
		await page.keyboard.press("Escape");
		await expect(modal).toHaveCount(0);
	}
});

test("repeated modal and task lifecycles release sidecars and document listeners", async () => {
	test.setTimeout(360_000);
	await page.emulateMedia({ reducedMotion: "reduce" });
	const cdp = await page.context().newCDPSession(page);
	const listeners = async () => {
		const { result } = await cdp.send("Runtime.evaluate", { expression: "document" });
		return (await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId! })).listeners.length;
	};
	const before = await listeners();
	for (let index = 0; index < 100; index++) {
		await command("/jobs");
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await page.keyboard.press("Meta+t");
		await expect(page.locator('[role="tablist"] [role="tab"]')).toHaveCount(2);
		await expect(
			page.locator('[role="tablist"] [role="tab"]').last().getByRole("img", { name: "Ready", exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "Close tab", exact: true }).click();
		await expect(page.locator('[role="tablist"] [role="tab"]')).toHaveCount(1);
	}
	const after = await listeners();
	expect(after).toBeLessThanOrEqual(before);
	expect(await page.evaluate(() => window.omp.tabs.list())).toHaveLength(1);
	await fs.writeFile(
		"test-results/lifecycle.json",
		JSON.stringify(
			{
				modalCycles: 100,
				taskCycles: 100,
				documentListenersBefore: before,
				documentListenersAfter: after,
				tabsAfter: 1,
			},
			null,
			2,
		),
	);
	await cdp.detach();
	expect(errors).toEqual([]);
});

test("narrow windows and 200 percent zoom keep settings and primary actions reachable", async () => {
	test.setTimeout(90_000);
	for (const [width, height, zoom] of [
		[1280, 800, 1],
		[1000, 700, 1],
		[1280, 900, 2],
	]) {
		await app.evaluate(
			({ BrowserWindow }, dimensions) => {
				const win = BrowserWindow.getAllWindows()[0];
				win.setSize(dimensions.width, dimensions.height);
				win.webContents.setZoomFactor(dimensions.zoom);
			},
			{ width, height, zoom },
		);
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const modal = page.getByRole("dialog");
		await modal.getByRole("button", { name: "Appearance & use", exact: true }).click();
		const toggle = modal.getByRole("switch", { name: "Compact conversation spacing", exact: true });
		await toggle.scrollIntoViewIfNeeded();
		await toggle.click();
		const captured = await app.evaluate(async ({ BrowserWindow }) =>
			(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"),
		);
		await fs.writeFile(`test-results/layout-${width}-${zoom}.png`, Buffer.from(captured, "base64"));
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
		const input = page.locator("textarea").first();
		await input.fill("layout draft");
		await expect(input).toBeEditable();
		await expect(page.getByRole("button", { name: "Send (Enter)", exact: true })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await input.fill("");
	}
	await app.evaluate(({ BrowserWindow }) => {
		const win = BrowserWindow.getAllWindows()[0];
		win.webContents.setZoomFactor(1);
		win.setSize(1400, 900);
	});
});

test("model benchmark, collaboration, tools and debug open without external mutations", async () => {
	for (const name of ["benchmark", "collab", "tools", "debug", "import"]) {
		await command(`/${name}`);
		const modal = page.getByRole("dialog");
		await expect(modal).toBeVisible();
		await expect.poll(() => modal.evaluate(node => node.contains(document.activeElement))).toBe(true);
		await page.screenshot({ path: `test-results/03-${name}.png`, scale: "css", animations: "disabled" });
		await page.keyboard.press("Escape");
		await expect(modal).toHaveCount(0);
	}
	expect(await recorded("collab_join")).toHaveLength(0);
	expect(errors).toEqual([]);
});

test("settings search opens advanced controls and old refreshes cannot undo a saved edit", async () => {
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = page.getByRole("dialog");
	const search = settings.getByPlaceholder("Search settings and managed resources…");
	await search.fill("proxyUrl");
	await settings.getByRole("button", { name: /^HTTP proxy/ }).click();
	await expect(page.locator("#setting-gui-proxy input")).toBeEditable();
	await search.fill("launchProfiles");
	await settings.getByRole("button", { name: /^Launch profile/ }).click();
	await expect(settings.getByPlaceholder("Leave empty to use the default system prompt")).toBeEditable();
	await search.fill("compaction.reserveTokens");
	await settings.getByRole("button", { name: "Reserve tokens compaction.reserveTokens", exact: true }).click();
	const input = settings.locator('input[type="number"]').first();
	await expect(input).toHaveValue("8192");
	await page.evaluate(() => window.omp.rpc.prompt("fixture hold settings"));
	const before = (await recorded("get_settings")).length;
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("config:update", {}));
	await expect.poll(async () => (await recorded("get_settings")).length).toBeGreaterThan(before);
	await input.fill("12345");
	await input.press("Enter");
	await expect
		.poll(async () => await page.evaluate(() => window.omp.rpc.getSettings(["compaction.reserveTokens"])))
		.toMatchObject({ success: true, data: { values: { "compaction.reserveTokens": 12345 } } });
	await page.evaluate(() => window.omp.rpc.prompt("fixture release settings"));
	await page.evaluate(() => window.omp.rpc.getState());
	await expect(input).toHaveValue("12345");
	await input.fill("8192");
	await input.press("Enter");
	await page.keyboard.press("Escape");
});

test("workspace navigation cannot replace the trusted desktop with an untrusted document", async () => {
	const documentPath = path.join(profile, "untrusted.html");
	await fs.writeFile(documentPath, "<!doctype html><title>Untrusted document</title><h1>Untrusted document</h1>");
	const trustedUrl = page.url();
	await app.evaluate(({ BrowserWindow }) => {
		BrowserWindow.getAllWindows()[0].webContents.once("will-navigate", event => {
			Reflect.set(globalThis, "auditNavigationPrevented", event.defaultPrevented);
		});
	});
	await page.evaluate(url => {
		const link = document.createElement("a");
		link.href = url;
		link.textContent = "Untrusted document";
		document.body.append(link);
		link.click();
		link.remove();
	}, pathToFileURL(documentPath).href);
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "auditNavigationPrevented"))).toBe(true);
	// Read the live document directly: Playwright's locator waits for a native
	// navigation which Electron has already cancelled outside the browser stack.
	expect(await page.evaluate(() => document.querySelector("textarea")?.disabled)).toBe(false);
	expect(page.url()).toBe(trustedUrl);
	await page.reload();
	await expect(page.locator("textarea").first()).toBeEditable();
});

test("launch profile updates preserve concurrent fields and workspaces through the real preferences store", async () => {
	const result = await page.evaluate(async () => {
		const status = await window.omp.sidecar.getStatus();
		const cwd = status.cwd;
		const other = `${cwd}/other.workspace`;
		await Promise.all([
			window.omp.prefs.updateLaunchProfile(cwd, { noRules: true }),
			window.omp.prefs.updateLaunchProfile(cwd, { noLsp: true }),
			window.omp.prefs.updateLaunchProfile(other, { profile: " isolated " }),
		]);
		const saved = (await window.omp.prefs.get("launchProfiles")) as Record<string, unknown>;
		await window.omp.prefs.updateLaunchProfile(cwd, { noRules: false, noLsp: false });
		const cleared = (await window.omp.prefs.get("launchProfiles")) as Record<string, unknown>;
		return { saved: saved[cwd], other: saved[other], cleared: cleared[cwd], preserved: cleared[other] };
	});
	expect(result).toEqual({
		saved: { noRules: true, noLsp: true },
		other: { profile: "isolated" },
		cleared: undefined,
		preserved: { profile: "isolated" },
	});
});

test("failed preference writes retain edits and never allow a premature restart", async () => {
	await app.evaluate(({ ipcMain }) => {
		const pending = Promise.withResolvers<void>();
		Reflect.set(globalThis, "auditProxySave", pending);
		const launch = Promise.withResolvers<void>();
		Reflect.set(globalThis, "auditLaunchSave", launch);
		Reflect.set(globalThis, "auditRestarts", []);
		ipcMain.removeHandler("prefs:set");
		ipcMain.handle("prefs:set", async (_event, payload: { key: string }) => {
			if (payload.key === "codeLineNumbers" || payload.key === "themeName")
				throw new Error("audit appearance write refused");
			if (payload.key === "proxyUrl") {
				Reflect.set(globalThis, "auditProxyRequested", true);
				await pending.promise;
				throw new Error("audit disk write refused");
			}
		});
		ipcMain.removeHandler("prefs:update-launch-profile");
		ipcMain.handle("prefs:update-launch-profile", async () => {
			Reflect.set(globalThis, "auditLaunchRequested", true);
			await launch.promise;
			throw new Error("audit launch write refused");
		});
		ipcMain.removeHandler("sidecar:restart");
		ipcMain.handle("sidecar:restart", (_event, payload) => {
			Reflect.get(globalThis, "auditRestarts").push(payload);
		});
	});
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = page.getByRole("dialog");
	await settings.getByRole("button", { name: "System & advanced", exact: true }).click();
	await settings
		.locator(".settings-nav-item")
		.filter({ hasText: /^Advanced$/ })
		.click();
	const proxy = page.locator("#setting-gui-proxy input");
	await proxy.fill("http://127.0.0.1:7899");
	await proxy.press("Enter");
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "auditProxyRequested"))).toBe(true);
	await page.evaluate(() => window.omp.prefs.get("proxyUrl"));
	expect(await app.evaluate(() => Reflect.get(globalThis, "auditRestarts"))).toEqual([]);
	await app.evaluate(() => Reflect.get(globalThis, "auditProxySave").resolve());
	await expect(page.getByRole("alert")).toContainText("audit disk write refused");
	await expect(proxy).toHaveValue("http://127.0.0.1:7899");
	expect(await app.evaluate(() => Reflect.get(globalThis, "auditRestarts"))).toEqual([]);
	const prompt = settings.getByPlaceholder("Leave empty to use the default system prompt");
	await prompt.fill("Preserve this unsaved instruction.");
	await prompt.press("Tab");
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "auditLaunchRequested"))).toBe(true);
	const restart = settings.getByRole("button", { name: "Restart now", exact: true });
	await expect(restart).toBeDisabled();
	await app.evaluate(() => Reflect.get(globalThis, "auditLaunchSave").resolve());
	await expect(page.getByRole("alert").filter({ hasText: "audit launch write refused" })).toBeVisible();
	await expect(prompt).toHaveValue("Preserve this unsaved instruction.");
	await expect(prompt).toBeEditable();
	await expect(restart).toBeDisabled();
	expect(await app.evaluate(() => Reflect.get(globalThis, "auditRestarts"))).toEqual([]);
	await settings.getByPlaceholder("Search settings and managed resources…").fill("codeLineNumbers");
	await settings.getByRole("button", { name: /^Line numbers/ }).click();
	const lineNumbers = page.locator('#setting-gui-lineNumbers [role="switch"]');
	const checked = await lineNumbers.getAttribute("aria-checked");
	await lineNumbers.click();
	await expect(page.getByRole("alert").filter({ hasText: "audit appearance write refused" })).toBeVisible();
	await expect(lineNumbers).toHaveAttribute("aria-checked", checked ?? "false");
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Choose theme", exact: true }).click();
	const picker = page.getByRole("dialog");
	await picker.getByPlaceholder("Search themes…").fill("Porcelain");
	await picker.locator("button[aria-pressed]").filter({ hasText: "Porcelain" }).click();
	await expect(picker).toHaveCount(0);
	await expect(page.getByRole("alert").filter({ hasText: "audit appearance write refused" })).toBeVisible();
	expect(errors).toEqual([]);
});
