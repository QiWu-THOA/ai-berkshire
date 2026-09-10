import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

/**
 * /cost — LLM 成本审计
 *
 * 直接从 pi 的 session JSONL 里读真实 usage/cost 记录（不是估算），
 * 回答"钱到底花在哪"：
 *   1. Σ上下文 = 调用次数 × 平均上下文  ← 通常是最大的一笔，且几乎没人注意
 *   2. 未命中输入（每次新增的工具结果/用户输入，按全价计）
 *   3. 输出 + 推理 token（单价最贵）
 *
 * 用法：
 *   /cost          分析当前会话（含自动诊断与可省测算）
 *   /cost all      汇总所有历史会话 + 最贵会话排行
 *   /cost clear    清掉 TUI 里的面板
 *
 * 面板通过 setWidget 渲染，不进入 LLM 上下文，零 token 成本。
 * 完整明细同时落盘到 ~/.pi/agent/cost-reports/，可离线查阅。
 */

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
const REPORTS_DIR = join(homedir(), ".pi", "agent", "cost-reports");
const CNY_RATE = 7.2;

// 低于此上下文视为"合理区间"，用于估算可省金额
const HEALTHY_CTX = 40_000;

type Call = {
	ts: number;
	provider: string;
	model: string;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	reasoning: number;
	costInput: number;
	costCacheRead: number;
	costCacheWrite: number;
	costOutput: number;
	cost: number;
	tools: string[];
};

type Agg = {
	calls: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	reasoning: number;
	costInput: number;
	costCacheRead: number;
	costOutput: number;
	cost: number;
	ctxSum: number;
	ctxMax: number;
	ctxOver100k: number;
	started: number;
	ended: number;
};

function emptyAgg(): Agg {
	return {
		calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
		costInput: 0, costCacheRead: 0, costOutput: 0, cost: 0,
		ctxSum: 0, ctxMax: 0, ctxOver100k: 0, started: 0, ended: 0,
	};
}

