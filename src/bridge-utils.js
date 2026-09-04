export const DEFAULT_DISPATCH_TIMEOUT_MS = 30000
export const MAX_DISPATCH_TIMEOUT_MS = 60000

export function jsonText(data) {
  return typeof data === "string" ? data : JSON.stringify(data)
}

export function compact(value) {
  if (Array.isArray(value)) {
    const cleaned = value.map(compact).filter((item) => item !== undefined)
    return cleaned.length ? cleaned : undefined
  }
  if (value && typeof value === "object") {
    const cleaned = {}
    for (const [key, item] of Object.entries(value)) {
      const compacted = compact(item)
      if (compacted !== undefined) cleaned[key] = compacted
    }
    return Object.keys(cleaned).length ? cleaned : undefined
  }
  if (value === null || value === "") return undefined
  return value
}

export function out(data) {
  return jsonText(compact(data))
}

export function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function buildTruncatedOutput(text, retainedChars) {
  const headLength = Math.ceil(retainedChars * 0.8)
  const tailLength = Math.max(0, retainedChars - headLength)
  const omitted = Math.max(0, text.length - headLength - tailLength)
  return out({
    truncated: true,
    originalLength: text.length,
    content: `${text.slice(0, headLength)}\n... [已省略 ${omitted} 个字符] ...\n${tailLength ? text.slice(-tailLength) : ""}`,
    hint: "需要更多结果时请收窄返回字段；不要通过连续轮询分片获取大对象",
  })
}

// The cap applies to the final JSON string, not the pre-escaped content. A binary search
// accounts for quotes, backslashes and control characters expanding during JSON.stringify.
export function boundedOut(data, maxLength, { defaultLength = 8000, maxAllowed = 50000 } = {}) {
  const text = out(data) ?? "undefined"
  const limit = clampNumber(maxLength, defaultLength, 200, maxAllowed)
  if (text.length <= limit) return text

  let low = 0
  let high = text.length
  let best = buildTruncatedOutput(text, 0)
  if (best.length > limit) {
    // This should only be reachable with an unusually small caller-provided cap. Preserve
    // valid JSON even then; the public API currently enforces a minimum of 200 characters.
    return JSON.stringify({ truncated: true })
  }

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = buildTruncatedOutput(text, middle)
    if (candidate.length <= limit) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

export function calculateDispatchBudget(args = {}) {
  const steps = Array.isArray(args.actions) ? args.actions : [args]
  if (!steps.length || steps.length > 20) throw new Error("actions 数量必须在 1-20 之间")

  const totalLegacyWaitMs = steps.reduce(
    (sum, step) => sum + clampNumber(step.waitMs, 0, 0, 3000),
    0
  )
  const totalConditionWaitMs = steps.reduce(
    (sum, step) => sum + (step.waitFor ? clampNumber(step.waitFor.timeoutMs, 10000, 100, 30000) : 0),
    0
  )
  const estimatedActionMs = steps.length * 750
  const snapshotMs = args.snapshotAfter ? 2000 : 0
  const estimatedExecutionMs = 2000 + estimatedActionMs + totalLegacyWaitMs + totalConditionWaitMs + snapshotMs

  const explicitTimeout = args.timeoutMs === undefined
    ? null
    : clampNumber(args.timeoutMs, DEFAULT_DISPATCH_TIMEOUT_MS, 1000, MAX_DISPATCH_TIMEOUT_MS)

  if (explicitTimeout === null && estimatedExecutionMs > MAX_DISPATCH_TIMEOUT_MS) {
    throw new Error(
      `批处理最坏执行预算 ${estimatedExecutionMs}ms 超过 ${MAX_DISPATCH_TIMEOUT_MS}ms；` +
      "请减少动作/等待数量、缩短 waitFor.timeoutMs，或显式设置较小的整体 timeoutMs 让批处理按截止时间停止"
    )
  }

  const executionTimeoutMs = explicitTimeout ?? Math.max(5000, Math.min(MAX_DISPATCH_TIMEOUT_MS, estimatedExecutionMs))
  return {
    steps,
    estimatedExecutionMs,
    executionTimeoutMs,
    serverTimeoutMs: executionTimeoutMs + 5000,
  }
}
