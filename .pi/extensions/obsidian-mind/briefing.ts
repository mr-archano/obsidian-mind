/**
 * Session briefing — pi port of the SessionStart hook.
 *
 * The assembly below mirrors `.claude/scripts/session-start.ts` section for
 * section, but imports every pure helper from the SAME lib modules the
 * Claude Code hook uses (`../../../.claude/scripts/lib/session-start.ts` and
 * friends) — the tested contracts (budget, listing collapse, QMD index
 * resolution, hygiene scan) are shared, not re-implemented. Only the glue
 * (file walks, section assembly, env-var plumbing) is ported, and the
 * differences are the deliberate ones:
 *
 *   - no CLAUDE_ENV_FILE write (Claude Code feature)
 *   - cwd arrives as a parameter, never from CLAUDE_PROJECT_DIR
 *   - the injection is returned as a string for pi's before_agent_start
 *     event instead of written to stdout
 *
 * QMD self-heal / min-version checks and the detached re-index spawn are
 * ported unchanged in spirit; see prepareQmd().
 */
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	take,
	formatDateHeader,
	formatInjectionSize,
	formatActiveWork,
	formatRecentChanges,
	isSkippedPath,
	MACHINERY_DIRS,
	extractFrontmatterField,
	formatBrainIndex,
	stripFrontmatter,
	hasBrainContent,
	parseQmdMinVersion,
	qmdArgsWithIndex,
	isQmdNativeAbiMismatch,
	qmdPackageRootFromEntry,
	resolveIndexStorePath,
	parseInfraRootFilenames,
	isInfraFilename,
	isMarkdownFilename,
	collectOpenTasks,
	applyInjectionBudget,
	parseInjectionBudget,
	parseListingCollapseThreshold,
	shouldCollapseDir,
	formatCollapsedDir,
	DEFAULT_LISTING_COLLAPSE_THRESHOLD,
	resolveQmdIndex,
	type BudgetSection,
} from "../../../.claude/scripts/lib/session-start.ts";
import {
	buildQmdCommand,
	qmdVersionAtLeast,
	resolveQmdEntry,
} from "../../../.claude/scripts/lib/qmd.ts";
import {
	formatActiveHygiene,
	parseMemoryRoot,
	parseOpenLoopConfig,
	scanActiveHygiene,
} from "../../../.claude/scripts/lib/active-hygiene.ts";

export type BriefingMode = "full" | "pointer";

export function readManifest(root: string): string | null {
	try {
		return readFileSync(join(root, "vault-manifest.json"), {
			encoding: "utf-8",
		});
	} catch {
		return null;
	}
}

type CmdResult =
	| { readonly kind: "ok"; readonly stdout: string }
	| { readonly kind: "missing" }
	| { readonly kind: "failed" };

function runCmd(
	cmd: string,
	args: readonly string[],
	root: string,
	timeoutMs = 5_000,
): CmdResult {
	const r = spawnSync(cmd, args as string[], {
		cwd: root,
		encoding: "utf-8",
		timeout: timeoutMs,
	});
	if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
		return { kind: "missing" };
	}
	if (r.status !== 0) return { kind: "failed" };
	return { kind: "ok", stdout: r.stdout ?? "" };
}

function northStar(root: string): string {
	// Filesystem-only (no Obsidian CLI hop — it flashes the Electron app on
	// macOS). 30-line budget anchored at "## Current Focus", struck-through
	// completed bullets dropped — all as in the Claude Code hook.
	try {
		const raw = readFileSync(join(root, "brain/North Star.md"), {
			encoding: "utf-8",
		});
		const lines = stripFrontmatter(raw).split("\n");
		const anchor = lines.findIndex((l) =>
			l.trim().startsWith("## Current Focus"),
		);
		const scoped = anchor >= 0 ? lines.slice(anchor) : lines;
		const struckCount = scoped.filter((l) =>
			l.trimStart().startsWith("- ~~"),
		).length;
		const live = scoped.filter((l) => !l.trimStart().startsWith("- ~~"));
		if (struckCount > 0) {
			live.splice(
				1,
				0,
				`_(${struckCount} completed item${struckCount === 1 ? "" : "s"} hidden — full history in brain/North Star.md)_`,
			);
		}
		return take(live.join("\n"), 30);
	} catch {
		return "(not found)";
	}
}

function recentChanges(root: string): string {
	const r = runCmd(
		"git",
		["log", "--oneline", "--since=48 hours ago", "--no-merges"],
		root,
	);
	if (r.kind !== "ok") return "(no git history)";
	return formatRecentChanges(r.stdout, 15);
}

