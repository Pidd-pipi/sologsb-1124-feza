/**
 * 修订基线（乐观并发）三向合并。
 *
 * 背景：邮路、实寄封可在多个浏览器标签页同时编辑。保存时带着「我打开时看到的
 * 基线值 base」，与库里的当前值 current 比较：
 *
 * - 字段只有我方改动，或只有对方改动 → 互不冲突，直接并入；
 * - 双方改了同一字段且改成不同值 → 冲突，保留先保存（库里 current）的值，
 *   把该字段记为冲突字段，由上层提示，不允许后保存静默覆盖先保存；
 * - 双方改成相同值 → 视为一致，不记冲突。
 *
 * 合并成功后记录修订号 rev 自增。数组 / 嵌套对象按整体比较（不做逐元素合并），
 * 这符合本应用「节点、贴票构成、标签集合均为整体编辑」的使用方式。
 */

export interface MergePatch {
  [field: string]: unknown
}

export interface MergeResult {
  /** 最终应写库的补丁（已含新的 rev / updatedAt） */
  patch: MergePatch
  /** 双方改了同一字段且取值不同的字段名 */
  conflictFields: string[]
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a as Record<string, unknown>)
    const kb = Object.keys(b as Record<string, unknown>)
    if (ka.length !== kb.length) return false
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
  }
  return false
}

/** 元数据字段不参与字段级合并判定。 */
const META_FIELDS = new Set(['id', 'rev', 'createdAt', 'updatedAt'])

/**
 * 三向合并一条记录。
 * @param base     本页打开时看到的基线记录（缺字段视为从未被本页读取，不参与冲突判定）
 * @param current  数据库中的当前记录（先保存者的结果）
 * @param incoming 本页希望写入的补丁
 * @param nextRev 合并后的新修订号（通常 current.rev + 1）
 */
export function threeWayMerge(
  base: MergePatch | null,
  current: MergePatch,
  incoming: MergePatch,
  nextRev: number
): MergeResult {
  const patch: MergePatch = {}
  const conflictFields: string[] = []

  for (const [field, incomingValue] of Object.entries(incoming)) {
    if (META_FIELDS.has(field)) continue
    const currentValue = current[field]

    // 我方值与库内当前值相同：别人已经写成我想要的样子（或本就一致）。
    if (deepEqual(incomingValue, currentValue)) {
      patch[field] = currentValue
      continue
    }

    // 没有基线（如新建对象/旧数据直接写）时退化为保守策略：以库内为准，仅并入我方新增字段。
    if (!base || !(field in base)) {
      if (!(field in current)) patch[field] = incomingValue
      else conflictFields.push(field)
      continue
    }

    const baseValue = base[field]

    // 对方没动过（current === base），我方改动可直接并入。
    if (deepEqual(currentValue, baseValue)) {
      patch[field] = incomingValue
      continue
    }

    // 对方动过（current !== base）：
    if (deepEqual(incomingValue, baseValue)) {
      // 我方没动，沿用先保存者的值。
      patch[field] = currentValue
    } else {
      // 双方都改且改得不同：冲突，保留先保存值，标记冲突。
      patch[field] = currentValue
      conflictFields.push(field)
    }
  }

  patch.rev = nextRev
  return { patch, conflictFields }
}
