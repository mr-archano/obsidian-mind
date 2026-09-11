/**
 * Briefing viewer — an overlay popup for the session briefing.
 *
 * The briefing is injected into the model context with `display: false`
 * (invisible in the transcript, visible to the LLM); this viewer is how the
 * user reads it: a floating, bordered, scrollable popup opened via
 * /om-briefing. Escape, q, or Return closes it; arrows, j/k, page keys,
 * g/G, home/end scroll.
 *
 * The scroll window is bounded here, not by the overlay: the viewer renders
 * only a slice of the Markdown lines per frame, sized from the terminal
 * height (tui.terminal.rows). A ScrollView measured inside an overlay has
 * no bounded viewport — scrollBy clamps to zero movement, which is exactly
 * the bug this replaces.
 */
import { getMarkdownTheme, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	Markdown,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

type Fg = Theme["fg"];

class BriefingViewer implements Component {
	private readonly markdown: Markdown;
	private lines: string[] = [];
	private lastWidth = -1;
	private scrollTop = 0;
	private themeFg: Fg;
	done: ((value: boolean) => void) | null = null;

	constructor(
		text: string,
		private readonly tui: TUI,
		theme: Theme,
	) {
		this.markdown = new Markdown(text, 0, 0, getMarkdownTheme());
		this.themeFg = theme.fg.bind(theme);
	}

	// Component interface — receives input while the overlay is focused.
	handleInput(data: string): void {
		const done = this.done;
		if (!done) return;
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "return") ||
			matchesKey(data, "q")
		) {
			done(true);
			return;
		}
		const viewport = Math.max(1, this.viewportHeight());
		const page = Math.max(1, viewport - 2);
		const maxScroll = Math.max(0, this.lines.length - viewport);
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.scrollTop -= 1;
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.scrollTop += 1;
		else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) this.scrollTop -= page;
		else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) this.scrollTop += page;
		else if (matchesKey(data, "home") || matchesKey(data, "g")) this.scrollTop = 0;
		else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) this.scrollTop = maxScroll;
		else return;
		this.scrollTop = Math.max(0, Math.min(maxScroll, this.scrollTop));
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// Wheel scrolls by 3 lines per notch; everything else falls through.
		if (event.type === "wheel" && event.wheelDelta) {
			const viewport = Math.max(1, this.viewportHeight());
			const maxScroll = Math.max(0, this.lines.length - viewport);
			this.scrollTop = Math.max(0, Math.min(maxScroll, this.scrollTop - event.wheelDelta * 3));
			this.tui.requestRender();
			return { handled: true };
		}
		return undefined;
	}

	private viewportHeight(): number {
		// Leave room for the TUI chrome around the overlay: header, editor,
		// status/footer, plus the box border and title/footer rows.
		return Math.max(5, this.tui.terminal.rows - 10);
	}

	render(width: number): string[] {
		const innerW = Math.max(20, width - 4); // │ + pad + content + pad + │
		if (width !== this.lastWidth) {
			this.lines = this.markdown.render(innerW);
			this.lastWidth = width;
			const viewport = this.viewportHeight();
			this.scrollTop = Math.max(
				0,
				Math.min(this.scrollTop, Math.max(0, this.lines.length - viewport)),
			);
		}
		const fg = this.themeFg;
		const viewport = Math.min(this.viewportHeight(), this.lines.length);
		const maxScroll = Math.max(0, this.lines.length - viewport);
		const top = Math.min(this.scrollTop, maxScroll);
		const window = this.lines.slice(top, top + viewport);

		const out: string[] = [];
		// Top border with an embedded title.
		const title = " Session briefing ";
		const titleW = visibleWidth(title);
		const barW = Math.max(0, width - 2 - titleW);
		const leftBar = Math.floor(barW / 2);
		const rightBar = barW - leftBar;
		out.push(
			fg("border", `╭${"─".repeat(leftBar)}`) +
				fg("accent", title) +
				fg("border", `${"─".repeat(rightBar)}╮`),
		);
		for (const line of window) {
			const clipped = truncateToWidth(line, innerW, "…", true);
			const pad = Math.max(0, innerW - visibleWidth(clipped));
			out.push(
				fg("border", "│") +
					" " +
					clipped +
					" ".repeat(pad) +
					" " +
					fg("border", "│"),
			);
		}
		// Bottom border with a scroll-position indicator on the right.
		const indicator =
			this.lines.length > viewport
				? ` lines ${top + 1}–${top + viewport} of ${this.lines.length} · ↑↓ scroll · q close `
				: ` ${this.lines.length} lines · q close `;
		const indW = visibleWidth(indicator);
		const dashTotal = Math.max(0, width - 2 - indW);
		const leftDash = Math.max(1, Math.floor(dashTotal * 0.6));
		const rightDash = Math.max(1, dashTotal - leftDash);
		out.push(
			fg("border", `╰${"─".repeat(leftDash)}`) +
				fg("dim", indicator) +
				fg("border", `${"─".repeat(rightDash)}╯`),
		);
		return out;
	}

	invalidate(): void {
		this.lastWidth = -1;
		this.lines = [];
	}
}

/**
 * Open the briefing popup. No-op in non-TUI modes (print/JSON/RPC print).
 */
export function openBriefingPopup(ui: ExtensionUIContext, text: string): void {
	void ui.custom<boolean>(
		(tui, theme, _keybindings, done) => {
			const viewer = new BriefingViewer(text, tui, theme);
			viewer.done = done;
			return viewer;
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "80%" } },
	);
}