function readMarkdownSource(
	root: string,
	path: string,
): { path: string; content: string } | null {
	try {
		return {
			path,
			content: readFileSync(join(root, path), { encoding: "utf-8" }),
		};
	} catch {
		return null;
	}
}

function listMarkdownSources(
	root: string,
	dir: string,
	pathFor: (name: string) => string,
	skip: (name: string) => boolean = () => false,
): { path: string; content: string }[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, dir), { withFileTypes: true });
	} catch {
		return [];
	}
	const sources: { path: string; content: string }[] = [];
	for (const e of entries) {
		if (!e.isFile() || !isMarkdownFilename(e.name) || skip(e.name)) continue;
		const src = readMarkdownSource(root, pathFor(e.name));
		if (src !== null) sources.push(src);
	}
	return sources;
}

function openTasks(root: string, infraRootFilenames: readonly string[]): string {
	const sources = [
		...listMarkdownSources(root, "work/active", (name) => `work/active/${name}`),
		...listMarkdownSources(root, ".", (name) => name, (name) =>
			isInfraFilename(name, infraRootFilenames),
		),
	];
	return collectOpenTasks(sources, 10);
}

function brainIndex(root: string): string {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, "brain"), { withFileTypes: true });
	} catch {
		return "(none)";
	}
	const files = entries
		.filter((e) => e.isFile() && isMarkdownFilename(e.name))
		.map((e) => e.name)
		.sort();
	const parsed = files.map((f) => {
		const name = f.replace(/\.md$/i, "");
		let description: string | null = null;
		let hasContent = false;
		try {
			const content = readFileSync(join(root, "brain", f), {
				encoding: "utf-8",
			});
			description = extractFrontmatterField(content, "description");
			hasContent = hasBrainContent(stripFrontmatter(content));
		} catch {
			/* unreadable file → show name with no description, treat as empty */
		}
		return { name, description, hasContent };
	});
	return formatBrainIndex(parsed);
}

function activeWork(root: string): string {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, "work/active"), { withFileTypes: true });
	} catch {
		return "(none)";
	}
	const files = entries.filter((e) => e.isFile()).map((e) => e.name);
	return formatActiveWork(files, 10);
}

const SKIP_PREFIXES: readonly string[] = [...MACHINERY_DIRS, "thinking"];
const ALWAYS_COLLAPSED_DIRS: readonly string[] = ["work/archive"];

type WalkResult = {
	readonly lines: readonly string[];
	readonly count: number;
	readonly hasSubdirs: boolean;
};

function countMdOnly(root: string, dir: string, skipPrefixes: readonly string[]): number {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, dir), { withFileTypes: true });
	} catch {
		return 0;
	}
	let n = 0;
	for (const e of entries) {
		const posix = (dir === "." ? e.name : join(dir, e.name)).replaceAll("\\", "/");
		if (isSkippedPath(posix, skipPrefixes)) continue;
		if (e.isDirectory()) n += countMdOnly(root, posix, skipPrefixes);
		else if (e.isFile() && isMarkdownFilename(e.name)) n += 1;
	}
	return n;
}

function walkMd(
	root: string,
	dir: string,
	skipPrefixes: readonly string[],
	alwaysCollapsed: readonly string[],
	collapseThreshold: number,
): WalkResult {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, dir), { withFileTypes: true });
	} catch {
		return { lines: [], count: 0, hasSubdirs: false };
	}
	const lines: string[] = [];
	let count = 0;
	let hasSubdirs = false;
	for (const e of entries) {
		const full = (dir === "." ? e.name : join(dir, e.name)).replaceAll("\\", "/");
		if (isSkippedPath(full, skipPrefixes)) continue;
		if (e.isDirectory()) {
			hasSubdirs = true;
			const posix = full;
			if (alwaysCollapsed.includes(posix)) {
				const n = countMdOnly(root, full, skipPrefixes);
				count += n;
				lines.push(formatCollapsedDir(posix, n));
				continue;
			}
			const sub = walkMd(
				root,
				full,
				skipPrefixes,
				alwaysCollapsed,
				collapseThreshold,
			);
			count += sub.count;
			if (
				shouldCollapseDir(
					sub.count,
					collapseThreshold,
					alwaysCollapsed,
					posix,
					sub.hasSubdirs,
				)
			) {
				lines.push(formatCollapsedDir(posix, sub.count));
			} else {
				lines.push(...sub.lines);
			}
		} else if (e.isFile() && isMarkdownFilename(e.name)) {
			lines.push(`./${full}`);
			count += 1;
		}
	}
	return { lines, count, hasSubdirs };
}

