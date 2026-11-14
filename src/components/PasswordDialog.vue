<script setup lang="ts">
import { nextTick, ref } from 'vue'
import type { Encryption, Protection } from '../archive'

const dialog = ref<HTMLDialogElement>()
const field = ref<HTMLInputElement>()
const opts = ref<AskOptions>({ mode: 'open', title: '' })
const password = ref('')
const encryption = ref<Encryption>('aes')
const reveal = ref(false)
const error = ref('')
const checking = ref(false)
let settle: ((a: Answer) => void) | null = null

// Shows the dialog and resolves with the answer; null when cancelled.
function ask(o: AskOptions): Promise<Answer> {
  opts.value = o
  password.value = o.mode === 'set' ? o.current?.password ?? '' : ''
  encryption.value = o.current?.encryption ?? 'aes'
  reveal.value = false
  error.value = ''
  dialog.value!.showModal()
  nextTick(() => field.value?.select())
  return new Promise((resolve) => { settle = resolve })
}

function close(a: Answer) {
  dialog.value!.close()
  settle?.(a)
  settle = null
}

async function submit() {
  if (!password.value || checking.value) return
  if (opts.value.mode === 'set') {
    close({ password: password.value, encryption: encryption.value })
    return
  }
  checking.value = true
  error.value = ''
  try {
    error.value = (await opts.value.check?.(password.value)) ?? ''
  } finally {
    checking.value = false
  }
  if (error.value) nextTick(() => field.value?.select())
  else close({ password: password.value, encryption: encryption.value })
}

defineExpose({ ask })
</script>

<script lang="ts">
// One dialog for both: asking for the password of a zip being opened, and setting the password
// a zip is saved with.
export interface AskOptions {
  mode: 'open' | 'set'
  title: string
  current?: Protection | null // 'set': the password the zip has now, if any
  // 'open': tries the password; returns an error to show (the dialog stays open), or '' when it worked.
  check?: (password: string) => Promise<string>
}
export type Answer = Protection | 'remove' | null
</script>

<template>
  <dialog ref="dialog" class="pw panel" @cancel.prevent="close(null)">
    <form @submit.prevent="submit">
      <h2>{{ opts.title }}</h2>
      <label class="field">
        <span>密碼</span>
        <span class="pwbox">
          <input ref="field" v-model="password" :type="reveal ? 'text' : 'password'"
                 autocomplete="off" spellcheck="false" />
          <button type="button" class="btn small" @click="reveal = !reveal">{{ reveal ? '隱藏' : '顯示' }}</button>
        </span>
      </label>

      <fieldset v-if="opts.mode === 'set'" class="field">
        <legend>加密方式</legend>
        <label class="choice">
          <input v-model="encryption" type="radio" value="aes" />
          <span><b>AES-256</b>：安全。Windows、macOS 內建的解壓縮打不開，要用 7-Zip、WinRAR、Keka 等</span>
        </label>
        <label class="choice">
          <input v-model="encryption" type="radio" value="zipcrypto" />
          <span><b>傳統 ZipCrypto</b>：系統內建就能解，但很容易被破解，只防得了一般人</span>
        </label>
        <p class="hint">下載 ZIP（以及存回外層）時會用這組密碼加密。</p>
      </fieldset>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <div class="btns">
        <button v-if="opts.mode === 'set' && opts.current" type="button" class="btn danger" @click="close('remove')">
          移除密碼
        </button>
        <span class="grow"></span>
        <button type="button" class="btn" @click="close(null)">取消</button>
        <button type="submit" class="btn primary" :disabled="!password || checking">
          {{ checking ? '檢查中…' : opts.mode === 'open' ? '開啟' : '套用' }}
        </button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.pw { width: min(440px, calc(100vw - 32px)); padding: 20px; color: var(--text); }
.pw::backdrop { background: rgb(0 0 0 / .45); }
h2 { margin: 0 0 14px; font-size: 17px; word-break: break-all; }
.field { display: grid; gap: 6px; margin: 0 0 14px; padding: 0; border: 0; font-size: 14px; }
.field > span:first-child, legend { padding: 0; color: var(--muted); font-size: 13px; font-weight: 600; }
.pwbox { display: flex; gap: 6px; }
.pwbox input {
  flex: 1; min-width: 0; min-height: 38px; padding: 4px 10px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--text);
  font: inherit; font-size: 16px;
}
.pwbox input:focus { border-color: var(--accent); outline: none; }
.choice { display: flex; align-items: flex-start; gap: 8px; line-height: 1.5; cursor: pointer; }
.choice input { margin-top: 4px; accent-color: var(--accent); }
.hint { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
.error { margin: -4px 0 14px; color: var(--danger); font-size: 14px; }
.btns { display: flex; align-items: center; gap: 8px; }
.grow { flex: 1; }
</style>