function parseSession(file: string): Call[] {
	let raw: string;
	try {
		raw = readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const calls: Call[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let d: any;
		try {
			d = JSON.parse(line);
		} catch {
			continue;
		}
		const m = d?.message;
		if (!m || m.role !== "assistant" || !m.usage) continue;
		const u = m.usage;
		const c = u.cost || {};
		// 收集本次 assistant 消息里发起的工具调用名，用于定位"谁在灌上下文"
		const tools: string[] = [];
		if (Array.isArray(m.content)) {
			for (const part of m.content) {
				if (part?.type === "toolCall" && part.name) tools.push(part.name);
			}
		}
		calls.push({
			ts: m.timestamp ?? d.timestamp ?? 0,
			provider: m.provider ?? "?",
			model: m.model ?? "?",
			input: u.input ?? 0,
			cacheRead: u.cacheRead ?? 0,
			cacheWrite: u.cacheWrite ?? 0,
			output: u.output ?? 0,
			reasoning: u.reasoning ?? 0,
			costInput: c.input ?? 0,
			costCacheRead: c.cacheRead ?? 0,
			costCacheWrite: c.cacheWrite ?? 0,
			costOutput: c.output ?? 0,
			cost: c.total ?? 0,
			tools,
		});
	}
	return calls;
}

function aggregate(calls: Call[]): Agg {
	const a = emptyAgg();
	for (const c of calls) {
		a.calls++;
		a.input += c.input;
		a.cacheRead += c.cacheRead;
		a.cacheWrite += c.cacheWrite;
		a.output += c.output;
		a.reasoning += c.reasoning;
		a.costInput += c.costInput;
		a.costCacheRead += c.costCacheRead;
		a.costOutput += c.costOutput;
		a.cost += c.cost;
		const ctx = c.input + c.cacheRead + c.cacheWrite;
		a.ctxSum += ctx;
		if (ctx > a.ctxMax) a.ctxMax = ctx;
		if (ctx > 100_000) a.ctxOver100k++;
		if (!a.started || c.ts < a.started) a.started = c.ts;
		if (c.ts > a.ended) a.ended = c.ts;
	}
	return a;
}

function usd(n: number): string {
	return "$" + n.toFixed(4);
}

function cny(n: number): string {
	return "¥" + (n * CNY_RATE).toFixed(2);
}

function num(n: number): string {
	return n.toLocaleString("en-US");
}

function tok(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
	return String(n);
}

function pct(a: number, b: number): string {
	return (b > 0 ? (a / b) * 100 : 0).toFixed(1) + "%";
}

/** 有效的每 token 单价（$ / M），用真实账单反推，而不是查价目表 */
function unitCost(cost: number, tokens: number): number {
	return tokens > 0 ? (cost / tokens) * 1e6 : 0;
}

function listSessions(): string[] {
	if (!existsSync(SESSIONS_DIR)) return [];
	const out: string[] = [];
	for (const dir of readdirSync(SESSIONS_DIR)) {
		const full = join(SESSIONS_DIR, dir);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		for (const f of readdirSync(full)) {
			if (f.endsWith(".jsonl")) out.push(join(full, f));
		}
	}
	return out;
}

type Diagnosis = { level: "error" | "warning" | "success" | "muted"; text: string };

function diagnose(calls: Call[], a: Agg): Diagnosis[] {
	const out: Diagnosis[] = [];
	const billed = a.input + a.cacheRead + a.cacheWrite;
	const hitRate = billed > 0 ? a.cacheRead / billed : 0;
	const avgCtx = a.calls > 0 ? a.ctxSum / a.calls : 0;
	const ctxCost = a.costCacheRead;
	const reasoningShare = a.output > 0 ? a.reasoning / a.output : 0;

	// 1. Σ上下文 —— 通常是第一成本项，且与调用次数线性相关
	if (ctxCost > 0 && ctxCost / Math.max(a.cost, 1e-9) > 0.2) {
		out.push({
			level: "warning",
			text: `Σ上下文 ${tok(a.ctxSum)} 已占成本 ${pct(ctxCost, a.cost)}（平均每次 ${tok(avgCtx)}，峰值 ${tok(a.ctxMax)}）`,
		});
	}
	if (avgCtx > HEALTHY_CTX * 1.5) {
		// 把平均上下文压到健康区间理论上能省多少
		const save = ((avgCtx - HEALTHY_CTX) * a.calls * unitCost(a.costCacheRead, a.cacheRead)) / 1e6;
		out.push({
			level: "error",
			text: `平均上下文 ${tok(avgCtx)} 偏高｜压到 ${tok(HEALTHY_CTX)} 理论可省 ${usd(save)}（${cny(save)}）`,
		});
	}
	if (a.ctxOver100k > a.calls * 0.2) {
		out.push({
			level: "warning",
			text: `${a.ctxOver100k}/${a.calls} 次调用上下文 >100k｜该主动 /compact 或按章节切会话`,
		});
	}

	// 2. 缓存命中率 —— 未命中的单价通常是命中的 10~120 倍
	if (hitRate < 0.85 && billed > 100_000) {
		out.push({
			level: "warning",
			text: `缓存命中率偏低 ${pct(a.cacheRead, billed)}（未命中占成本 ${pct(a.costInput, a.cost)}）｜查 /reload、中途切模型、会话中途改 skills/AGENTS.md`,
		});
	} else if (hitRate >= 0.95) {
		out.push({ level: "success", text: `缓存命中率 ${pct(a.cacheRead, billed)}，前缀复用良好` });
	}

	// 3. 推理 token 按输出价计费，单价最贵
	if (reasoningShare > 0.3 && a.output > 50_000) {
		const save = a.output * reasoningShare * 0.4 * unitCost(a.costOutput, a.output);
		out.push({
			level: "warning",
			text: `推理占输出 ${pct(a.reasoning, a.output)}｜机械化步骤降到 medium 约可省 ${usd(save / 1e6)}`,
		});
	}

	// 4. 高价模型是否用在了刀背上
	const byModel = new Map<string, number>();
	for (const c of calls) byModel.set(c.model, (byModel.get(c.model) ?? 0) + c.cost);
	const ranked = [...byModel.entries()].sort((x, y) => y[1] - x[1]);
	if (ranked.length > 1) {
		const [topName, topCost] = ranked[0];
		const cheapCost = a.cost - topCost;
		if (topCost > a.cost * 0.35 && cheapCost > 0) {
			out.push({
				level: "muted",
				text: `${topName} 占成本 ${pct(topCost, a.cost)}｜确认这些调用是否都真的需要该档模型`,
			});
		}
	}

	// 5. 调用次数本身就是成本：每次调用至少要重读一遍系统提示词
	if (a.calls > 250) {
		out.push({
			level: "muted",
			text: `${a.calls} 次 API 调用｜每次调用都重读系统提示词，减少轮次是线性省钱`,
		});
	}
	if (out.length === 0) out.push({ level: "success", text: "未发现明显浪费，成本结构健康" });
	return out;
}

/** 按模型拆解 */
function modelRows(calls: Call[]) {
	type Row = Agg & { model: string; provider: string };
	const map = new Map<string, Row>();
	for (const c of calls) {
		const key = `${c.provider}/${c.model}`;
		let r = map.get(key);
		if (!r) {
			r = { ...emptyAgg(), model: c.model, provider: c.provider };
			map.set(key, r);
		}
		r.calls++;
		r.input += c.input; r.cacheRead += c.cacheRead; r.cacheWrite += c.cacheWrite;
		r.output += c.output; r.reasoning += c.reasoning;
		r.costInput += c.costInput; r.costCacheRead += c.costCacheRead; r.costOutput += c.costOutput;
		r.cost += c.cost;
		const ctx = c.input + c.cacheRead + c.cacheWrite;
		r.ctxSum += ctx;
		if (ctx > r.ctxMax) r.ctxMax = ctx;
	}
	return [...map.values()].sort((x, y) => y.cost - x.cost);
}

function buildLines(calls: Call[], title: string): string[] {
	const a = aggregate(calls);
	const L: string[] = [];
	const billed = a.input + a.cacheRead + a.cacheWrite;
	const avgCtx = a.calls > 0 ? a.ctxSum / a.calls : 0;
	const lines: string[] = [];

	lines.push(`▍${title}`);
	if (a.calls === 0) {
		lines.push("  无 API 调用记录");
		return lines;
	}
	const mins = a.ended > a.started ? Math.round((a.ended - a.started) / 60000) : 0;
	lines.push(
		`  ${a.calls} 次调用${mins > 0 ? ` / ${mins} 分钟` : ""}   成本 ${usd(a.cost)} (${cny(a.cost)})   单次均值 ${usd(a.cost / a.calls)}`,
	);
	lines.push("");
	lines.push("  ── 成本构成 ──────────────────────────────");
	lines.push(`  未命中输入   ${usd(a.costInput).padStart(10)}  ${pct(a.costInput, a.cost).padStart(6)}   ${tok(a.input).padStart(8)} @ $${unitCost(a.costInput, a.input).toFixed(4)}/M`);
	lines.push(`  缓存读       ${usd(a.costCacheRead).padStart(10)}  ${pct(a.costCacheRead, a.cost).padStart(6)}   ${tok(a.cacheRead).padStart(8)} @ $${unitCost(a.costCacheRead, a.cacheRead).toFixed(4)}/M`);
	lines.push(`  输出         ${usd(a.costOutput).padStart(10)}  ${pct(a.costOutput, a.cost).padStart(6)}   ${tok(a.output).padStart(8)} @ $${unitCost(a.costOutput, a.output).toFixed(4)}/M`);
	lines.push("");
	lines.push("  ── 关键指标 ──────────────────────────────");
	lines.push(`  Σ上下文      ${tok(a.ctxSum).padStart(9)}   ← 调用次数 × 平均上下文，通常是第一成本项`);
	lines.push(`  平均上下文   ${tok(avgCtx).padStart(9)}   峰值 ${tok(a.ctxMax)}`);
	lines.push(`  缓存命中率   ${pct(a.cacheRead, billed).padStart(9)}   >95% 为佳`);
	lines.push(`  推理占输出   ${pct(a.reasoning, a.output).padStart(9)}   ${tok(a.reasoning)} tok，按输出价计费`);

	const rows = modelRows(calls);
	lines.push("");
	lines.push("  ── 按模型 ────────────────────────────────");
	for (const r of rows) {
		if (r.cost <= 0 && r.calls < 5) continue;
		const rAvg = r.ctxSum / r.calls;
		lines.push(
			`  ${(r.provider + "/" + r.model).slice(0, 34).padEnd(34)} ${usd(r.cost).padStart(9)} ${pct(r.cost, a.cost).padStart(6)}  ${String(r.calls).padStart(4)}次  平均ctx ${tok(rAvg).padStart(6)}`,
		);
	}

	const diag = diagnose(calls, a);
	lines.push("");
	lines.push("  ── 诊断 ──────────────────────────────────");
	for (const d of diag) {
		const mark = d.level === "error" ? "✗" : d.level === "warning" ? "!" : d.level === "success" ? "✓" : "·";
		lines.push(`  ${mark} ${d.text}`);
	}

	const expensive = [...calls].sort((x, y) => y.cost - x.cost).slice(0, 5);
	if (expensive.length > 0 && expensive[0].cost > 0) {
		lines.push("");
		lines.push("  ── 最贵的 5 次调用 ────────────────────────");
		for (const c of expensive) {
			const ctx = c.input + c.cacheRead + c.cacheWrite;
			lines.push(
				`  ${usd(c.cost).padStart(9)}  ctx ${tok(ctx).padStart(7)}  out ${tok(c.output).padStart(6)}  推理 ${tok(c.reasoning).padStart(6)}  ${c.model.slice(0, 22)}${c.tools.length ? "  " + [...new Set(c.tools)].join(",") : ""}`,
			);
		}
	}
	return lines;
}

function buildMarkdown(calls: Call[], title: string, extra: string[] = []): string {
	const a = aggregate(calls);
	const billed = a.input + a.cacheRead + a.cacheWrite;
	const avgCtx = a.calls > 0 ? a.ctxSum / a.calls : 0;
	const md: string[] = [];
	md.push(`# ${title}`, "");
	md.push(`生成时间: ${new Date().toISOString()}`, "");
	if (a.calls === 0) {
		md.push("无 API 调用记录");
		return md.join("\n");
	}
	md.push("## 摘要", "");
	md.push("| 指标 | 值 |");
	md.push("|---|---|");
	md.push(`| 调用次数 | ${a.calls} |`);
	md.push(`| 成本 | ${usd(a.cost)} (${cny(a.cost)}) |`);
	md.push(`| 单次均值 | ${usd(a.cost / a.calls)} |`);
	md.push(`| Σ上下文 | ${num(a.ctxSum)} |`);
	md.push(`| 平均上下文 | ${num(Math.round(avgCtx))} |`);
	md.push(`| 峰值上下文 | ${num(a.ctxMax)} |`);
	md.push(`| 缓存命中率 | ${pct(a.cacheRead, billed)} |`);
	md.push(`| 推理占输出 | ${pct(a.reasoning, a.output)} |`);
	md.push("");
	md.push("## 成本构成", "");
	md.push("| 项 | 成本 | 占比 | token | 单价 $/M |");
	md.push("|---|---|---|---|---|");
	md.push(`| 未命中输入 | ${usd(a.costInput)} | ${pct(a.costInput, a.cost)} | ${num(a.input)} | ${unitCost(a.costInput, a.input).toFixed(4)} |`);
	md.push(`| 缓存读 | ${usd(a.costCacheRead)} | ${pct(a.costCacheRead, a.cost)} | ${num(a.cacheRead)} | ${unitCost(a.costCacheRead, a.cacheRead).toFixed(4)} |`);
	md.push(`| 输出 | ${usd(a.costOutput)} | ${pct(a.costOutput, a.cost)} | ${num(a.output)} | ${unitCost(a.costOutput, a.output).toFixed(4)} |`);
	md.push("");
	md.push("## 按模型", "");
	md.push("| 模型 | 成本 | 占比 | 调用 | 平均ctx | 未命中 | 缓存读 | 输出 |");
	md.push("|---|---|---|---|---|---|---|---|");
	for (const r of modelRows(calls)) {
		md.push(`| ${r.provider}/${r.model} | ${usd(r.cost)} | ${pct(r.cost, a.cost)} | ${r.calls} | ${num(Math.round(r.ctxSum / r.calls))} | ${num(r.input)} | ${num(r.cacheRead)} | ${num(r.output)} |`);
	}
	md.push("");
	md.push("## 诊断", "");
	for (const d of diagnose(calls, a)) md.push(`- [${d.level}] ${d.text}`);
	if (extra.length) {
		md.push("", "## 排行", "");
		for (const e of extra) md.push(e);
	}
	return md.join("\n");
}

export default function (pi: ExtensionAPI) {
	let lastLines: string[] = [];

	pi.registerCommand("cost", {
		description: "LLM 成本审计：/cost | /cost all | /cost clear",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();

			if (mode === "clear") {
				ctx.ui.setWidget("cost-report", undefined);
				ctx.ui.notify("成本面板已清除", "info");
				return;
			}

			let calls: Call[];
			let title: string;
			let extra: string[] = [];

			if (mode === "all") {
				const files = listSessions();
				calls = [];
				const perSession: Array<{ file: string; calls: number; cost: number; agg: Agg }> = [];
				for (const f of files) {
					const c = parseSession(f);
					if (c.length === 0) continue;
					const ag = aggregate(c);
					if (ag.cost <= 0) continue;
					perSession.push({ file: f, calls: c.length, cost: ag.cost, agg: ag });
					calls.push(...c);
				}
				perSession.sort((x, y) => y.cost - x.cost);
				title = `全部会话汇总（${perSession.length} 个有成本的会话）`;
				const a = aggregate(calls);
				extra.push("| 会话 | 成本 | 占比 | 调用 | Σ上下文 | 命中率 |");
				extra.push("|---|---|---|---|---|---|");
				for (const s of perSession.slice(0, 15)) {
					const billed = s.agg.input + s.agg.cacheRead + s.agg.cacheWrite;
					extra.push(
						`| ${basename(s.file).slice(0, 40)} | ${usd(s.cost)} | ${pct(s.cost, a.cost)} | ${s.calls} | ${tok(s.agg.ctxSum)} | ${pct(s.agg.cacheRead, billed)} |`,
					);
				}
			} else {
				const file = ctx.sessionManager.getSessionFile();
				if (!file) {
					ctx.ui.notify("当前会话尚未落盘，无法分析", "warning");
					return;
				}
				calls = parseSession(file);
				title = `当前会话成本 — ${basename(file).slice(0, 44)}`;
			}

			const lines = buildLines(calls, title);
			const md = buildMarkdown(calls, title, extra);

			try {
				mkdirSync(REPORTS_DIR, { recursive: true });
				const out = join(REPORTS_DIR, `cost-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
				writeFileSync(out, md, "utf-8");
				lines.push("");
				lines.push(`  明细已写入 ${out}`);
			} catch {
				/* 落盘失败不影响面板 */
			}

			lastLines = lines;
			ctx.ui.setWidget("cost-report", (tui: any, theme: any) => ({
				render: () => {
					if (lines.length === 0) return [];
					const head = lines.slice(0, 1).map((l: string) => theme.bold(theme.fg("accent", l)));
					const body = lines.slice(1).map((l: string) => {
						if (l.startsWith("▍")) return theme.bold(theme.fg("accent", l));
						if (l.startsWith("  ──")) return theme.fg("muted", l);
						if (l.includes("✗")) return theme.fg("error", l);
						if (l.includes("  ! ")) return theme.fg("warning", l);
						if (l.includes("  ✓ ")) return theme.fg("success", l);
						if (l.includes("  · ")) return theme.fg("dim", l);
						return theme.fg("text", l);
					});
					return [...head, ...body];
				},
				invalidate: () => {},
			}));

			const a = aggregate(calls);
			ctx.ui.notify(`成本 ${usd(a.cost)} (${cny(a.cost)}) / ${a.calls} 次调用`, "info");
		},
	});
}
