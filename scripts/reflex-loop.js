#!/usr/bin/env node
// 反射式浏览器执行器（Agent 侧,实验性）：快照 → 决策 → 执行 循环,引擎在 ./reflex-engine.js。
//
// 定位:ghost-bridge 本体是中立桥(不内置模型);本脚本是桥的**客户端**,
// 通过 MCP 调用它的快照/派发工具。决策头协议可插拔——任何模型都能用:
//   anthropic 协议: 智谱 GLM、DeepSeek 网关、Anthropic 官方、vLLM(anthropic 模式)…
//   openai 协议:    千问、DeepSeek、Kimi、任意 OpenAI 兼容端点…
//
// 决策端点解析(优先级从高到低):
//   1. GHOST_BRIDGE_REFLEX_BASE_URL/_KEY/_MODEL/_PROTOCOL  显式指定
//   2. ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN(anthropic 协议;Claude Code 用户零配置)
//   3. OPENAI_BASE_URL/OPENAI_API_KEY(openai 协议)
//   模型默认:anthropic 协议 glm-5.3-flash(本机网关默认,可覆盖);openai 协议必须显式指定
//
// 用法:
//   node scripts/reflex-loop.js --list                  # 列出内置任务
//   node scripts/reflex-loop.js --task t1 [--dry]       # 单任务(--dry 只打印首个决策请求)
//   node scripts/reflex-loop.js --all                   # 依次全部
//   node scripts/reflex-loop.js --task t1 --provider openai --model qwen-flash   # 换决策头

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  buildDecisionMessages,
  parseDecision,
  runReflexTask,
  resolveReflexConfig,
} from "./reflex-engine.js"

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const DECISION_TIMEOUT_MS = 20000
const DEFAULT_MODEL_BY_PROTOCOL = { anthropic: "glm-5.3-flash", openai: "" }

// ---------- 内置任务(全部无副作用:不点登录/提交/下单) ----------

const TASKS = [
  {
    id: "t1-login-tab",
    tabId: 1211084748,
    task: "把登录方式切换到验证码登录",
    params: {},
    avoidText: ["登录"],
  },
  {
    id: "t2-login-fill",
    tabId: 1211084748,
    task: "在密码输入框填入参数「密码」的值。填完就完成任务,不要点任何按钮",
    params: { 密码: "test123" },
    avoidText: ["登录", "注册账号"],
  },
  {
    id: "t3-df-nav",
    tabId: 1211084764,
    task: "先进入「实名」模块,再进入「快捷签」模块,两步都完成后结束",
    params: {},
    avoidText: [],
  },
  {
    id: "t4-qw-toggle",
    tabId: 1211084747,
    task: "点击收起侧边栏,然后再次把侧边栏展开,完成后结束",
    params: {},
    avoidText: ["退出"],
  },
]

// ---------- 决策头:双协议,自动探测既有环境 ----------

function readClaudeSettingsEnv() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8")).env ?? {}
  } catch {
    return {}
  }
}

export function resolveDecisionProvider(overrides = {}) {
  const settings = readClaudeSettingsEnv()
  const env = { ...settings, ...process.env, ...overrides }
  const protocol =
    overrides.provider ||
    process.env.GHOST_BRIDGE_REFLEX_PROTOCOL ||
    (env.GHOST_BRIDGE_REFLEX_BASE_URL || env.ANTHROPIC_BASE_URL ? "anthropic" : env.OPENAI_BASE_URL || env.OPENAI_API_KEY ? "openai" : null)
  if (!protocol) {
    console.error("未探测到决策端点:配 GHOST_BRIDGE_REFLEX_* / ANTHROPIC_* / OPENAI_* 任一组,或 --provider 指定")
    process.exit(1)
  }
  const cfg = resolveReflexConfig(env) // GHOST_BRIDGE_REFLEX_* 优先,回退 ANTHROPIC_*
  if (protocol === "openai") {
    return {
      protocol,
      baseUrl: (env.GHOST_BRIDGE_REFLEX_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
      apiKey: env.GHOST_BRIDGE_REFLEX_KEY || env.OPENAI_API_KEY || "",
      model: env.GHOST_BRIDGE_REFLEX_MODEL || overrides.model || DEFAULT_MODEL_BY_PROTOCOL.openai,
    }
  }
  return {
    protocol,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: env.GHOST_BRIDGE_REFLEX_MODEL || overrides.model || DEFAULT_MODEL_BY_PROTOCOL.anthropic,
  }
}

async function decide(provider, input) {
  const { system, user } = buildDecisionMessages(input)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), DECISION_TIMEOUT_MS)
  try {
    const request = (url, body) =>
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
          ...(provider.protocol === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
    let url
    let body
    if (provider.protocol === "anthropic") {
      url = `${provider.baseUrl}/v1/messages`
      body = {
        model: provider.model,
        max_tokens: 1000,
        temperature: 0,
        thinking: { type: "disabled" },
        system,
        messages: [{ role: "user", content: user }],
      }
    } else {
      url = `${provider.baseUrl}/chat/completions`
      body = {
        model: provider.model,
        temperature: 0,
        max_tokens: 1000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }
    }
    let res = await request(url, body)
    // 网关不认 thinking / response_format 参数时 400:去掉可选参数重试一次
    if (res.status === 400) {
      const stripped = { ...body }
      delete stripped.thinking
      delete stripped.response_format
      res = await request(url, stripped)
    }
    if (!res.ok) throw new Error(`决策端点 http-${res.status}${res.status === 429 ? "(配额/限流)" : ""}`)
    const data = await res.json()
    const text =
      provider.protocol === "anthropic"
        ? (data.content ?? []).map((c) => c.text || "").join("")
        : data.choices?.[0]?.message?.content ?? ""
    return parseDecision(text)
  } finally {
    clearTimeout(timer)
  }
}

