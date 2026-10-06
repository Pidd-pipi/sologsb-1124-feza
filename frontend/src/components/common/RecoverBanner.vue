<script setup lang="ts">
/**
 * 写入失败后留下的可恢复草稿提示条：
 * 展示最近一份失败提交，支持「载入重试 / 丢弃」。
 * 普通表单草稿（编辑中自动暂存）与失败恢复草稿分开存放，互不覆盖。
 */
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  listRecoverDrafts,
  removeRecoverDraft,
  type RecoverDraft,
  type RecoverScope
} from '@/utils/recover'

const props = defineProps<{
  scope: RecoverScope
  /** 只展示 attempted 中 id / coverId 等于该值的草稿（如某一封的票戳组合）。 */
  filterId?: number
}>()
const emit = defineEmits<{ (e: 'restore', value: unknown): void }>()

const draft = ref<RecoverDraft | null>(null)

function scopeLabel(scope: RecoverScope): string {
  switch (scope) {
    case 'route':
      return '邮路'
    case 'cover':
      return '实寄封'
    case 'stampentry':
      return '票戳组合'
    case 'route-link':
      return '邮路挂接'
  }
}

function matchesFilter(d: RecoverDraft): boolean {
  if (props.filterId == null) return true
  const a = d.attempted as { id?: number; coverId?: number } | null
  return a?.id === props.filterId || a?.coverId === props.filterId
}

function refresh(): void {
  draft.value = listRecoverDrafts(props.scope).find(matchesFilter) ?? null
}

function restore(): void {
  const current = draft.value
  if (!current) return
  emit('restore', current.attempted)
  removeRecoverDraft(current.scope, current.failedAt)
  ElMessage.success('已载入上次失败的内容，可修改后重试')
  refresh()
}

function discard(): void {
  const current = draft.value
  if (current) removeRecoverDraft(current.scope, current.failedAt)
  ElMessage.info('已丢弃这份可恢复草稿')
  refresh()
}

onMounted(refresh)

defineExpose({ refresh })
</script>

<template>
  <el-alert
    v-if="draft"
    class="recover-banner"
    type="warning"
    :closable="false"
    show-icon
  >
    <template #title>
      <div class="recover-banner__row">
        <span>
          {{ scopeLabel(draft.scope) }}写入失败已回滚，已留存可恢复草稿（{{ draft.failedAt.slice(0, 19).replace('T', ' ') }}）
        </span>
        <span class="recover-banner__actions">
          <el-button size="small" type="primary" @click="restore">载入重试</el-button>
          <el-button size="small" @click="discard">丢弃</el-button>
        </span>
      </div>
      <div class="recover-banner__reason">失败原因：{{ draft.reason }}</div>
    </template>
  </el-alert>
</template>

<style scoped>
.recover-banner {
  margin: 0 0 12px;
}
.recover-banner__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.recover-banner__actions {
  display: inline-flex;
  gap: 6px;
}
.recover-banner__reason {
  font-size: 12px;
  opacity: 0.75;
  margin-top: 2px;
}
</style>
