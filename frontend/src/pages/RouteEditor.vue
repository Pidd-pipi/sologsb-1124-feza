<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import RouteTimeline from '@/components/common/RouteTimeline.vue'
import { buildTimeline, useCoverRoute } from '@/hooks/useCoverRoute'
import { computeTotalDays, createRouteNode, useRouteStore } from '@/stores/routeStore'
import { useCoverStore } from '@/stores/coverStore'
import { useConflictStore } from '@/stores/conflictStore'
import type { Cover } from '@/types/cover'
import type { PostalRoute, RouteNode, TimelineNode } from '@/types/route'
import { TRANSPORT_MODES, createEmptyRoute } from '@/types/route'
import { toGanzhi, validateChronology } from '@/utils/dateRange'
import { nowIso } from '@/utils/id'
import {
  clearRecoverableDraft,
  loadRecoverableDraft,
  saveRecoverableDraft
} from '@/utils/draft'
import { isTimelineStale } from '@/utils/timelineStatus'

const props = defineProps<{ id: string }>()
const router = useRouter()
const routeStore = useRouteStore()
const coverStore = useCoverStore()
const conflictStore = useConflictStore()

const routeId = computed<number | null>(() => {
  const n = Number(props.id)
  return Number.isFinite(n) && n > 0 ? n : null
})

const route = computed<PostalRoute | null>(() => routeStore.byId(routeId.value))

const form = reactive<PostalRoute>(createEmptyRoute())
const nodeDialog = ref(false)
const nodeForm = reactive<RouteNode>(createRouteNode())
const insertIndex = ref<number | null>(null)
const selectedCoverId = ref<number | null>(null)

const previewCoverId = computed<number | null>(() => selectedCoverId.value)

const { cover: previewCover, timeline: previewTimeline, transitDays } = useCoverRoute(previewCoverId)

const nodeTimeline = computed<TimelineNode[]>(() =>
  (route.value?.nodes ?? []).map((node) => ({
    key: node.key,
    label: '节点',
    office: node.office || '节点待补',
    date: node.arriveDate,
    mark: node.transitMark || '中转戳待补',
    kind: 'transit' as const
  }))
)

const chronology = computed(() =>
  validateChronology((route.value?.nodes ?? []).map((n) => n.arriveDate))
)

const computedDays = computed(() => computeTotalDays(route.value?.nodes ?? []))

const attachedCovers = computed(() =>
  coverStore.list.filter((c) => c.routeId === routeId.value)
)

const unattachedCovers = computed(() =>
  coverStore.list.filter((c) => c.routeId !== routeId.value)
)

/** 挂在本邮路、但时间轴基线已落后（节点改动后未核对）的封。 */
const staleCovers = computed(() =>
  attachedCovers.value.filter((c) =>
    isTimelineStale(c, route.value, conflictStore.openConflictOfCover(c.id ?? -1) != null)
  )
)

/** 本邮路的待裁定数：后保存一方主张挂到本路、当前尚未生效的冲突。 */
const pendingConflicts = computed(() =>
  routeId.value == null ? [] : conflictStore.pendingAgainstRoute(routeId.value)
)

/** 本邮路涉及的全部未裁定冲突（含先保存一方在本路的），供面板列出。 */
const relatedConflicts = computed(() =>
  routeId.value == null ? [] : conflictStore.openConflictsOfRoute(routeId.value)
)

function isCoverStale(cover: Cover): boolean {
  return isTimelineStale(cover, route.value, conflictStore.openConflictOfCover(cover.id ?? -1) != null)
}

function pendingCoverIds(): Set<number> {
  return new Set(relatedConflicts.value.map((c) => c.coverId))
}

const coverOptions = computed(() =>
  coverStore.list.flatMap((c) =>
    typeof c.id === 'number'
      ? [
          {
            label: `${c.coverNo} ${c.sentFrom}→${c.sentTo}${c.routeId === routeId.value ? '（已挂）' : ''}`,
            value: c.id
          }
        ]
      : []
  )
)

