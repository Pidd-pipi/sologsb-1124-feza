/**
 * db-smoke 测试引导：在任何应用模块（含 Dexie 静态导入）求值之前，
 * 把 fake-indexeddb 注入全局 IndexedDB。经 `tsx --import` 预加载。
 */
import fakeIndexedDB, { IDBKeyRange } from 'fake-indexeddb'

;(globalThis as unknown as Record<string, unknown>).indexedDB = fakeIndexedDB
;(globalThis as unknown as Record<string, unknown>).IDBKeyRange = IDBKeyRange
