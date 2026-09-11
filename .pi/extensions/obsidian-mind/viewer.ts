/**
 * Briefing viewer — an overlay popup for the session briefing.
 *
 * The briefing is injected into the model context with `display: false`
 * (invisible in the transcript, visible to the LLM); this viewer is how the
 * user reads it: a floating, scrollable popup opened via /om-briefing.
 * Escape, q, or Return closes it; arrows, j/k, page keys, g/G, and mouse
 * wheel scroll.
 */
import { getMarkdownTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	type Component,
	Container,
	Markdown,
	ScrollView,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

class BriefingViewer implements Component {
	done: ((value: boolean) => void) | null = null;
	private readonly outer: Container;
	private readonly scroll: ScrollView;

	constructor(text: string) {
		this.scroll = new ScrollView(
			new Markdown(text, 0, 0, getMarkdownTheme()),
			{ scrollbar: "auto", overscroll: "contain" },
		);
		this.outer = new Container();
		this.outer.addChild(
			new Text(
				"Session briefing  (↑/↓ or j/k scroll · g/G top/bottom · q or esc close)",
				0,
				0,
			),
		);
		this.outer.addChild(this.scroll);
	}

	// Component interface — receives input while the overlay is focused.
	handleInput(data: string): void {
		const done = this.done;
		if (!done) return;
		const page = Math.max(1, this.scroll.viewportHeight - 2);
		if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "q")) {
			done(true);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.scroll.scrollBy(-1);
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.scroll.scrollBy(1);
		else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) this.scroll.scrollBy(-page);
		else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) this.scroll.scrollBy(page);
		else if (matchesKey(data, "home")) this.scroll.scrollToStart();
		else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
	}

	render(width: number): string[] {
		return this.outer.render(width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.outer.handleMouse?.(event);
	}

	invalidate(): void {
		this.outer.invalidate();
	}
}

/**
 * Open the briefing popup. No-op in non-TUI modes (print/JSON/RPC print).
 */
export function openBriefingPopup(ui: ExtensionUIContext, text: string): void {
	void ui.custom<boolean>(
		(_tui, _theme, _keybindings, done) => {
			const viewer = new BriefingViewer(text);
			viewer.done = done;
			return viewer;
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "80%" } },
	);
}