/** 未挂邮路时，用封的中转地拼出参考时间轴 */
const fallbackTimeline = computed<TimelineNode[]>(() => {
  if (!route.value) return []
  return buildTimeline(
    {
      id: 0,
      coverNo: 'REF',
      sentFrom: route.value.nodes[0]?.office ?? '',
      sentTo: route.value.nodes[route.value.nodes.length - 1]?.office ?? '',
      postDate: route.value.nodes[0]?.arriveDate ?? '',
      arriveDate: route.value.nodes[route.value.nodes.length - 1]?.arriveDate ?? '',
      franking: [],
      cancelPmIds: [],
      routeId: route.value.id ?? null,
      viaPoints: [],
      registered: false,
      conditionGrade: '中品',
      acquireFrom: '',
      price: 0,
      storageAlbum: '',
      frontImage: '',
      backImage: '',
      note: '',
      rev: 0,
      timelineBaseRev: 0,
      createdAt: '',
      updatedAt: ''
    },
    route.value
  )
})

onMounted(async () => {
  if (!routeStore.loaded) await routeStore.load()
  if (!coverStore.loaded) await coverStore.load()
  if (!conflictStore.loaded) await conflictStore.load()
  syncForm()
  offerRecover()
})

watch(route, syncForm)

/** 写失败后留下的可恢复草稿：重新进入邮路页时提示恢复。 */
const RECOVER_SCOPE = computed(() => `route-header:${routeId.value ?? 'new'}`)
const recoverHint = ref('')

function offerRecover(): void {
  const draft = loadRecoverableDraft<Partial<PostalRoute>>(RECOVER_SCOPE.value)
  if (!draft) return
  ElMessageBox.confirm(
    `上次保存邮路信息失败（${draft.reason}）。是否恢复到失败前的编辑内容？`,
    '发现可恢复草稿',
    { confirmButtonText: '恢复草稿', cancelButtonText: '放弃', type: 'warning' }
  )
    .then(() => {
      Object.assign(form, draft.value)
      recoverHint.value = `已恢复 ${draft.savedAt.slice(0, 16)} 的失败草稿，请重新保存`
    })
    .catch(() => {
      clearRecoverableDraft(RECOVER_SCOPE.value)
    })
}

watch(attachedCovers, (list) => {
  if (selectedCoverId.value == null && list.length && typeof list[0].id === 'number') {
    selectedCoverId.value = list[0].id
  }
})

/** 保存时携带的修订基线快照：本页打开/上次同步时看到的邮路字段。 */
const baseSnapshot = ref<Partial<PostalRoute>>({})

function snapshotOf(): Partial<PostalRoute> {
  const current = route.value
  if (!current) return {}
  return {
    routeNo: current.routeNo,
    name: current.name,
    era: current.era,
    transport: current.transport,
    frequency: current.frequency,
    remark: current.remark
  }
}

function syncForm(): void {
  const current = route.value
  if (!current) return
  Object.assign(form, {
    ...current,
    nodes: current.nodes.map((n) => ({ ...n }))
  })
  baseSnapshot.value = snapshotOf()
}

async function saveHeader(): Promise<void> {
  const id = routeId.value
  if (id == null) return
  if (!form.name.trim()) {
    ElMessage.warning('请填写邮路名称')
    return
  }
  const patch = {
    routeNo: form.routeNo,
    name: form.name,
    era: form.era,
    transport: form.transport,
    frequency: form.frequency,
    remark: form.remark
  }
  try {
    const { conflictFields } = await routeStore.save(id, patch, baseSnapshot.value)
    clearRecoverableDraft(RECOVER_SCOPE.value)
    recoverHint.value = ''
    if (conflictFields.length) {
      ElMessage.warning(
        `字段「${conflictFields.join('、')}」在另一页面已被改成不同内容，已保留先保存的值，请核对`
      )
    } else {
      ElMessage.success('邮路信息已保存')
    }
  } catch (err) {
    // 写库整体失败：事务已回滚，留下可恢复草稿
    saveRecoverableDraft(RECOVER_SCOPE.value, {
      reason: err instanceof Error ? err.message : String(err),
      targetId: id,
      baseRev: route.value?.rev ?? null,
      value: patch
    })
    ElMessage.error('保存失败，改动已回滚并存为可恢复草稿，刷新本页可恢复重试')
  }
}