// Source-aware assembly: on re-entry (resume/fork) the static bulk is already
// in-conversation — a pointer replaces it, volatile sections re-inject.
const PRIORITY = {
	LOAD_BEARING: 0,
	HYGIENE: 5,
	VOLATILE: 10,
	RECENT_CHANGES: 20,
	NORTH_STAR: 30,
	BRAIN_INDEX: 40,
	FILE_LISTING: 50,
} as const;

/**
 * Build the full briefing text. Pure filesystem reads + one git log —
 * no Obsidian CLI, no model calls. Deterministic given the vault state.
 */
export function buildBriefing(
	root: string,
	manifestJson: string | null,
	mode: BriefingMode,
	qmdNotes: readonly string[],
): string {
	const infraRootFilenames = parseInfraRootFilenames(manifestJson);
	const listingCollapseThreshold =
		parseListingCollapseThreshold(manifestJson) ??
		DEFAULT_LISTING_COLLAPSE_THRESHOLD;

	const sections: BudgetSection[] = [
		{ header: "", body: "## Session Context", priority: PRIORITY.LOAD_BEARING },
		{
			header: "### Date",
			body: formatDateHeader(new Date()),
			priority: PRIORITY.LOAD_BEARING,
		},
	];
	if (mode === "full") {
		sections.push(
			{
				header: "### North Star (current goals)",
				body: northStar(root),
				priority: PRIORITY.NORTH_STAR,
				fallback: "(Over budget — re-read brain/North Star.md on demand.)",
			},
			{
				header: "### Brain Topics (read on demand)",
				body: brainIndex(root),
				priority: PRIORITY.BRAIN_INDEX,
				fallback: "(Over budget — list brain/ on demand.)",
			},
		);
	}
	sections.push(
		{
			header: "### Recent Changes (last 48h)",
			body: recentChanges(root),
			priority: PRIORITY.RECENT_CHANGES,
			fallback: "(Over budget — run git log on demand.)",
		},
		{ header: "### Open Tasks", body: openTasks(root, infraRootFilenames), priority: PRIORITY.VOLATILE },
		{ header: "### Active Work", body: activeWork(root), priority: PRIORITY.VOLATILE },
	);
	if (mode === "full") {
		sections.push({
			header: "### Vault File Listing",
			body: [
				...walkMd(
					root,
					".",
					SKIP_PREFIXES,
					ALWAYS_COLLAPSED_DIRS,
					listingCollapseThreshold,
				).lines,
			]
				.sort()
				.join("\n"),
			priority: PRIORITY.FILE_LISTING,
			fallback: "(Over budget — Glob or QMD the vault on demand.)",
		});
	} else {
		sections.push({
			header: "### Context Pointer",
			body: "(Re-entry via resume/fork — North Star, brain index, and the file listing were injected at session start and are unchanged; re-read on demand.)",
			priority: PRIORITY.LOAD_BEARING,
		});
	}

	for (const note of qmdNotes) {
		sections.push({
			header: "### QMD Self-Heal",
			body: note,
			priority: PRIORITY.LOAD_BEARING,
		});
	}

	const hygieneLines = formatActiveHygiene(
		scanActiveHygiene(
			root,
			Date.now(),
			parseOpenLoopConfig(manifestJson),
			infraRootFilenames,
			parseMemoryRoot(manifestJson),
		),
	);
	if (hygieneLines.length > 0) {
		sections.push({
			header: "### Vault Hygiene (drift detected)",
			body: hygieneLines.join("\n"),
			priority: PRIORITY.HYGIENE,
		});
	}

	const budgetBytes = parseInjectionBudget(manifestJson);
	const budgeted = applyInjectionBudget(sections, budgetBytes ?? 0);

	const body = budgeted.text + "\n";
	return (
		body +
		"\n" +
		formatInjectionSize(Buffer.byteLength(body, "utf-8"), {
			budgetBytes: budgetBytes ?? undefined,
			collapsed: budgeted.collapsed,
		}) +
		"\n"
	);
}

/**
 * QMD startup flow, ported from the SessionStart hook: self-heal a broken
 * native module, warn on a too-old install, bootstrap an empty store, and
 * kick a detached re-index. Returns the warning notes for the briefing.
 * qmd is optional — a machine without it gets silence, never an error.
 */
