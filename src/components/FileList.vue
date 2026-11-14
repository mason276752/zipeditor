<script setup lang="ts">
import { computed, type Directive } from 'vue'
import type { Row } from '../archive'
import { kindOf } from '../kinds'
import { fmtBytes, fmtDate } from '../util'
import Icon, { type IconName } from './Icon.vue'

const props = defineProps<{
  rows: Row[]
  cwd: string
  rootName: string
  selected: Set<string>
  active: string | null
  renaming: string | null
}>()

const emit = defineEmits<{
  navigate: [path: string]
  open: [row: Row]
  toggle: [path: string]
  toggleAll: [on: boolean]
  startRename: [path: string]
  rename: [row: Row, name: string]
  cancelRename: []
  remove: [row: Row]
  download: [row: Row]
}>()

const crumbs = computed(() => {
  const out = [{ name: props.rootName, path: '' }]
  let acc = ''
  for (const part of props.cwd ? props.cwd.split('/') : []) {
    acc = acc ? `${acc}/${part}` : part
    out.push({ name: part, path: acc })
  }
  return out
})

const allSelected = computed(() => props.rows.length > 0 && props.rows.every((r) => props.selected.has(r.path)))

function icon(row: Row): IconName {
  if (row.dir) return 'folder'
  const kind = kindOf(row.name)
  if (kind === 'image') return 'image'
  if (kind === 'text') return 'text'
  if (kind === 'video' || kind === 'audio') return 'media'
  return kind === 'other' && /\.zip$/i.test(row.name) ? 'zip' : 'file'
}

// Enter and the blur that follows both end a rename; only the first one counts.
let settled = false

// Focuses the rename field with the name (minus extension) selected, like a file manager.
const vFocusName: Directive<HTMLInputElement, boolean> = {
  mounted(el, { value: isDir }) {
    settled = false
    el.focus()
    const dot = el.value.lastIndexOf('.')
    el.setSelectionRange(0, !isDir && dot > 0 ? dot : el.value.length)
  },
}

function commitRename(row: Row, e: Event) {
  if (settled) return
  settled = true
  emit('rename', row, (e.target as HTMLInputElement).value)
}
function cancelRename() {
  settled = true
  emit('cancelRename')
}
</script>

<template>
  <div class="list">
    <nav class="crumbs" aria-label="資料夾路徑">
      <template v-for="(c, i) in crumbs" :key="c.path">
        <Icon v-if="i > 0" name="chevron" class="sep" />
        <button type="button" class="crumb" :class="{ here: c.path === cwd }" @click="emit('navigate', c.path)">
          <Icon v-if="i === 0" name="zip" />{{ c.name }}
        </button>
      </template>
    </nav>

    <div class="head" v-if="rows.length">
      <label class="check" title="全選">
        <input type="checkbox" :checked="allSelected" @change="emit('toggleAll', !allSelected)" />
      </label>
      <span>名稱</span>
      <span class="size">大小</span>
      <span class="date">修改時間</span>
      <span></span>
    </div>

    <ul v-if="rows.length">
      <li v-for="row in rows" :key="row.path" class="row"
          :class="{ active: row.path === active, picked: selected.has(row.path) }">
        <label class="check">
          <input type="checkbox" :checked="selected.has(row.path)" @change="emit('toggle', row.path)"
                 :aria-label="`選取 ${row.name}`" />
        </label>

        <div v-if="renaming === row.path" class="name">
          <Icon :name="icon(row)" :class="{ folder: row.dir }" />
          <input class="rename" :value="row.name" v-focus-name="row.dir" spellcheck="false"
                 @keydown.enter.prevent="commitRename(row, $event)" @keydown.esc.prevent="cancelRename"
                 @blur="commitRename(row, $event)" />
        </div>
        <button v-else type="button" class="name" @click="row.dir ? emit('navigate', row.path) : emit('open', row)"
                @dblclick.prevent="emit('startRename', row.path)" :title="row.path">
          <Icon :name="icon(row)" :class="{ folder: row.dir }" />
          <span class="label">{{ row.name }}</span>
          <span v-if="row.dir" class="count">{{ row.count }} 個檔案</span>
        </button>

        <span class="size">{{ fmtBytes(row.size) }}</span>
        <span class="date">{{ row.date ? fmtDate(row.date) : '' }}</span>
        <span class="acts">
          <button v-if="!row.dir" type="button" class="ib" title="下載這個檔案" @click="emit('download', row)">
            <Icon name="download" />
          </button>
          <button type="button" class="ib" title="重新命名" @click="emit('startRename', row.path)"><Icon name="pencil" /></button>
          <button type="button" class="ib danger" title="刪除" @click="emit('remove', row)"><Icon name="trash" /></button>
        </span>
      </li>
    </ul>

    <p v-else class="empty">這個資料夾是空的。把檔案拖進來，或用上方的按鈕新增。</p>
  </div>
</template>

<style scoped>
.list { overflow: hidden; }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.crumb {
  display: inline-flex; align-items: center; gap: 6px; max-width: 16em; padding: 3px 8px;
  border: 0; border-radius: 7px; background: none; color: var(--muted); font: inherit; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
}
.crumb:hover { background: var(--hover); color: var(--text); }
.crumb.here { color: var(--text); }
.crumb .icon { width: 16px; height: 16px; color: var(--accent); }
.sep { width: 14px; height: 14px; color: var(--muted); }

.head, .row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 84px 132px 108px;
  align-items: center;
}
.head { padding: 6px 8px 6px 4px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; font-weight: 600; }
ul { margin: 0; padding: 0; list-style: none; }
.row { min-height: 44px; padding: 0 8px 0 4px; border-bottom: 1px solid var(--line); }
.row:last-child { border-bottom: 0; }
.row:hover { background: var(--hover); }
.row.picked { background: var(--accent-soft); }
.row.active { box-shadow: inset 3px 0 0 var(--accent); background: var(--accent-soft); }
.check { display: grid; place-items: center; height: 44px; cursor: pointer; }
.check input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); cursor: pointer; }

.name {
  display: flex; align-items: center; gap: 10px; min-width: 0; height: 44px; padding: 0 6px;
  border: 0; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer;
}
.name .icon { width: 20px; height: 20px; flex: none; color: var(--muted); }
.name .icon.folder { color: var(--folder); }
.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { flex: none; color: var(--muted); font-size: 12px; }
.rename {
  flex: 1; min-width: 0; padding: 4px 8px; border: 1px solid var(--accent); border-radius: 6px;
  background: var(--panel); color: var(--text); font: inherit; font-size: 16px; outline: none;
}
.size, .date { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.size { text-align: right; padding-right: 14px; }
.acts { display: flex; justify-content: flex-end; gap: 2px; opacity: 0; transition: opacity .12s; }
.row:hover .acts, .row:focus-within .acts, .row.active .acts { opacity: 1; }
@media (hover: none) { .acts { opacity: 1; } }
.ib {
  display: grid; place-items: center; width: 32px; height: 32px; padding: 0;
  border: 0; border-radius: 8px; background: none; color: var(--muted); cursor: pointer;
}
.ib:hover { background: var(--panel); color: var(--text); }
.ib.danger:hover { color: var(--danger); }
.ib .icon { width: 17px; height: 17px; }

.empty { margin: 0; padding: 40px 16px; color: var(--muted); text-align: center; }

@media (max-width: 720px) {
  .head, .row { grid-template-columns: 32px minmax(0, 1fr) 70px 72px; }
  .date { display: none; }
  .size { padding-right: 4px; font-size: 12px; }
  .acts .ib:first-child { display: none; }
  .count { display: none; }
}
</style>
