/**
 * obsidian-mind for pi — the lifecycle hook pipeline (phase 1).
 *
 * Maps the vault's five Claude Code hooks onto pi extension events, reusing
 * the SAME lib modules the hook scripts use so the tested contracts stay
 * shared, not forked:
 *
 *   SessionStart     → session_start (build + cache) / before_agent_start (inject)
 *   UserPromptSubmit → before_agent_start (classify prompt, append hints)
 *   PostToolUse      → tool_result on write/edit (validate, warn, refresh QMD)
 *   PreCompact       → session_before_compact (transcript backup + refresh)
 *   Stop             → agent_settled (wrap-up checklist + refresh)
 *
 * Phase 0 parts (skill bridge) and later phases (QMD tools, memory layer)
 * live in sibling modules; see PORTING-PLAN.md in the development workspace.
 */
import { copyFileSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classify } from "../../../.claude/scripts/lib/matcher.ts";
import {
	parseHintState,
	prune,
	record,
	unseen,
} from "../../../.claude/scripts/lib/hint-state.ts";
import {
	shouldRefreshForPath,
	triggerDebouncedRefresh,
} from "../../../.claude/scripts/lib/qmd-refresh.ts";
import { parseInfraRootFilenames } from "../../../.claude/scripts/lib/session-start.ts";
import {
	formatActiveHygiene,
	parseMemoryRoot,
	parseOpenLoopConfig,
	scanActiveHygiene,
} from "../../../.claude/scripts/lib/active-hygiene.ts";
import {
	buildBriefing,
	prepareQmd,
	readManifest,
	type BriefingMode,
} from "./briefing.ts";
import { refreshQmdFor, validateWrittenFile } from "./validate.ts";
import { openBriefingPopup } from "./viewer.ts";
import { registerQmdTools } from "./qmd-tools.ts";

// Session-end checklist text — verbatim from the Stop hook.
const SESSION_END_CHECKLIST = [
	"Session end checklist:",
	"- Archive completed projects? (work/active/ -> work/archive/YYYY/)",
	"- Update indexes? (Index.md, Memories.md, People & Context, Brag Doc)",
	"- New notes linked? (orphans are bugs)",
	"- Run /om-vault-audit if many notes were created/modified",
].join("\n");

const BACKUP_RETAIN = 30;

