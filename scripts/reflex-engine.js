// 反射式浏览器操作的纯逻辑引擎：快照→模型决策→执行 的循环编排。
// 定位说明（重要）：ghost-bridge 本体是"任何模型可用"的中立桥，不内置任何模型概念——
// 本引擎因此放在 scripts/（Agent 侧实验区），由 reflex-loop.js 这类客户端执行器驱动，
// 决策头用什么模型完全是使用者自己的配置。注入 snapshot/dispatch/decide 三个函数；测试注入 mock。
// pilot 实测教训全部内建：
//   - 已执行动作历史注入（没有它模型看不到"做过没有"，会无限重复）
//   - avoidText 整词匹配（子串会把「验证码登录」误拦成「登录」）
//   - fill/select 值只来自 params 预设，模型永不生成内容
//   - press 仅限安全键白名单
//   - 同 (action,ref) 连续 3 次判卡死

export const REFLEX_CONF_FLOOR = 0.6
export const REFLEX_MAX_STEPS = 15
export const REFLEX_PRESS_KEYS = ["Enter", "Escape", "Tab"]
export const REFLEX_ACTIONS = ["click", "fill", "select", "press"]

// 配置解析（纯函数，便于测试）。这是发布给所有用户的包：不内置任何厂商默认模型，
// base/key 可借用 ANTHROPIC_*（协议兼容），但 model 必须显式指定——三者齐备工具才启用。
// 支持任何 Anthropic Messages 兼容端点：智谱 GLM、DeepSeek 网关、Anthropic 官方、自部署 vLLM 等。
export function resolveReflexConfig(env = process.env) {
  const baseUrl = (env.GHOST_BRIDGE_REFLEX_BASE_URL || env.ANTHROPIC_BASE_URL || "").replace(/\/+$/, "")
  const apiKey = env.GHOST_BRIDGE_REFLEX_KEY || env.ANTHROPIC_AUTH_TOKEN || ""
  const model = env.GHOST_BRIDGE_REFLEX_MODEL || ""
  return { baseUrl, apiKey, model, enabled: Boolean(baseUrl && apiKey && model) }
}

const SYSTEM = [
  "你是浏览器自动化循环的决策模块。每一轮你会看到:任务描述、可用参数、已执行动作历史、页面可交互元素列表。",
  '输出一个 JSON 决定这一轮做一件事:{"action":"click|fill|select|press|stop","ref":"<元素ref>","valueKey":"<参数名,仅fill/select需要>","key":"<Enter|Escape|Tab,仅press需要>","confidence":<0到1的小数>}',
  "规则:",
  "- click:点击 ref 元素;fill:在 ref 输入框填入 valueKey 对应参数的值;select:用 valueKey 参数的值选中 ref 下拉项;press:对 ref 按 key",
  "- 值由系统从参数表提供,禁止编造任何内容",
  "- stop:任务已由「已执行动作」完成(不要重复已做过的动作),或页面上没有合理的下一步元素(不要硬挑最接近的)",
  "- 多步任务按顺序推进,每轮只做一个动作;任务完成立即 stop",
  "- confidence 表示你对这一步的把握,不确定时给低值",
  "只输出 JSON,不要输出其他内容。",
].join("\n")

export function buildDecisionMessages({ task, params, elements, history }) {
  return {
    system: SYSTEM,
    user:
      `任务:${task}\n可用参数:${JSON.stringify(params ?? {})}\n` +
      `已执行动作:${history?.length ? history.join(";") : "(无,尚未开始)"}\n` +
      `页面元素列表:\n${JSON.stringify(elements ?? [])}`,
  }
}

export function parseDecision(text) {
  const fenced = (text || "").match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : text || ""
  const obj = raw.match(/\{[\s\S]*\}/)
  if (!obj) return { action: "unparseable", confidence: 0 }
  try {
    const p = JSON.parse(obj[0])
    return {
      action: typeof p.action === "string" ? p.action : "unparseable",
      ref: typeof p.ref === "string" ? p.ref : null,
      valueKey: typeof p.valueKey === "string" ? p.valueKey : null,
      key: typeof p.key === "string" ? p.key : null,
      confidence: typeof p.confidence === "number" ? p.confidence : 0,
    }
  } catch {
    return { action: "unparseable", confidence: 0 }
  }
}