// ---------- ghost-bridge MCP 客户端(接法同 benchmark-mcp.js) ----------

async function connectBridge() {
  const entry = fs.existsSync(path.join(REPO, "dist", "server.js"))
    ? path.join(REPO, "dist", "server.js")
    : path.join(REPO, "src", "server.js")
  const env = { ...process.env }
  delete env.GHOST_BRIDGE_DAEMON
  const client = new Client({ name: "reflex-pilot", version: "1.0" })
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "pipe", env })
  transport.stderr?.on("data", () => {})
  await client.connect(transport)
  return client
}

async function callTool(client, name, args) {
  const res = await client.callTool({ name, arguments: args })
  const text = res.content?.[0]?.text ?? ""
  if (text.startsWith("Error:")) throw new Error(`${name}: ${text}`)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// ---------- 入口 ----------

const args = process.argv.slice(2)
const valueAfter = (n) => {
  const v = args[args.indexOf(n) + 1]
  return v && !v.startsWith("--") ? v : null
}

if (args.includes("--list")) {
  for (const t of TASKS) console.log(`${t.id}  tab=${t.tabId}  ${t.task}`)
  process.exit(0)
}

const DRY = args.includes("--dry")
const wanted = args.includes("--all") ? TASKS.map((t) => t.id) : [valueAfter("--task")].filter(Boolean)
if (!wanted.length) {
  console.error("用法: node scripts/reflex-loop.js --task t1 | --all [--dry] | --list")
  process.exit(1)
}

const provider = resolveDecisionProvider({
  provider: valueAfter("--provider"),
  model: valueAfter("--model") || undefined,
})
if (!provider.model) {
  console.error(`协议 ${provider.protocol} 无默认模型:用 --model 或 GHOST_BRIDGE_REFLEX_MODEL 指定`)
  process.exit(1)
}
console.log(`决策头: ${provider.model} @ ${provider.baseUrl} (${provider.protocol} 协议)`)

const client = await connectBridge()

for (const id of wanted) {
  const spec = TASKS.find((t) => t.id === id || t.id.startsWith(id + "-"))
  if (!spec) {
    console.error(`未知任务 ${id}(--list 查看)`)
    continue
  }
  console.log(`\n===== ${spec.id}: ${spec.task} =====`)
  const targetName = `reflex-${spec.id}`
  try {
    await callTool(client, "bind_tab", { name: targetName, tabId: spec.tabId })
  } catch (e) {
    console.log(`  结果: bind-failed: ${e.message}`)
    continue
  }

  if (DRY) {
    const snap = await callTool(client, "get_interactive_snapshot", { target: targetName, includeText: true })
    console.log(JSON.stringify(buildDecisionMessages({ task: spec.task, params: spec.params, elements: snap.elements ?? [], history: [] }), null, 2))
    continue
  }

  const log = await runReflexTask({
    task: spec.task,
    params: spec.params,
    avoidText: spec.avoidText,
    maxSteps: 10,
    snapshot: () => callTool(client, "get_interactive_snapshot", { target: targetName, includeText: true }),
    dispatch: (a) =>
      callTool(client, "dispatch_action", {
        target: targetName,
        ...a,
        waitFor: { type: "networkIdle", idleMs: 600, timeoutMs: 8000 },
        snapshotAfter: false,
      }),
    decide: (input) => decide(provider, input),
  })
  for (const s of log.steps) {
    const d = s.decision
    console.log(
      `  step${s.step} ${d ? `${d.action}${d.ref ? "@" + d.ref : ""}${d.valueKey ? `(${d.valueKey})` : ""} conf=${d.confidence}` : "-"} ` +
        `${s.element ? `「${String(s.element).slice(0, 20)}」` : ""}${s.note ? ` ← ${s.note}` : ""}`,
    )
  }
  console.log(`  结果: ${log.outcome}  已执行 ${log.executed} 步`)
}

await client.close()