function formatTimestamp(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
		`_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
	);
}

function pruneBackups(dir: string, retain: number): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	const ordered = entries
		.filter((f) => f.startsWith("session_") && f.endsWith(".jsonl"))
		.map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)
		.map((e) => e.name);
	for (const name of ordered.slice(retain)) {
		try {
			unlinkSync(join(dir, name));
		} catch {
			/* best effort — retention is soft */
		}
	}
}

export default function (pi: ExtensionAPI) {
	// QMD typed tools (phase 2) — registered only when qmd actually resolves;
	// otherwise the qmd skill's documented fallbacks apply.
	registerQmdTools(pi, process.cwd());

	// Per-session state. Rebuilt on every session_start.
	let briefingText: string | null = null;
	let briefingInjected = false;
	pi.on("session_start", async (event, ctx) => {
		const root = ctx.cwd;
		// resume/fork → the static bulk is already in-conversation; the
		// pointer-mode briefing only re-injects the volatile sections.
		const mode: BriefingMode =
			event.reason === "resume" || event.reason === "fork" ? "pointer" : "full";
		// A reload re-reads resources but not the vault; keep the cached
		// briefing rather than paying for a second walk.
		if (event.reason === "reload" && briefingText !== null) return;
		briefingInjected = false;

		const manifestJson = readManifest(root);
		const { notes } = prepareQmd(root, manifestJson); // self-heal + detached re-index
		briefingText = buildBriefing(root, manifestJson, mode, notes);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		let systemPrompt = event.systemPrompt;
		let message: { customType: string; content: string; display: boolean } | undefined;

		// First turn of the session: inject the cached briefing. It is stored
		// in the session and sent to the LLM but NOT rendered in the
		// transcript (display: false) — the user reads it on demand via the
		// /om-briefing popup; the status line advertises that.
		if (briefingText && !briefingInjected) {
			briefingInjected = true;
			message = {
				customType: "obsidian-mind-briefing",
				content: briefingText,
				display: false,
			};
			if (ctx.hasUI) {
				ctx.ui.setStatus(
					"om-briefing",
					`context briefing: ${briefingText.length} chars — /om-briefing to view`,
				);
			}
		}

		// UserPromptSubmit equivalent: classify the prompt, emit routing
		// hints once per session via the shared hint-state file (same file,
		// same 7-day/200-session prune contract the Claude Code hook uses).
		if (typeof event.prompt === "string" && event.prompt) {
			const signals = classify(event.prompt);
			if (signals.length > 0) {
				const sessionId = ctx.sessionManager.getSessionId() ?? "";
				if (sessionId) {
					const statePath = join(ctx.cwd, ".claude", "scripts", ".hint-state.json");
					let state = parseHintState(null);
					try {
						state = parseHintState(
							readFileSync(statePath, { encoding: "utf-8" }),
						);
					} catch {
						/* missing/unreadable state → empty (fail open) */
					}
					const toEmit = unseen(state, sessionId, signals);
					if (toEmit.length > 0) {
						try {
							writeFileSync(
								statePath,
								JSON.stringify(
									prune(
										record(state, sessionId, toEmit, new Date().toISOString()),
										Date.now(),
									),
								),
							);
						} catch {
							/* best effort — dedupe must never break the turn */
						}
						systemPrompt +=
							"\n\n## Vault routing hints\n" +
							toEmit.map((h) => `- ${h}`).join("\n");
					}
				}
			}
		}

		if (message || systemPrompt !== event.systemPrompt) {
			return { message, systemPrompt };
		}
	});

	// PostToolUse equivalent: validate vault-note writes after they land.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const filePath = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof filePath !== "string" || !filePath) return;

		// Debounced QMD refresh — same sentinel as the Claude Code hooks.
		if (shouldRefreshForPath(filePath)) refreshQmdFor(ctx.cwd, filePath);

		const blocks = validateWrittenFile(ctx.cwd, filePath);
		if (blocks === null) return;
		const content = Array.isArray(event.content) ? [...event.content] : [];
		content.push({ type: "text", text: blocks });
		return { content };
	});

	// PreCompact equivalent: back up the session transcript before the
	// agent compacts, so lost history stays recoverable from disk.
	pi.on("session_before_compact", async (event, ctx) => {
		const transcriptPath = ctx.sessionManager.getSessionFile();
		if (!transcriptPath) return;
		const backupDir = join(ctx.cwd, "thinking", "session-logs");
		try {
			mkdirSync(backupDir, { recursive: true });
			const dest = join(
				backupDir,
				`session_${event.reason}_${formatTimestamp(new Date())}.jsonl`,
			);
			copyFileSync(transcriptPath, dest);
			pruneBackups(backupDir, BACKUP_RETAIN);
		} catch {
			/* best effort — compaction must proceed regardless */
		}
		// Writes cluster before compaction; catch them now via the shared
		// debounced refresh so the next session re-indexes a current store.
		triggerDebouncedRefresh({
			sentinelPath: join(ctx.cwd, ".claude", "scripts", ".qmd-refresh-sentinel"),
			workerPath: join(ctx.cwd, ".claude", "scripts", "qmd-refresh-run.ts"),
			debounceMs: 30_000,
			logPrefix: "pi-pre-compact",
		});
	});

	// Stop equivalent: wrap-up checklist + concrete drift findings, and a
	// final debounced refresh so the next session opens against a current
	// index. Silent when the vault is clean beyond the checklist itself.
	pi.on("agent_settled", async (_event, ctx) => {
		triggerDebouncedRefresh({
			sentinelPath: join(ctx.cwd, ".claude", "scripts", ".qmd-refresh-sentinel"),
			workerPath: join(ctx.cwd, ".claude", "scripts", "qmd-refresh-run.ts"),
			debounceMs: 30_000,
			logPrefix: "pi-stop-checklist",
		});
		if (!ctx.hasUI) return;

		const manifestJson = readManifest(ctx.cwd);
		const hygieneLines = formatActiveHygiene(
			scanActiveHygiene(
				ctx.cwd,
				Date.now(),
				parseOpenLoopConfig(manifestJson),
				parseInfraRootFilenames(manifestJson),
				parseMemoryRoot(manifestJson),
			),
		);
		const message =
			SESSION_END_CHECKLIST +
			(hygieneLines.length > 0
				? "\n\nVault Hygiene (drift detected):\n" + hygieneLines.join("\n")
				: "");
		ctx.ui.notify(message, "info");
	});

	// On-demand briefing viewer: a scrollable overlay popup with the exact
	// text the model was injected. Builds on demand if the session never
	// injected one (e.g. reload kept an old cache out).
	pi.registerCommand("om-briefing", {
		description: "Show the session context briefing (popup)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			let text = briefingText;
			if (text === null) {
				const manifestJson = readManifest(ctx.cwd);
				const { notes } = prepareQmd(ctx.cwd, manifestJson);
				text = buildBriefing(ctx.cwd, manifestJson, "full", notes);
				briefingText = text;
			}
			openBriefingPopup(ctx.ui, text);
		},
	});
}