function openNodeDialog(index: number | null): void {
  Object.assign(nodeForm, createRouteNode())
  insertIndex.value = index
  nodeDialog.value = true
}

async function submitNode(): Promise<void> {
  const id = routeId.value
  if (id == null) return
  if (!nodeForm.office.trim()) {
    ElMessage.warning('请填写节点局所')
    return
  }
  try {
    await routeStore.addNode(id, { ...nodeForm }, insertIndex.value ?? undefined)
    nodeDialog.value = false
    ElMessage.success('已加入邮路节点，挂接封时间轴已标记失效待核对')
  } catch (err) {
    ElMessage.error(
      `节点保存失败，已回滚：${err instanceof Error ? err.message : String(err)}`
    )
  }
}

async function onReorder(payload: { from: number; to: number }): Promise<void> {
  const id = routeId.value
  if (id == null) return
  try {
    await routeStore.moveNode(id, payload.from, payload.to)
  } catch (err) {
    ElMessage.error(`排序失败，已回滚：${err instanceof Error ? err.message : String(err)}`)
  }
}

async function onRemove(index: number): Promise<void> {
  const id = routeId.value
  const node = route.value?.nodes[index]
  if (id == null || !node) return
  try {
    await routeStore.removeNode(id, node.key)
    ElMessage.success('已移除节点，挂接封时间轴已标记失效待核对')
  } catch (err) {
    ElMessage.error(`移除失败，已回滚：${err instanceof Error ? err.message : String(err)}`)
  }
}

function onTimelineSelect(node: TimelineNode): void {
  ElMessage.info(`节点 ${node.office}（${node.date || '日期待考'}）`)
}

async function recalc(): Promise<void> {
  const id = routeId.value
  const current = route.value
  if (id == null || !current) return
  try {
    await routeStore.commitNodes(id, current.nodes.map((n) => ({ ...n })))
    ElMessage.success(`全程天数已重算：${computeTotalDays(current.nodes)} 天`)
  } catch (err) {
    ElMessage.error(`重算失败，已回滚：${err instanceof Error ? err.message : String(err)}`)
  }
}

async function attachCover(): Promise<void> {
  const id = routeId.value
  const coverId = selectedCoverId.value
  if (id == null || coverId == null) {
    ElMessage.warning('请选择要挂到此邮路的实寄封')
    return
  }
  const cover = coverStore.byId(coverId)
  try {
    const { routeConflict } = await coverStore.attachToRoute({
      coverId,
      routeId: id,
      // 本页下拉里看到的原挂接：据此判断是否与另一页的先保存撞车
      expectedFromRouteId: cover?.routeId ?? null,
      source: 'route-page'
    })
    if (routeConflict) {
      ElMessageBox.alert(
        `该封已在另一页面被先挂到邮路 #${routeConflict.winner.routeId ?? '（摘除）'}，` +
          `本次挂到本路的主张已列为待裁定，未覆盖先保存结果。请在下方「待裁定」面板裁决。`,
        '挂接冲突 · 待裁定',
        { type: 'warning' }
      )
    } else {
      ElMessage.success('实寄封已挂到该邮路')
    }
  } catch (err) {
    ElMessage.error(`挂接失败，已回滚：${err instanceof Error ? err.message : String(err)}`)
  }
}

