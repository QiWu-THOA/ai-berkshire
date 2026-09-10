import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * /guard — 上下文看门狗 + 实时成本表
 *
 * 为什么需要它：
 *   实测你的历史账本 —— 总成本 $0.77，其中
 *     · 缓存读(Σ上下文)  29.4%
 *     · 未命中输入        39.7%
 *     · 输出+推理        30.9%
 *   而 Σ上下文 = 调用次数 × 每次上下文。最贵的那个会话 654 次调用、
 *   平均每次带着 88.8k 上下文，单会话就占了全部花费的 51.8%。
 *
 *   缓存命中率已经 89%（很好），单价也已经是最便宜的 flash，所以剩下的
 *   唯一大杠杆就是：别让上下文一直挂在 100k 上下运行。
 *
 * pi 自带的自动压缩阈值是 `contextWindow - reserveTokens`（绝对值），
 * 在 131k 窗口上要到 ~115k 才触发，太晚了；而调大 reserveTokens 又会
 * 顺带把摘要输出上限抬到 0.8×reserveTokens，并且会让 32k 窗口的本地模型
 * 每轮都触发压缩。两头都不对。
 *
 *   本扩展改用 ctx.compact() 自己按**窗口比例**判断，因此：
 *     · 对 131k 窗口 ≈ 在 60k 就压
 *     · 对 1M 窗口   ≈ 在 200k 才压（基本不打扰）
 *     · 对 32k 本地模型 ≈ 16k 就压，不会每轮触发
 *
 * 命令：
 *   /guard          查看当前状态与阈值
 *   /guard on|off   开关自动压缩
 *   /guard <0-1>    直接设阈值比例（例如 /guard 0.4）
 *
 * 实时状态行显示：当前上下文 / Σ上下文 / 本次会话累计成本 / 调用次数。
 * 全部走 setStatus，不进入 LLM 上下文，零 token 成本。
 */

const CNY_RATE = 7.2;

type Totals = {
	calls: number;
	cost: number;
	ctxSum: number;
	input: number;
	cacheRead: number;
	output: number;
	reasoning: number;
	costInput: number;
	costCacheRead: number;
	costOutput: number;
};

function emptyTotals(): Totals {
	return {
		calls: 0, cost: 0, ctxSum: 0,
		input: 0, cacheRead: 0, output: 0, reasoning: 0,
		costInput: 0, costCacheRead: 0, costOutput: 0,
	};
}

function fmtTok(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
	return String(Math.round(n));
}

