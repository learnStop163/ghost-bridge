const LOCATOR_REF = { $ref: "#/$defs/locator" }
const WAIT_FOR_REF = { $ref: "#/$defs/wait" }

const LOCATOR_DEFINITION = {
  type: "object",
  description: "多字段同时满足；默认 exact，歧义时用 nth 或收窄条件。",
  properties: {
    css: { type: "string", description: "CSS 选择器" },
    testId: { type: "string", description: "data-testid" },
    role: { type: "string", description: "ARIA/隐式 role" },
    name: { type: "string", description: "可访问名称" },
    label: { type: "string", description: "表单 label/aria-label" },
    placeholder: { type: "string" },
    text: { type: "string", description: "元素文本" },
    nth: { type: "integer", minimum: 0, description: "从 0 开始" },
    match: { enum: ["exact", "contains"], description: "默认 exact" },
  },
}

const WAIT_FOR_DEFINITION = {
  type: "object",
  description: "动作后在扩展内部等待，不增加模型往返。",
  properties: {
    type: { enum: ["element", "url", "networkIdle", "expression"] },
    locator: { ...LOCATOR_REF, description: "element 条件的定位器；省略时复用动作 locator" },
    state: { enum: ["visible", "hidden", "attached", "detached", "enabled"], description: "element 默认 visible" },
    contains: { type: "string", description: "URL 包含" },
    equals: { type: "string", description: "URL 等于" },
    idleMs: { type: "number", minimum: 100, maximum: 10000, description: "networkIdle 空闲时间" },
    expression: { type: "string", description: "JS 真值表达式，可返回 Promise" },
    timeoutMs: { type: "number", minimum: 100, maximum: 30000, description: "默认 10000" },
  },
  required: ["type"],
}

const ACTION_PROPERTIES = {
  ref: { type: "string" },
  selector: { type: "string" },
  locator: LOCATOR_REF,
  action: { enum: ["click", "fill", "press", "scroll", "select", "hover", "focus"] },
  value: { type: "string" },
  key: { type: "string" },
  deltaX: { type: "number" },
  deltaY: { type: "number" },
  waitMs: { type: "number", minimum: 0, maximum: 3000 },
  waitFor: WAIT_FOR_REF,
}

const ACTION_DEFINITION = {
  type: "object",
  properties: ACTION_PROPERTIES,
  required: ["action"],
}

export const DISPATCH_ACTION_TOOL = {
  name: "dispatch_action",
  description:
    "定位→操作→等待→快照一次完成。单动传 ref/selector/locator+action，批量传 actions；fill/select 用 value，press 用 key。",
  inputSchema: {
    type: "object",
    $defs: {
      locator: LOCATOR_DEFINITION,
      wait: WAIT_FOR_DEFINITION,
      action: ACTION_DEFINITION,
    },
    properties: {
      // 已绑定命名 target 时扩展会强制要求此字段，schema 必须向模型说明，否则会撞运行时错误
      target: { type: "string", description: "命名目标；已用 bind_tab 绑定 target 时必须传，缺省用聚焦/锁定页" },
      ...ACTION_PROPERTIES,
      timeoutMs: { type: "number", minimum: 1000, maximum: 60000 },
      actions: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { $ref: "#/$defs/action" },
      },
      stopOnError: { type: "boolean" },
      snapshotAfter: { type: "boolean" },
      snapshotSelector: { type: "string" },
      snapshotMaxElements: { type: "number" },
    },
  },
}