async function detachCover(cover: Cover): Promise<void> {
  if (typeof cover.id !== 'number') return
  try {
    await coverStore.attachToRoute({
      coverId: cover.id,
      routeId: null,
      expectedFromRouteId: cover.routeId,
      source: 'route-page:detach'
    })
    ElMessage.success('已从邮路摘除')
  } catch (err) {
    ElMessage.error(`摘除失败，已回滚：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 裁决待裁定挂接：choose=winner 维持先保存，pending 改挂后保存方。 */
async function resolveConflict(
  conflictId: number | undefined,
  choose: 'winner' | 'pending'
): Promise<void> {
  if (typeof conflictId !== 'number') return
  try {
    await conflictStore.resolve(conflictId, choose)
    ElMessage.success(choose === 'pending' ? '已按后保存主张改挂，基线已重对齐' : '已维持先保存挂接')
  } catch (err) {
    ElMessage.error(`裁决失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 封详情核对后补基线（邮路页可批量确认）。 */
async function revalidateCover(cover: Cover): Promise<void> {
  if (typeof cover.id !== 'number') return
  const ok = await coverStore.rebaselineTimeline(cover.id)
  ElMessage.success(ok ? '该封时间轴已核对并补基线，恢复检索命中' : '该封时间轴本就有效')
}

function openCover(cover: Cover): void {
  if (typeof cover.id !== 'number') return
  void router.push(`/covers/${cover.id}`)
}

function routeLabelOf(routeId: number | null): string {
  if (routeId == null) return '（摘除邮路）'
  const rt = routeStore.byId(routeId)
  return rt ? `${rt.routeNo} ${rt.name}` : `邮路 #${routeId}`
}

const createForm = reactive<PostalRoute>(createEmptyRoute())
const creating = ref(false)

async function createRoute(): Promise<void> {
  if (!createForm.name.trim()) {
    ElMessage.warning('请填写邮路名称')
    return
  }
  creating.value = true
  try {
    const id = await routeStore.create({
      ...createForm,
      routeNo: createForm.routeNo || routeStore.nextRouteNo(),
      nodes: createForm.nodes.map((n) => ({ ...n })),
      createdAt: nowIso(),
      updatedAt: nowIso()
    })
    ElMessage.success('邮路已创建')
    await router.replace(`/routes/${id}`)
  } catch (err) {
    saveRecoverableDraft('route-new', {
      reason: err instanceof Error ? err.message : String(err),
      targetId: null,
      baseRev: null,
      value: JSON.parse(JSON.stringify(createForm)) as PostalRoute
    })
    ElMessage.error('新建失败，已回滚并存为可恢复草稿')
  } finally {
    creating.value = false
  }
}

function nodeGanzhi(node: RouteNode): string {
  const year = Number((node.arriveDate || '').slice(0, 4))
  return year ? toGanzhi(year) : '—'
}
</script>

<template>
  <div class="gb-page route-editor">
    <header class="gb-page__head">
      <div>
        <h1 class="gb-page__title">
          邮路编辑器
          <span v-if="route" class="route-editor__no">{{ route.routeNo }}</span>
          <el-tag
            v-if="route && pendingConflicts.length"
            type="danger"
            effect="dark"
            size="small"
            class="route-editor__badge"
          >
            待裁定 {{ pendingConflicts.length }}
          </el-tag>
          <el-tag
            v-if="route && staleCovers.length"
            type="warning"
            effect="dark"
            size="small"
            class="route-editor__badge"
          >
            时间轴失效 {{ staleCovers.length }}
          </el-tag>
        </h1>
        <p class="gb-page__subtitle">
          <template v-if="route">
            {{ route.name }} · {{ route.era || '时期待考' }} · {{ route.transport }} ·
            {{ route.frequency || '班期待考' }}
          </template>
          <template v-else>节点可拖拽排序、增删中转地，全程天数按节点日期自动计算。</template>
        </p>
      </div>
      <el-button @click="router.push('/covers')">返回实寄封目录</el-button>
    </header>

    <template v-if="route">
      <section class="gb-panel">
        <h2 class="gb-panel__title">邮路信息</h2>
        <p v-if="recoverHint" class="route-editor__recover">{{ recoverHint }}</p>
        <el-form :inline="true" label-width="82px" @submit.prevent>
          <el-form-item label="邮路号">
            <el-input v-model="form.routeNo" style="width: 130px" />
          </el-form-item>
          <el-form-item label="邮路名称">
            <el-input v-model="form.name" style="width: 220px" />
          </el-form-item>
          <el-form-item label="时期">
            <el-input v-model="form.era" placeholder="如 1910-1919" style="width: 140px" />
          </el-form-item>
          <el-form-item label="运输">
            <el-select v-model="form.transport" style="width: 110px">
              <el-option v-for="t in TRANSPORT_MODES" :key="t" :label="t" :value="t" />
            </el-select>
          </el-form-item>
          <el-form-item label="班期">
            <el-input v-model="form.frequency" placeholder="如 逐日班" style="width: 130px" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="form.remark" style="width: 280px" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="saveHeader">保存邮路信息</el-button>
          </el-form-item>
        </el-form>
      </section>

      <section class="gb-panel">
        <div class="route-editor__head">
          <h2 class="gb-panel__title">节点编辑（拖拽排序 / 增删中转地）</h2>
          <span class="route-editor__summary">
            全程 {{ route.totalDays }} 天（按节点日期自动计算：{{ computedDays }} 天）
            <el-button size="small" @click="recalc">重算全程天数</el-button>
          </span>
        </div>
        <p v-if="!chronology.ok" class="route-editor__warn">{{ chronology.message }}</p>
        <RouteTimeline
          :nodes="nodeTimeline"
          editable
          insertable
          title="邮路节点"
          @reorder="onReorder"
          @remove="onRemove"
          @insert="openNodeDialog"
          @select="onTimelineSelect"
        />
        <el-table :data="route.nodes" border stripe class="route-editor__table">
          <el-table-column label="顺序" width="80">
            <template #default="{ $index }">{{ $index + 1 }}</template>
          </el-table-column>
          <el-table-column prop="office" label="局所" min-width="150" />
          <el-table-column prop="arriveDate" label="到达日期" width="130" />
          <el-table-column label="干支" width="90">
            <template #default="{ row }">{{ nodeGanzhi(row) }}</template>
          </el-table-column>
          <el-table-column prop="transitMark" label="中转戳" min-width="160" />
          <el-table-column label="操作" width="170">
            <template #default="{ $index }">
              <el-button size="small" link type="primary" @click="openNodeDialog($index + 1)">
                后插节点
              </el-button>
              <el-button size="small" link type="danger" @click="onRemove($index)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section v-if="relatedConflicts.length" class="gb-panel route-editor__conflicts">
        <div class="route-editor__head">
          <h2 class="gb-panel__title">待裁定挂接（{{ relatedConflicts.length }}）</h2>
          <span class="route-editor__summary">
            同一封被两个页面基于同一基线挂到不同邮路，先保存挂接保留，后保存主张在此裁决
          </span>
        </div>
        <el-table :data="relatedConflicts" border stripe>
          <el-table-column label="实寄封" min-width="150">
            <template #default="{ row }">
              <el-button link type="primary" @click="openCover({ id: row.coverId } as Cover)">
                {{ row.coverNo || `#${row.coverId}` }}
              </el-button>
            </template>
          </el-table-column>
          <el-table-column label="先保存（当前生效）" min-width="180">
            <template #default="{ row }">
              <el-tag size="small" type="success" effect="plain">
                挂到 {{ routeLabelOf(row.winner.routeId) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="后保存（待裁定）" min-width="180">
            <template #default="{ row }">
              <el-tag size="small" type="danger" effect="plain">
                主张挂到 {{ routeLabelOf(row.pending.routeId) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="裁决" width="250">
            <template #default="{ row }">
              <el-button
                size="small"
                type="success"
                :disabled="row.pending.routeId !== routeId"
                @click="resolveConflict(row.id, 'pending')"
              >
                改挂后保存
              </el-button>
              <el-button size="small" @click="resolveConflict(row.id, 'winner')">
                维持先保存
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section class="gb-panel">
        <h2 class="gb-panel__title">把实寄封挂到邮路节点</h2>
        <div class="route-editor__attach">
          <el-select
            v-model="selectedCoverId"
            placeholder="选择实寄封"
            filterable
            style="width: 320px"
          >
            <el-option
              v-for="opt in coverOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
              :disabled="pendingCoverIds().has(opt.value)"
            />
          </el-select>
          <el-button type="primary" @click="attachCover">挂到此邮路</el-button>
        </div>
        <p v-if="!attachedCovers.length" class="gb-empty">该邮路尚未挂任何实寄封。</p>
        <ul v-else class="route-editor__covers">
          <li v-for="item in attachedCovers" :key="item.id">
            <strong>{{ item.coverNo }}</strong>
            <span>{{ item.sentFrom }} → {{ item.sentTo }}</span>
            <el-tag v-if="isCoverStale(item)" size="small" type="warning" effect="plain">
              时间轴失效
            </el-tag>
            <el-button
              v-if="isCoverStale(item) && !conflictStore.openConflictOfCover(item.id ?? -1)"
              size="small"
              link
              type="warning"
              @click="revalidateCover(item)"
            >
              核对补基线
            </el-button>
            <el-button size="small" link type="primary" @click="openCover(item)">详情</el-button>
            <el-button size="small" link type="danger" @click="detachCover(item)">摘除</el-button>
          </li>
        </ul>
        <p v-if="unattachedCovers.length" class="route-editor__hint">
          另有 {{ unattachedCovers.length }} 封未挂邮路，可在上方下拉中检索。
        </p>
      </section>

      <section class="gb-panel">
        <h2 class="gb-panel__title">按实寄封预览寄递时间轴</h2>
        <p v-if="previewCover" class="route-editor__hint">
          预览：{{ previewCover.coverNo }} · 在途
          {{ transitDays == null ? '待考' : `${transitDays} 天` }}
        </p>
        <RouteTimeline
          :nodes="previewCover ? previewTimeline : fallbackTimeline"
          title="寄递事实时间轴"
        />
      </section>
    </template>

    <section v-else class="gb-panel">
      <h2 class="gb-panel__title">未找到该邮路，可直接新建一条</h2>
      <el-form label-width="96px" style="max-width: 560px">
        <el-form-item label="邮路号">
          <el-input v-model="createForm.routeNo" placeholder="留空自动生成" />
        </el-form-item>
        <el-form-item label="邮路名称">
          <el-input v-model="createForm.name" placeholder="如 沪宁铁路邮路" />
        </el-form-item>
        <el-form-item label="时期">
          <el-input v-model="createForm.era" placeholder="如 1910-1919" />
        </el-form-item>
        <el-form-item label="运输">
          <el-select v-model="createForm.transport" style="width: 100%">
            <el-option v-for="t in TRANSPORT_MODES" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="班期">
          <el-input v-model="createForm.frequency" placeholder="如 逐日班" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="creating" @click="createRoute">新建邮路</el-button>
        </el-form-item>
      </el-form>
    </section>

    <el-dialog v-model="nodeDialog" title="新增邮路节点" width="520px">
      <el-form label-width="96px">
        <el-form-item label="局所">
          <el-input v-model="nodeForm.office" placeholder="如 苏州" />
        </el-form-item>
        <el-form-item label="到达日期">
          <el-date-picker
            v-model="nodeForm.arriveDate"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="中转戳">
          <el-input v-model="nodeForm.transitMark" placeholder="如 苏州中转日戳" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="nodeDialog = false">取消</el-button>
        <el-button type="primary" @click="submitNode">保存节点</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.route-editor__no {
  color: #5d3325;
  font-size: 18px;
  margin-left: 8px;
}
.route-editor__badge {
  margin-left: 8px;
}
.route-editor__recover {
  margin: 0 0 10px;
  font-size: 13px;
  color: #b02a1e;
  background: #fdecea;
  border: 1px solid #f0b8b2;
  border-radius: 8px;
  padding: 6px 10px;
}
.route-editor__conflicts {
  border-color: #e0b4ab;
}
.route-editor__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.route-editor__summary {
  font-size: 13px;
  color: var(--gb-muted);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.route-editor__warn {
  margin: 0 0 10px;
  font-size: 13px;
  color: #b06f16;
  background: #fdf5e6;
  border: 1px solid #ecd3a5;
  border-radius: 8px;
  padding: 6px 10px;
}
.route-editor__table {
  margin-top: 12px;
}
.route-editor__attach {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.route-editor__covers {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.route-editor__covers li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--gb-muted);
  border-bottom: 1px dashed var(--gb-line);
  padding-bottom: 5px;
}
.route-editor__covers strong {
  color: #5d3325;
  min-width: 80px;
}
.route-editor__hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--gb-muted);
}
</style>