// 执行前校验：返回 {ok:true, value?, key?} 或 {ok:false, reason}
// reason ∈ low-confidence | avoid | unsupported-action | no-value | press-key
export function checkDecision(d, { elementText = "", confFloor = REFLEX_CONF_FLOOR, avoidText = [], params = {} }) {
  if (!REFLEX_ACTIONS.includes(d.action)) return { ok: false, reason: "unsupported-action" }
  if (d.confidence < confFloor) return { ok: false, reason: "low-confidence" }
  if (d.action === "click" && avoidText.map((t) => String(t).trim()).includes(String(elementText).trim())) {
    return { ok: false, reason: "avoid" }
  }
  if ((d.action === "fill" || d.action === "select") && !(d.valueKey && d.valueKey in params)) {
    return { ok: false, reason: "no-value" }
  }
  if (d.action === "press" && !REFLEX_PRESS_KEYS.includes(d.key)) return { ok: false, reason: "press-key" }
  return {
    ok: true,
    value: d.action === "fill" || d.action === "select" ? params[d.valueKey] : undefined,
    key: d.action === "press" ? d.key : undefined,
  }
}

function briefElements(elements) {
  return (elements ?? []).slice(0, 8).map((e) => ({
    ref: e.ref,
    tag: e.tag,
    role: e.role,
    text: e.text,
    placeholder: e.placeholder,
  }))
}

// 三个注入函数：
//   snapshot() → { elements, title, url }
//   dispatch({ action, ref, value, key }) → 任意结果（只记录摘要）
//   decide({ task, params, elements, history }) → { action, ref, valueKey, key, confidence }
// 返回 { outcome, steps, lastState }；outcome ∈
//   stopped-by-model | blocked-<reason> | stuck | max-steps | decision-error | dispatch-error
export async function runReflexTask({
  task,
  params = {},
  avoidText = [],
  maxSteps = 8,
  confFloor = REFLEX_CONF_FLOOR,
  snapshot,
  dispatch,
  decide,
}) {
  const steps = []
  const history = []
  const sigs = []
  let outcome = null
  let lastState = null
  const cap = Math.min(REFLEX_MAX_STEPS, Math.max(1, Number(maxSteps) || 8))

  for (let step = 1; step <= cap && !outcome; step++) {
    let elements = []
    try {
      const snap = await snapshot()
      elements = snap?.elements ?? []
      lastState = {
        title: snap?.title,
        url: snap?.url,
        elementCount: elements.length,
        topElements: briefElements(elements),
      }
    } catch (e) {
      steps.push({ step, note: `snapshot 失败:${e.message}` })
      outcome = "dispatch-error"
      break
    }

    let d
    try {
      d = await decide({ task, params, elements, history })
    } catch (e) {
      steps.push({ step, note: `决策失败:${e.message}` })
      outcome = "decision-error"
      break
    }
    const el = elements.find((x) => x.ref === d.ref)
    const elementText = el?.text || el?.placeholder || ""

    if (d.action === "stop") {
      steps.push({ step, decision: d, note: "model-stop" })
      outcome = "stopped-by-model"
      break
    }

    const check = checkDecision(d, { elementText, confFloor, avoidText, params })
    if (!check.ok) {
      steps.push({ step, decision: d, element: elementText, note: `拦截:${check.reason}` })
      outcome = `blocked-${check.reason}`
      break
    }

    const sig = `${d.action}:${d.ref}`
    sigs.push(sig)
    if (sigs.slice(-3).join(",") === `${sig},${sig},${sig}`) {
      steps.push({ step, decision: d, note: "同一动作连续 3 次,判定卡死" })
      outcome = "stuck"
      break
    }

    try {
      const res = await dispatch({
        action: d.action,
        ref: d.ref,
        value: check.value,
        key: check.key,
      })
      steps.push({
        step,
        decision: d,
        element: elementText,
        fillValue: check.value,
        dispatchNote:
          typeof res === "object" && res ? (res.detail ?? res.success ?? "") : String(res ?? "").slice(0, 80),
      })
      history.push(
        d.action === "fill" || d.action === "select"
          ? `${d.action}「${elementText}」=参数「${d.valueKey}」`
          : d.action === "press"
            ? `press「${elementText}」${d.key}`
            : `click「${elementText}」`,
      )
    } catch (e) {
      steps.push({ step, decision: d, element: elementText, note: `执行失败:${e.message}` })
      outcome = "dispatch-error"
      break
    }
  }
  if (!outcome) outcome = "max-steps"

  return { outcome, steps, lastState, executed: history.length }
}
