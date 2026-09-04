import fs from 'node:fs'
import vm from 'node:vm'

export function loadExtensionScript(path, extra = {}) {
  const context = vm.createContext({ ...extra })
  context.self = context
  context.globalThis = context
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path })
  return context
}
