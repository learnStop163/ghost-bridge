#!/usr/bin/env node
// Jev CJK 探针：量测 Jev 在真实中文页面快照上的元素决策准确率。
// 数据流：fixtures/jev-probe/*.json（快照 + 人工标注）→ Jev Choice(none) → 逐用例与汇总指标。
//
// 用法：
//   node scripts/jev-cjk-probe.js --dry qw-1                # 只打印该用例 payload，不发送、不需要 key
//   TYPESAFE_API_KEY=... node scripts/jev-cjk-probe.js --case login-1   # 单用例冒烟
//   TYPESAFE_API_KEY=... node scripts/jev-cjk-probe.js                  # 全量（zh/en 两种问法）
//   TYPESAFE_API_KEY=... node scripts/jev-cjk-probe.js --lang zh        # 只跑中文问法
//   TYPESAFE_API_KEY=... node scripts/jev-cjk-probe.js --json           # 机器可读输出
//
// provider 抽象（决策头可插拔）：
//   --provider jev         默认。TypeSafe API，原生 choice+概率分布+校准置信度
//   --provider anthropic   Anthropic Messages 兼容端点（如智谱 open.bigmodel.cn/api/anthropic），
//                          base_url/token 自动读环境变量或 ~/.claude/settings.json，
//                          自报置信度（需看校准曲线），--model glm-5.3-flash 可换模型
//
// 判定标准（事先约定，脚本只呈现数据不替人决策）：
//   🟢 可能任务 hit@1 ≥ 85% 且 不存在任务 none 检出 ≥ 80% 且 命中/未命中置信度差 ≥ 0.15
//   🟡 可能任务 hit@1 65%~85%
//   🔴 < 65%

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ENDPOINT = process.env.TYPESAFE_ENDPOINT || "https://api.typesafe.ai/v1/systemone"
const MODEL = process.env.TYPESAFE_MODEL || "jev-latest"
const PRICE_PER_MTOK = 0.042
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "jev-probe")
const TIMEOUT_MS = 15000

const args = process.argv.slice(2)
// 取 flag 后面的值；--dry 与 --case 都接受用例 id（--dry login-3 或 --dry --case login-3）
const valueAfter = (name) => {
  const i = args.indexOf(name)
  if (i === -1) return null
  const v = args[i + 1]
  return v && !v.startsWith("--") ? v : null
}
const DRY = args.includes("--dry")
const JSON_OUT = args.includes("--json")
const ONLY_CASE = valueAfter("--case") ?? valueAfter("--dry")
const ONLY_LANG = args.includes("--lang") ? args[args.indexOf("--lang") + 1] : null
const LANGS = ONLY_LANG ? [ONLY_LANG] : ["zh", "en"]
const PROVIDER = (valueAfter("--provider") || "jev").toLowerCase() // jev | anthropic
const MODEL_OVERRIDE = valueAfter("--model")
const ANTHROPIC_MODEL = MODEL_OVERRIDE || "glm-5.3-flash"

const INSTRUCTIONS =
  "Which single element on this page should be interacted with to accomplish the task described in the state? Answer with that element's ref."

function buildPayload(fixture, taskText) {
  const criteria = {}
  for (const el of fixture.elements) criteria[el.ref] = null
  criteria.none = "No element on this page matches the task"
  return {
    model: MODEL,
    state: {
      pageTitle: fixture.title,
      pageUrl: fixture.url,
      task: taskText,
      elements: fixture.elements,
    },
    questions: {
      pick: { type: "choice", instructions: INSTRUCTIONS, criteria },
    },
  }
}

async function callJev(apiKey, payload) {
  const started = performance.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    })
    const latencyMs = Math.round(performance.now() - started)
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw Object.assign(new Error(`http-${res.status} ${body.slice(0, 300)}`), { latencyMs })
    }
    const data = await res.json()
    return { data, latencyMs }
  } finally {
    clearTimeout(timer)
  }
}

function pct(n, d) {
  return d === 0 ? "-" : `${Math.round((n / d) * 100)}%`
}

// ---------- provider: anthropic（智谱 GLM 等 Anthropic Messages 兼容端点） ----------

function resolveAnthropicConfig() {
  // 优先环境变量；否则读 Claude Code 自己的 settings.json（用户模型配置就在那里）
  let baseUrl = process.env.ANTHROPIC_BASE_URL
  let token = process.env.ANTHROPIC_AUTH_TOKEN
  if (!baseUrl || !token) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8"))
      baseUrl = baseUrl || settings.env?.ANTHROPIC_BASE_URL
      token = token || settings.env?.ANTHROPIC_AUTH_TOKEN
    } catch {
      // 没有 settings.json 时走环境变量分支的错误提示
    }
  }
  if (!baseUrl || !token) {
    console.error("缺少 Anthropic 兼容端点配置：需要 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN（环境变量或 ~/.claude/settings.json）")
    process.exit(1)
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), token, model: ANTHROPIC_MODEL }
}