export function prepareQmd(
	root: string,
	manifestJson: string | null,
): { notes: string[]; index: string | null } {
	const notes: string[] = [];
	const qmdIndex = resolveQmdIndexSafe(manifestJson, root);
	const qmdEntry = resolveQmdEntry();
	if (qmdIndex === null || qmdEntry === null) {
		// No named index (or no qmd): still kick a legacy `qmd update` when the
		// binary exists, matching the entry's degraded path.
		if (qmdEntry !== null) kickDetachedUpdate(root, manifestJson, null, null);
		return { notes, index: qmdIndex };
	}

	// ABI-mismatch self-heal: bounded to a status probe + a timeboxed rebuild.
	let selfHealNote: string | null = null;
	const preflightCmd = buildQmdCommand(qmdEntry, ["--index", qmdIndex, "status"]);
	const preflight = spawnSync(preflightCmd.cmd, preflightCmd.args as string[], {
		cwd: root,
		encoding: "utf-8",
		timeout: 5_000,
		shell: preflightCmd.shell,
	});
	if (isQmdNativeAbiMismatch(preflight.stderr ?? "")) {
		const pkgRoot = qmdPackageRootFromEntry(qmdEntry);
		if (pkgRoot !== null) {
			const rebuild = spawnSync("npm rebuild better-sqlite3", {
				cwd: pkgRoot,
				encoding: "utf-8",
				timeout: 20_000,
				shell: true,
			});
			selfHealNote =
				rebuild.status === 0
					? "⚠️ QMD's native module (better-sqlite3) was ABI-mismatched against this machine's Node version — auto-rebuilt this session. Semantic search may need one more `qmd update` to fully catch up."
					: "⚠️ QMD's native module (better-sqlite3) is ABI-mismatched against this machine's Node version, and the automatic `npm rebuild better-sqlite3` did not complete cleanly — semantic search is likely dead. Manual fix: `npm rebuild better-sqlite3` inside the @tobilu/qmd package directory, then `qmd update`.";
		}
	}
	if (selfHealNote !== null) notes.push(selfHealNote);

	// Min-version warn-only check.
	const qmdMinVersion = parseQmdMinVersion(manifestJson);
	if (qmdMinVersion !== null) {
		const versionCmd = buildQmdCommand(qmdEntry, ["--version"]);
		const v = spawnSync(versionCmd.cmd, versionCmd.args as string[], {
			cwd: root,
			encoding: "utf-8",
			timeout: 5_000,
			shell: versionCmd.shell,
		});
		if (v.status === 0 && !qmdVersionAtLeast(v.stdout ?? "", qmdMinVersion)) {
			notes.push(
				`⚠️ Installed qmd (${(v.stdout ?? "").trim()}) is below this vault's declared minimum (${qmdMinVersion}) — semantic search may misbehave. Update: \`npm i -g @tobilu/qmd\`, then re-run the bootstrap.`,
			);
		}
	}

	// Empty-store self-heal + detached re-index.
	const bootstrapNeeded = qmdStoreLooksEmpty(qmdIndex);
	kickDetachedUpdate(root, manifestJson, qmdIndex, bootstrapNeeded);
	return { notes, index: qmdIndex };
}

function resolveQmdIndexSafe(
	manifestJson: string | null,
	root: string,
): string | null {
	// Same single-resolver function the five Claude Code callers use — the
	// named-index contract must not grow a second implementation.
	return resolveQmdIndex(manifestJson, root);
}

function qmdStoreLooksEmpty(index: string): boolean {
	try {
		const store = resolveIndexStorePath(index, process.env, homedir());
		return statSync(store).size < 500_000;
	} catch {
		return true;
	}
}

function kickDetachedUpdate(
	root: string,
	manifestJson: string | null,
	qmdIndex: string | null,
	bootstrapNeeded: boolean | null,
): void {
	const qmdEntry = resolveQmdEntry();
	if (qmdEntry === null) return;
	const bootstrap = bootstrapNeeded === true;
	const qmdUpdate = bootstrap
		? {
				cmd: process.execPath,
				args: ["--experimental-strip-types", join(root, ".scripts/qmd-bootstrap.ts")],
				shell: false as const,
			}
		: buildQmdCommand(qmdEntry, qmdArgsWithIndex(qmdIndex, ["update"]));
	if (qmdUpdate.args === null) return;
	const qmdChild = spawn(qmdUpdate.cmd, [...qmdUpdate.args], {
		stdio: "ignore",
		shell: qmdUpdate.shell,
		detached: true,
		windowsHide: true,
		cwd: bootstrap ? root : tmpdir(),
	});
	qmdChild.on("error", () => undefined);
	qmdChild.unref();
}
