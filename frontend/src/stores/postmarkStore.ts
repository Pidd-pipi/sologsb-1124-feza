import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, saveAsset } from '@/utils/db'
import type { Postmark } from '@/types/postmark'
import { INITIAL_REV } from '@/types/route'
import { nextSerialNo, nowIso } from '@/utils/id'
import { threeWayMerge, type MergePatch } from '@/utils/revision'
import { publishRevision } from '@/utils/revisionBus'

export interface ImagePayload {
  dataUrl: string
  fileName: string
}

export interface PostmarkSaveOutcome {
  conflictFields: string[]
}

export const usePostmarkStore = defineStore('postmark', () => {
  const list = ref<Postmark[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      list.value = await db.postmarks.orderBy('pmNo').toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 生成下一个编目号，如 PM-0007 */
  function nextPmNo(): string {
    return nextSerialNo('PM-', list.value.map((p) => p.pmNo))
  }

  async function create(input: Postmark, image?: ImagePayload | null): Promise<number> {
    const now = nowIso()
    const record: Postmark = {
      ...input,
      pmNo: input.pmNo || nextPmNo(),
      lettering: { ...input.lettering },
      rev: INITIAL_REV,
      createdAt: now,
      updatedAt: now
    }
    delete record.id
    const id = await db.transaction('rw', db.postmarks, db.assets, async () => {
      const newId = await db.postmarks.add(record)
      if (image && image.dataUrl) {
        await saveAsset({
          ownerType: 'postmark',
          ownerId: newId,
          side: 'sample',
          dataUrl: image.dataUrl,
          fileName: image.fileName,
          updatedAt: now
        })
      }
      return newId
    })
    await load()
    publishRevision({ id, kind: 'postmark' })
    return id
  }

  /**
   * 合并保存邮戳：带 base 时按修订基线三向合并，互不冲突直接并入，
   * 同一字段两边改成不同值时保留先保存值并返回冲突字段。
   */
  async function save(
    id: number,
    patch: Partial<Postmark>,
    base?: Partial<Postmark>
  ): Promise<PostmarkSaveOutcome> {
    const { rev: _rev, ...fieldPatch } = patch
    void _rev
    const conflictFields = await db.transaction('rw', db.postmarks, async () => {
      const current = await db.postmarks.get(id)
      if (!current) throw new Error(`邮戳 #${id} 已不存在`)
      const merged = threeWayMerge(
        (base ?? current) as MergePatch,
        current as unknown as MergePatch,
        fieldPatch as MergePatch,
        current.rev + 1
      )
      await db.postmarks.update(id, { ...merged.patch, updatedAt: nowIso() })
      return merged.conflictFields
    })
    await load()
    publishRevision({ id, kind: 'postmark' })
    return { conflictFields }
  }

  async function remove(id: number): Promise<void> {
    await db.transaction('rw', db.postmarks, db.assets, async () => {
      await db.postmarks.delete(id)
      const own = await db.assets.where('ownerId').equals(id).toArray()
      await db.assets.bulkDelete(
        own
          .filter((a) => a.ownerType === 'postmark')
          .map((a) => a.id)
          .filter((v): v is number => typeof v === 'number')
      )
    })
    await load()
    publishRevision({ id, kind: 'postmark' })
  }

  function byId(id: number | null | undefined): Postmark | null {
    if (id == null) return null
    return list.value.find((p) => p.id === id) ?? null
  }

  /** 「编目号 + 局所」短标签，供关联列表与详情页复用 */
  const labelOf = computed(() => {
    return (id: number): string => {
      const pm = byId(id)
      return pm ? `${pm.pmNo} ${pm.office}` : `未登记邮戳 #${id}`
    }
  })

  const total = computed(() => list.value.length)
  const scarceCount = computed(
    () => list.value.filter((p) => p.scarceLevel === '罕见' || p.scarceLevel === '孤品').length
  )

  return {
    list,
    loading,
    loaded,
    total,
    scarceCount,
    load,
    nextPmNo,
    create,
    save,
    remove,
    byId,
    labelOf
  }
})