const ANTHROPIC_SYSTEM = [
  "你是浏览器自动化里的元素选择模块。给你一个页面的可交互元素列表和一个任务，",
  "选出为完成任务应当操作的那一个元素。",
  '只输出 JSON：{"pick":"<元素ref或none>","confidence":<0到1的小数，表示你对这个选择的把握>}。',
  '页面上没有元素与任务相关时 pick 为 "none"。不要输出 JSON 以外的任何内容。',
].join("")

function buildAnthropicBody(cfg, fixture, taskText) {
  return {
    model: cfg.model,
    max_tokens: 1000, // 思考型模型会把预算花在内部推理上，截断会导致空输出（absent 用例踩过）
    temperature: 0,
    thinking: { type: "disabled" }, // 网关不认时由 askAnthropicPick 自动去掉重试
    system: ANTHROPIC_SYSTEM,
    messages: [
      {
        role: "user",
        content: `任务：${taskText}\n\n页面：${fixture.title}\n页面元素列表：\n${JSON.stringify(fixture.elements)}`,
      },
    ],
  }
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : text
  const obj = raw.match(/\{[\s\S]*\}/)
  return obj ? JSON.parse(obj[0]) : null
}

async function askAnthropicPick(cfg, fixture, taskText) {
  let body = buildAnthropicBody(cfg, fixture, taskText)
  const started = performance.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  let res
  try {
    const post = (b) =>
      fetch(`${cfg.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(b),
        signal: ac.signal,
      })
    res = await post(body)
    // 个别网关只认 x-api-key：401 时换一种鉴权头重试一次
    if (res.status === 401) {
      res = await fetch(`${cfg.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": cfg.token, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
    }
    // 网关不认 thinking 参数时返回 400：去掉该参数重试一次
    if (res.status === 400) {
      const { thinking, ...rest } = body
      if (thinking) {
        body = rest
        res = await post(body)
      }
    }
    const latencyMs = Math.round(performance.now() - started)
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw Object.assign(new Error(`http-${res.status} ${text.slice(0, 300)}`), { latencyMs })
    }
    const data = await res.json()
    const text = (data.content ?? []).map((c) => c.text || "").join("")
    const parsed = extractJson(text)
    if (!parsed || typeof parsed.pick !== "string") throw Object.assign(new Error(`malformed: ${text.slice(0, 120)}`), { latencyMs })
    return {
      pick: parsed.pick,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
      topProb: null, // Anthropic 协议不暴露 token logprobs，无全选项分布
      probabilities: {},
      latencyMs,
      inputTokens: data.usage?.input_tokens ?? null,
      model: data.model ?? cfg.model,
    }
  } finally {
    clearTimeout(timer)
  }
}