export default function (pi: ExtensionAPI) {
	// 可由命令行覆盖：pi --guard-ratio 0.3
	pi.registerFlag("guard-ratio", {
		description: "上下文自动压缩阈值（占模型窗口的比例，默认 0.45）",
		type: "string",
	});
	pi.registerFlag("guard-max", {
		description: "上下文自动压缩的绝对上限（token，默认 60000）。因为窗口可能报 1M，比例单独用不可靠",
		type: "string",
	});
	pi.registerFlag("guard-off", {
		description: "禁用上下文自动压缩，仅保留状态行",
		type: "boolean",
		default: false,
	});

	const flagRatio = pi.getFlag("guard-ratio");
	let ratio = typeof flagRatio === "string" && Number(flagRatio) > 0.05 && Number(flagRatio) <= 0.95
		? Number(flagRatio)
		: 0.45;
	let enabled = pi.getFlag("guard-off") !== true;
	/**
	 * 绝对上限（token）。为什么必须有这个：
	 * pi 的模型目录里 deepseek-v4-flash 的 contextWindow 报的是 1,000,000，
	 * 而内置压缩阈值 = 窗口 - reserveTokens ≈ 984k，实际上永远不会触发
	 * （实测峰值上下文跑到 283k）。若只看比例，1M × 0.45 = 450k 同样是死代码。
	 * 本扩展的目标是**省钱**而不是“装得下”，所以用绝对值封顶；
	 * 窗口仅用于给小窗口模型（如 32k 本地模型）做安全下限。
	 */
	const flagMax = pi.getFlag("guard-max");
	let maxTarget = typeof flagMax === "string" && Number(flagMax) >= 5000 ? Number(flagMax) : 60_000;
	// 压缩后至少要长回这么多 token 才有必要再压一次，避免抖动
	let lastCompactAt = 0;
	let compacting = false;
	const totals = emptyTotals();
	let ctxTokens = 0;
	let ctxWindow = 0;
	let warnedOnce = false;
	/** 上一次触发压缩时的现场（回调里 ctx 已失效，只能靠这些本地量） */
	let pendingFire: { before: number; limit: number } | null = null;
	/** 挂在状态行上的最近一次压缩结果 */
	let note: string | null = null;
	/** turn_end 发现超阈值时置位，等 agent_settled 真正执行 */
	let needCompact = false;

	const DEBUG_LOG = join(homedir(), ".pi", "agent", "guard.log");

	/** 诊断日志：只在关键决策点写，量很小。用来验证看门狗真的在工作 */
	function log(msg: string) {
		try {
			mkdirSync(dirname(DEBUG_LOG), { recursive: true });
			appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`, "utf-8");
		} catch {
			/* 日志失败不影响主逻辑 */
		}
	}

	/** 从命令行重新读一次（flags 可能晚于扩展工厂完成解析） */
	function syncFlags() {
		const r = pi.getFlag("guard-ratio");
		if (typeof r === "string" && Number(r) > 0.05 && Number(r) <= 0.95) ratio = Number(r);
		const m = pi.getFlag("guard-max");
		if (typeof m === "string" && Number(m) >= 5000) maxTarget = Number(m);
		if (pi.getFlag("guard-off") === true) enabled = false;
	}

	/**
	 * 可压缩的硬下限 —— 必须显著高于 pi 的 compaction.keepRecentTokens。
	 *
	 * pi 压缩时要向前找切点，保留 keepRecentTokens（**默认 20000**）的最近消息。
	 * 若上下文总量还不到这个量，就根本不存在合法切点，调 compact() 会报
	 * "Nothing to compact (session too small)" 并中断当前 run。
	 *
	 * 之前这里是 16000，低于 keepRecentTokens，等于一直在白试。
	 * 现在取 28000（≈ 20000 × 1.4），留出一个多回合的余量。
	 * 若以后把 settings.json 里的 compaction.keepRecentTokens 改小了，
	 * 这个常量可以同步下调，但绝不能低于它。
	 */
	const KEEP_RECENT_TOKENS_FLOOR = 28_000;

	/** 触发阈值 = min(窗口 × 比例, 绝对上限)；窗口未知时返回 0（不动作） */
	function computeLimit(): number {
		if (ctxWindow <= 0) return 0;
		return Math.min(ctxWindow * ratio, maxTarget);
	}

	/** 实际生效的触发点：低于 KEEP_RECENT_TOKENS_FLOOR 时不可能压缩成功 */
	function effectiveTrigger(): number {
		const limit = computeLimit();
		if (limit <= 0) return 0;
		return Math.max(limit, KEEP_RECENT_TOKENS_FLOOR);
	}

	/**
	 * 模型窗口的解析顺序：
	 *   1. ctx.getContextUsage().contextWindow —— 最可靠，pi 对当前模型算出来的
	 *   2. ctx.model.contextWindow
	 * 注意：旧版本这里直接读 ctx.model，拿不到就静默返回 0，导致看门狗完全不工作且不报错。
	 * 现在两层都取不到时会在状态行上显式标红，不再静默失效。
	 */
	function resolveWindow(ctx: any): number {
		try {
			const u = ctx.getContextUsage?.();
			if (u?.contextWindow) return u.contextWindow;
		} catch {
			/* 忽略，继续尝试下一层 */
		}
		try {
			const m = ctx.model ?? (ctx as any).model;
			if (m?.contextWindow) return m.contextWindow;
		} catch {
			/* 忽略 */
		}
		return 0;
	}

	function render(ctx: any) {
		const theme = ctx.ui.theme;
		if (!enabled) {
			ctx.ui.setStatus("guard", theme.fg("dim", "guard off"));
			return;
		}
		const limit = effectiveTrigger();
		const full = limit > 0 ? ctxTokens / limit : 0;

		// 上下文用量：绿 → 黄 → 红
		const ctxColor = limit <= 0 ? "error" : full >= 0.95 ? "error" : full >= 0.75 ? "warning" : "success";
		const ctxPart = theme.fg(
			ctxColor,
			limit <= 0
				? "ctx ?/窗口未知·看门狗失效"
				: `ctx ${fmtTok(ctxTokens)}/${fmtTok(limit)}`,
		);

		// Σ上下文才是真正烧钱的那一项，直接摆出来
		const sigmaPart = theme.fg("dim", `Σ ${fmtTok(totals.ctxSum)}`);

		// 累计成本
		const costPart = theme.fg(
			totals.cost > 0.5 ? "warning" : "dim",
			`$${totals.cost.toFixed(4)} (¥${(totals.cost * CNY_RATE).toFixed(2)})`,
		);

		const callsPart = theme.fg("dim", `${totals.calls}次`);

		// 缓存命中率：低于 85% 说明前缀在被反复打断，值得提醒
		const billed = totals.input + totals.cacheRead;
		const hit = billed > 0 ? totals.cacheRead / billed : 0;
		const hitPart = theme.fg(
			billed > 50_000 && hit < 0.85 ? "warning" : "dim",
			`hit ${(hit * 100).toFixed(0)}%`,
		);

		if (note) {
			ctx.ui.setStatus("guard-note", theme.fg("accent", note));
		}
		ctx.ui.setStatus(
			"guard",
			[ctxPart, sigmaPart, costPart, callsPart, hitPart].join(theme.fg("dim", " · ")),
		);
	}

	pi.registerCommand("guard", {
		description: "上下文看门狗 / 实时成本：/guard [on|off|compact|0-1]",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			// 手动立即压缩。命令处理器的 ctx 是新鲜的（不同于事件处理器）
			if (a === "compact") {
				const before = ctx.getContextUsage()?.tokens ?? 0;
				ctx.ui.notify(`正在压缩（当前 ${fmtTok(before)}）...`, "info");
				ctx.compact({
					customInstructions:
						"保留：已确认的关键财务数据与其来源、当前投资论文的核心假设、未决问题、已写入磁盘的报告文件路径。丢弃：工具调用的中间输出细节、已完成步骤的复述。",
					onComplete: () => log(`MANUAL-DONE before=${before}`),
					onError: (err: unknown) =>
						log(`MANUAL-ERROR ${err instanceof Error ? err.message : String(err)}`),
				});
				return;
			}
			if (a === "on") enabled = true;
			else if (a === "off") enabled = false;
			else if (a && !Number.isNaN(Number(a))) {
				const v = Number(a);
				if (v > 0.05 && v <= 0.95) ratio = v;
				else ctx.ui.notify("比例需在 0.05 ~ 0.95 之间", "warning");
			}
			render(ctx);
			const limit = effectiveTrigger();
			ctx.ui.notify(
				`guard ${enabled ? "已开启" : "已关闭"}｜触发点 = max(min(窗口 ${fmtTok(ctxWindow)} × ${(ratio * 100).toFixed(0)}%, 上限 ${fmtTok(maxTarget)}), 下限 ${fmtTok(KEEP_RECENT_TOKENS_FLOOR)}) = ${limit > 0 ? fmtTok(limit) : "窗口未知"}`,
				"info",
			);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		// flags 可能晚于扩展工厂执行才就绪，这里再同步一次
		syncFlags();
		// /reload 也会触发 session_start，此时不能把累计值清零
		if ((event as any).reason !== "reload") {
			Object.assign(totals, emptyTotals());
			lastCompactAt = 0;
			compacting = false;
			warnedOnce = false;
			needCompact = false;
		}
		ctxWindow = resolveWindow(ctx);
		ctxTokens = ctx.getContextUsage()?.tokens ?? 0;
		log(
			`session_start reason=${(event as any).reason} enabled=${enabled} ratio=${ratio} max=${maxTarget} window=${ctxWindow} limit=${Math.round(effectiveTrigger())} (base ${Math.round(computeLimit())}, floor ${KEEP_RECENT_TOKENS_FLOOR}) tokens=${ctxTokens}`,
		);
		render(ctx);
		if (enabled && ctxWindow <= 0) {
			ctx.ui.notify("上下文看门狗：拿不到模型窗口，自动压缩已失效（状态行会标红）", "error");
		}
	});

	pi.on("model_select", async (event, ctx) => {
		const w = resolveWindow(ctx) || (event as any).model?.contextWindow || ctxWindow;
		ctxWindow = w;
		render(ctx);
	});

	// 每轮结束累加真实用量（来自 provider 返回的 usage，不是估算）
	pi.on("message_end", async (event, ctx) => {
		const msg: any = (event as any).message;
		if (!msg || msg.role !== "assistant" || !msg.usage) return;
		const u = msg.usage;
		const c = u.cost || {};
		totals.calls++;
		totals.input += u.input ?? 0;
		totals.cacheRead += u.cacheRead ?? 0;
		totals.output += u.output ?? 0;
		totals.reasoning += u.reasoning ?? 0;
		totals.costInput += c.input ?? 0;
		totals.costCacheRead += c.cacheRead ?? 0;
		totals.costOutput += c.output ?? 0;
		totals.cost += c.total ?? 0;
		totals.ctxSum += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
	});

	// 压缩完成后要等上下文真的降下来再重置基准
	pi.on("session_compact", async (_e, ctx) => {
		compacting = false;
		// 刚压缩完 tokens 可能为 null（要等下一次 LLM 响应才有值）
		ctxTokens = ctx.getContextUsage()?.tokens ?? 0;
		lastCompactAt = ctxTokens;
		render(ctx);
	});

	/*
	 * ⚠️ 为什么压缩放在 agent_settled 而不是 turn_end：
	 * 在 turn_end（agent run 还在进行中）调 ctx.compact()，摘要那次 LLM 调用会被当前
	 * run 的中断信号杀掉，报 "Turn prefix summarization failed: This operation was aborted"，
	 * 而且会把整个 run 一并中断。实测踩过两次。
	 * agent_settled 的语义是“run 彻底停下来，没有重试/压缩/排队继续”，是唯一安全点：
	 * 压缩在此时发生，下一轮用户输入开始时上下文已经是小的。
	 */
	pi.on("turn_end", async (_e, ctx) => {
		// tokens 可能为 null（刚压缩完、下一次响应之前）；不要用旧值误判
		const live = ctx.getContextUsage();
		if (live?.tokens != null) ctxTokens = live.tokens;
		if (live?.contextWindow) ctxWindow = live.contextWindow;
		render(ctx);

		if (!enabled || compacting || ctxWindow <= 0) {
			if (enabled && ctxWindow <= 0) log(`skip-no-window tokens=${ctxTokens}`);
			return;
		}
		const limit = effectiveTrigger();
		if (limit <= 0 || ctxTokens <= limit) return;
		// 压缩后要长回至少 1/3 个阈值再压，避免连续抖动
		if (lastCompactAt > 0 && ctxTokens - lastCompactAt < limit / 3) {
			log(`skip-cooldown tokens=${ctxTokens} lastCompactAt=${lastCompactAt} limit=${Math.round(limit)}`);
			return;
		}

		// 只做标记，真正压缩留到 run 停下来之后
		needCompact = true;
		log(`ARM tokens=${ctxTokens} limit=${Math.round(limit)} (等 agent_settled)`);
	});

	pi.on("agent_settled", async (_e, ctx) => {
		if (!needCompact || !enabled || compacting) return;
		needCompact = false;
		if (ctxWindow <= 0) return;
		const limit = effectiveTrigger();
		if (limit <= 0 || ctxTokens <= limit) return;

		compacting = true;
		const before = ctxTokens;
		pendingFire = { before, limit };
		log(`FIRE tokens=${before} limit=${Math.round(limit)} window=${ctxWindow} ratio=${ratio}`);
		ctx.compact({
			customInstructions:
				"保留：已确认的关键财务数据与其来源、当前投资论文的核心假设、未决问题、已写入磁盘的报告文件路径。丢弃：工具调用的中间输出细节、已完成步骤的复述。",
			// ⚠️ onComplete / onError 异步触发时捕获的 ctx 已经失效
			// （pi 会抛 “This extension ctx is stale after session replacement or reload”）。
			// 所以这两个回调里**只允许碰本地状态和日志文件**，绝不能调 ctx / ctx.ui。
			onComplete: () => {
				compacting = false;
				lastCompactAt = pendingFire?.before ?? ctxTokens;
				note = `已自动压缩（触发时 ${fmtTok(pendingFire?.before ?? 0)} > 阈值 ${fmtTok(pendingFire?.limit ?? 0)}）`;
				log(`DONE before=${pendingFire?.before ?? -1} limit=${pendingFire?.limit ?? -1}`);
			},
			onError: (err: unknown) => {
				compacting = false;
				const msg = err instanceof Error ? err.message : String(err);
				lastCompactAt = ctxTokens;
				// “会话太小压不了”是正常情况（历史不够、找不到切点），退避即可，不当错误报
				if (/too small|nothing to compact/i.test(msg)) {
					log(`SKIP-BENIGN ${msg}`);
				} else {
					note = `自动压缩失败：${msg}`;
					log(`ERROR ${msg}`);
				}
			},
		});
	});

	// 单次调用特别贵时提醒一次（多半是上下文已经很大又叠加了大量新内容）
	pi.on("message_end", async (event, ctx) => {
		const msg: any = (event as any).message;
		const u = msg?.usage;
		if (!u?.cost || warnedOnce) return;
		const total = u.cost.total ?? 0;
		if (total > 0.02) {
			warnedOnce = true;
			ctx.ui.notify(
				`单次调用花费 $${total.toFixed(4)}（上下文 ${fmtTok((u.input ?? 0) + (u.cacheRead ?? 0))}）——考虑 /compact 或换新会话`,
				"warning",
			);
		}
	});
}