function median(arr, p) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function main() {
  const fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("results-"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf8")))

  const runs = []
  for (const fx of fixtures) {
    for (const c of fx.cases) {
      if (ONLY_CASE && c.id !== ONLY_CASE) continue
      for (const lang of LANGS) {
        runs.push({ fx, c, lang, taskText: lang === "zh" ? c.task : c.taskEn })
      }
    }
  }
  if (!runs.length) {
    console.error(`没有匹配的用例（--case ${ONLY_CASE}）`)
    process.exit(1)
  }

  if (DRY) {
    const run = runs[0]
    if (!run) {
      console.error(`没有匹配的用例（${ONLY_CASE ?? "全部"}）`)
      process.exit(1)
    }
    console.log(
      JSON.stringify(
        PROVIDER === "anthropic"
          ? { endpoint: "(resolved at runtime)", body: buildAnthropicBody(resolveAnthropicConfig(), run.fx, run.taskText) }
          : buildPayload(run.fx, run.taskText),
        null,
        2,
      ),
    )
    return
  }

  const apiKey = process.env.TYPESAFE_API_KEY || process.env.GHOST_BRIDGE_TYPESAFE_KEY
  const anthropicCfg = PROVIDER === "anthropic" ? resolveAnthropicConfig() : null
  if (PROVIDER === "jev" && !apiKey) {
    console.error("缺少 API key：到 https://console.typesafe.ai 申请后 export TYPESAFE_API_KEY=...（或用 --dry 先审查 payload）")
    process.exit(1)
  }

  const results = []
  for (const run of runs) {
    try {
      const r =
        PROVIDER === "anthropic"
          ? await askAnthropicPick(anthropicCfg, run.fx, run.taskText)
          : await (async () => {
              const { data, latencyMs } = await callJev(apiKey, buildPayload(run.fx, run.taskText))
              const a = data.answers?.pick ?? {}
              const probs = a.probabilities ?? {}
              const topP = Object.entries(probs)
                .filter(([k]) => k !== "none")
                .sort((x, y) => y[1] - x[1])[0]
              return {
                pick: a.choice ?? "(missing)",
                confidence: typeof a.confidence === "number" ? a.confidence : null,
                topProb: topP ? topP[1] : null,
                probabilities: probs,
                latencyMs,
                inputTokens: data.usage?.input_tokens ?? null,
                model: data.model ?? null,
              }
            })()
      results.push({
        id: run.c.id, page: run.fx.page, kind: run.c.kind, lang: run.lang,
        task: run.taskText, pick: r.pick, expected: run.c.expectedRef, hit: r.pick === run.c.expectedRef,
        confidence: r.confidence, topProb: r.topProb, probabilities: r.probabilities,
        latencyMs: r.latencyMs, inputTokens: r.inputTokens, model: r.model,
      })
    } catch (e) {
      results.push({
        id: run.c.id, page: run.fx.page, kind: run.c.kind, lang: run.lang,
        task: run.taskText, pick: `error:${e.message}`, expected: run.c.expectedRef, hit: false,
        confidence: null, topProb: null, probabilities: {}, latencyMs: e.latencyMs ?? null,
        inputTokens: null, model: null,
      })
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    for (const r of results) {
      console.log(
        `${r.hit ? "✓" : "✗"} ${r.id.padEnd(8)} ${r.lang} ${r.kind.padEnd(9)} pick=${String(r.pick).padEnd(6)} expect=${String(r.expected).padEnd(5)} conf=${r.confidence ?? "-"} top=${r.topProb ?? "-"} ${r.latencyMs ?? "-"}ms ${r.inputTokens ?? "-"}tok`
      )
    }
  }

  // 汇总（按问法分组；absent 用例单独统计 none 检出）
  const summary = {}
  for (const lang of LANGS) {
    const rs = results.filter((r) => r.lang === lang)
    const possible = rs.filter((r) => r.kind !== "absent")
    const absent = rs.filter((r) => r.kind === "absent")
    const hits = possible.filter((r) => r.hit)
    const misses = possible.filter((r) => !r.hit)
    const avgConf = (arr) => (arr.length ? arr.reduce((s, r) => s + (r.confidence ?? 0), 0) / arr.length : null)
    const tokens = rs.reduce((s, r) => s + (r.inputTokens ?? 0), 0)
    summary[lang] = {
      possibleTotal: possible.length,
      hitAt1: `${hits.length}/${possible.length} = ${pct(hits.length, possible.length)}`,
      byKind: ["clear", "ambiguous"].map((k) => {
        const kr = possible.filter((r) => r.kind === k)
        return `${k}: ${kr.filter((r) => r.hit).length}/${kr.length}`
      }),
      noneDetection: absent.length
        ? `${absent.filter((r) => r.pick === "none").length}/${absent.length} = ${pct(absent.filter((r) => r.pick === "none").length, absent.length)}`
        : "-",
      avgConfidenceHit: avgConf(hits),
      avgConfidenceMiss: avgConf(misses),
      confGap: avgConf(hits) !== null && avgConf(misses) !== null ? avgConf(hits) - avgConf(misses) : null,
      latencyP50: median(rs.map((r) => r.latencyMs).filter(Number.isFinite), 50),
      latencyP95: median(rs.map((r) => r.latencyMs).filter(Number.isFinite), 95),
      totalInputTokens: tokens,
      estCostUsd: +(tokens / 1_000_000 * PRICE_PER_MTOK).toFixed(6),
      model: rs.find((r) => r.model)?.model ?? null,
    }
  }
  console.log("\n===== 汇总 =====")
  const providerLabel = PROVIDER === "anthropic" ? `anthropic:${ANTHROPIC_MODEL}` : `jev:${MODEL}`
  console.log(`provider: ${providerLabel}`)
  console.log(JSON.stringify(summary, null, 2))

  const out = path.join(
    FIXTURES_DIR,
    `results-${PROVIDER}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  )
  fs.writeFileSync(out, JSON.stringify({ summary, results }, null, 2))
  console.error(`\n完整结果已写入 ${out}`)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
