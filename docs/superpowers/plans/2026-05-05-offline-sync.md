# オフライン同期対応 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `trap-notes.html` を IndexedDB-first のオフライン同期対応に改修し、Supabase を全ユーザー共有バックエンドとして利用しながらオフライン操作・自動同期・同期状態表示を実現する。

**Architecture:** `trap-notes.html` の Babel ブロック前に 4 つの平 JS ブロック（SECTION 2〜5）を追加し、Babel の UI 層は `window._app.db / api / sync` 経由でデータ操作する。Supabase JS v2（CDN 既存）に加え Dexie.js v3（CDN 追加）を使う。操作は IndexedDB へ先書きして楽観的更新し、バックグラウンドで Supabase へ同期する。

**Tech Stack:** Supabase JS v2 (CDN 既存・line 11), Dexie.js v3 (CDN 追加), React 18 (CDN 既存), Babel standalone (CDN 既存), Leaflet 1.9.4 (CDN 既存)

---

## 変更ファイル一覧

| ファイル | 変更種別 | 内容 |
|---|---|---|
| `trap-notes.html` | Modify | Dexie CDN 追加・SECTION 2〜5 新設・Babel ブロック改修 |
| Supabase SQL Editor | Migration | カラム追加・RLS ポリシー変更（コード変更なし） |

**trap-notes.html の変更概要:**
- 現在: 1268 行、単一 Babel ブロック、Supabase 直接アクセス
- 変更後: 約 1600 行、SECTION 1〜6 構成、IndexedDB-first + sync queue

**注意:** 変更前に必ず `git status` で作業ブランチを確認すること。

---

## Task 1: Supabase スキーマ移行（SQL）

**対象:** Supabase ダッシュボード → SQL Editor
URL: `https://supabase.com/dashboard/project/ykojblrieeirgbxxurwh/sql`

**前提:** `created_by`, `updated_by` の追加と共有 RLS への変更はすでに実施済み。
今回は `deleted_at`, `deleted_by` の追加と RLS 設定の確認のみ行う。

---

- [ ] **Step 1: 論理削除用カラムを追加する**

```sql
-- 論理削除用カラムを追加（IF NOT EXISTS なので再実行しても安全）
ALTER TABLE traps ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE traps ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES auth.users(id);
```

Expected: 2 件 Success

- [ ] **Step 2: 現在の RLS ポリシーを確認する**

```sql
SELECT policyname, cmd, qual
FROM pg_policies
WHERE tablename = 'traps';
```

確認内容:
- `"own traps"` ポリシーが **存在しない** こと（`auth.uid() = user_id` の個人管理ポリシー）
- 共有アクセス用ポリシーが SELECT / INSERT / UPDATE に存在すること

- [ ] **Step 3: RLS に不足があれば補完する（Step 2 で確認後に必要なものだけ実行）**

個人管理ポリシーが残っている場合:
```sql
DROP POLICY IF EXISTS "own traps" ON traps;
```

共有ポリシーが不足している場合（存在するものは省略してよい）:
```sql
CREATE POLICY "shared traps select" ON traps FOR SELECT
  USING (auth.email() IN (SELECT email FROM allowed_emails));

CREATE POLICY "shared traps insert" ON traps FOR INSERT
  WITH CHECK (auth.email() IN (SELECT email FROM allowed_emails));

CREATE POLICY "shared traps update" ON traps FOR UPDATE
  USING (auth.email() IN (SELECT email FROM allowed_emails))
  WITH CHECK (auth.email() IN (SELECT email FROM allowed_emails));
-- DELETE ポリシーは不要（論理削除のため物理削除は管理者のみ）
```

- [ ] **Step 4: 動作確認**

Supabase Table Editor で `traps` テーブルを開き、以下を確認:
- `deleted_at`（timestamptz, nullable）が存在すること
- `deleted_by`（uuid, nullable）が存在すること
- `created_by`, `updated_by` が既に存在すること

- [ ] **Step 5: コミット**

```bash
git add docs/superpowers/plans/2026-05-05-offline-sync.md
git commit -m "docs: 実装計画を追加（Task 1 SQL は Supabase で実施済み）"
```

---

## Task 2: Dexie CDN 追加 + SECTION 2（定数・ユーティリティ）新設

**Files:**
- Modify: `trap-notes.html`

---

- [ ] **Step 1: Dexie の CDN タグを追加する**

`trap-notes.html` の line 11（Supabase CDN タグ）の直後に挿入:

```html
<script src="https://unpkg.com/dexie@3/dist/dexie.js"></script>
```

変更後の CDN ブロック（line 11〜15）:
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script src="https://unpkg.com/dexie@3/dist/dexie.js"></script>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
```

- [ ] **Step 2: SECTION 2 ブロックを `<div id="root"></div>` の直後・Babel ブロックの直前に挿入する**

```html
<!-- ================================================================
  SECTION 2: Constants & Utilities (plain JS)
================================================================ -->
<script>
/* ---- Supabase 接続情報 ---- */
const SUPABASE_URL      = 'https://ykojblrieeirgbxxurwh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_40xB7vnxMkqTSywczaIA7g_Xol4pHbs';

/* ---- 罠種類・ステータス定数 ---- */
const TRAP_TYPES = {
  kukuri: {emoji:'🪤', label:'くくり罠', color:'#1B5E3B'},
  hako:   {emoji:'📦', label:'はこ罠',   color:'#7B4E28'},
  other:  {emoji:'❓', label:'その他',   color:'#6B7280'},
};
const TRAP_STATUS = {
  '稼働中':   {bg:'#D1FAE5', text:'#065F46', border:'#6EE7B7'},
  '要確認':   {bg:'#FEF3C7', text:'#92400E', border:'#FCD34D'},
  '撤去済み': {bg:'#F1F5F9', text:'#475569', border:'#CBD5E1'},
};
const STATUS_ICON = {'稼働中':'🟢','要確認':'🟡','撤去済み':'⚫'};
const ANIMALS = [
  {id:'shika',    emoji:'🦌', label:'シカ'},
  {id:'tanuki',   emoji:'🦝', label:'タヌキ'},
  {id:'araiguma', emoji:'🦝', label:'アライグマ'},
  {id:'anaguma',  emoji:'🦡', label:'アナグマ'},
  {id:'other',    emoji:'🐾', label:'その他'},
];
const AMAP = Object.fromEntries(ANIMALS.map(a => [a.id, a]));

/* ---- ユーティリティ ---- */
function nextTrapId(traps) {
  const nums = traps.map(t => { const m = t.trapId.match(/^A-(\d+)$/); return m ? +m[1] : 0; });
  return 'A-' + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0');
}
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s + 'T00:00:00');
  return d.getFullYear() + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getDate()).padStart(2,'0');
}
function fmtDT(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString('ja-JP', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'});
}

/* ---- Supabase ↔ ローカルモデル変換 ---- */
function toLocalRecord(server, existing) {
  return {
    id:               server.id,
    trapId:           server.trap_id,
    type:             server.type,
    status:           server.status,
    installedAt:      server.installed_at  || '',
    lat:              server.lat           || '',
    lng:              server.lng           || '',
    notes:            server.notes         || '',
    sightings:        server.sightings     || [],
    createdAt:        server.created_at,
    updatedAt:        server.updated_at,
    createdBy:        server.created_by    || null,
    updatedBy:        server.updated_by    || null,
    deletedAt:        server.deleted_at    || null,
    deletedBy:        server.deleted_by    || null,
    syncStatus:       (existing && existing.syncStatus === 'pending') ? 'pending' : 'synced',
    pendingOperation: (existing && existing.syncStatus === 'pending') ? existing.pendingOperation : null,
    lastSyncAt:       new Date().toISOString(),
  };
}
function toServerRecord(local) {
  return {
    id:           local.id,
    trap_id:      local.trapId,
    type:         local.type,
    status:       local.status,
    installed_at: local.installedAt || null,
    lat:          local.lat         || null,
    lng:          local.lng         || null,
    notes:        local.notes       || '',
    sightings:    local.sightings,
    created_at:   local.createdAt,
    updated_at:   local.updatedAt,
    created_by:   local.createdBy,
    updated_by:   local.updatedBy,
    deleted_at:   local.deletedAt,
    deleted_by:   local.deletedBy,
  };
}
</script>
```

- [ ] **Step 3: Babel ブロックから移動済みの定数・関数を削除する**

Babel ブロック（`<script type="text/babel">` の中）から以下を削除する:
- line 109: `const SUPABASE_URL = ...`
- line 110: `const SUPABASE_ANON_KEY = ...`
- line 111: `const sbClient = window.supabase.createClient(...)`  ← **この行は残す（Task 4 で置き換え）**
- line 145: `const TRAP_TYPES = {...}`
- line 151: `const TRAP_STATUS = {...}`
- line 157: `const STATUS_ICON = {...}`
- line 159: `const ANIMALS = [...]`
- line 166: `const AMAP = ...`
- line 168〜181: `const dbToTrap = ...` 関数全体（`toLocalRecord` で代替）
- line 183〜186: `const nextTrapId = ...` 関数全体
- line 188〜192: `const fmtDate = ...` 関数全体
- line 194〜197: `const fmtDT = ...` 関数全体

**注意:** `sbClient` は Task 4 で TrapApi に移管するまで Babel ブロックに残す。
`dbToTrap` を使っていた箇所（line 792）は `toLocalRecord` に変更する:
```js
// 変更前:
if (!error && data) setTraps(data.map(dbToTrap));
// 変更後:
if (!error && data) setTraps(data.map(r => toLocalRecord(r)));
```

- [ ] **Step 4: ブラウザで動作確認**

```bash
npx serve .
# http://localhost:3000/trap-notes.html を開く
```

DevTools Console でエラーが出ないこと。以下を実行:
```js
TRAP_TYPES       // → {kukuri: {...}, hako: {...}, other: {...}}
fmtDate('2025-01-15')  // → "2025/01/15"
toLocalRecord({id:'test', trap_id:'A-001', type:'kukuri', status:'稼働中', installed_at:null, lat:null, lng:null, notes:'', sightings:[], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), created_by:null, updated_by:null, deleted_at:null, deleted_by:null})
// → {id:'test', trapId:'A-001', syncStatus:'synced', ...}
```

- [ ] **Step 5: コミット**

```bash
git add trap-notes.html
git commit -m "refactor: 定数・ユーティリティを SECTION 2 に分離し Dexie CDN を追加"
```

---

## Task 3: SECTION 3 - TrapDB（IndexedDB / Dexie）

**Files:**
- Modify: `trap-notes.html` (SECTION 2 の直後に挿入)

---

- [ ] **Step 1: SECTION 3 ブロックを SECTION 2 の `</script>` 直後に挿入する**

```html
<!-- ================================================================
  SECTION 3: TrapDB — IndexedDB layer (Dexie)
================================================================ -->
<script>
const TrapDB = (() => {
  const db = new Dexie('yokoze-trap-notes');
  db.version(1).stores({
    traps: 'id, trapId, status, syncStatus, deletedAt, updatedAt'
  });

  async function getAll() {
    const all = await db.traps.toArray();
    return all.filter(t => !t.deletedAt && t.pendingOperation !== 'delete');
  }

  async function getById(id) {
    return db.traps.get(id);
  }

  async function save(trap) {
    const now = new Date().toISOString();
    const existing = await db.traps.get(trap.id);
    if (existing) {
      const pendingOp = existing.pendingOperation === 'insert' ? 'insert' : 'update';
      await db.traps.put({ ...existing, ...trap, updatedAt: now, syncStatus: 'pending', pendingOperation: pendingOp });
    } else {
      await db.traps.put({ ...trap, createdAt: trap.createdAt || now, updatedAt: now, syncStatus: 'pending', pendingOperation: 'insert' });
    }
  }

  async function markDeleted(id, userId) {
    const now = new Date().toISOString();
    const t = await db.traps.get(id);
    if (!t) return;
    await db.traps.put({ ...t, deletedAt: now, deletedBy: userId, updatedAt: now, syncStatus: 'pending', pendingOperation: 'delete' });
  }

  async function markSynced(id) {
    const t = await db.traps.get(id);
    if (!t) return;
    await db.traps.put({ ...t, syncStatus: 'synced', pendingOperation: null, lastSyncAt: new Date().toISOString() });
  }

  async function markFailed(id) {
    const t = await db.traps.get(id);
    if (!t) return;
    await db.traps.put({ ...t, syncStatus: 'failed' });
  }

  async function getPending() {
    return db.traps.where('syncStatus').equals('pending').toArray();
  }

  async function getSyncStats() {
    const all = await db.traps.toArray();
    return {
      pending: all.filter(t => t.syncStatus === 'pending').length,
      failed:  all.filter(t => t.syncStatus === 'failed').length,
    };
  }

  async function seedFromServer(serverRecords) {
    for (const rec of serverRecords) {
      const existing = await db.traps.get(rec.id);
      // pending レコードはサーバーで上書きしない（オフライン編集を保護）
      if (existing && existing.syncStatus === 'pending') continue;
      await db.traps.put(toLocalRecord(rec, existing));
    }
  }

  async function retryFailed() {
    const failed = await db.traps.where('syncStatus').equals('failed').toArray();
    for (const t of failed) {
      await db.traps.put({ ...t, syncStatus: 'pending' });
    }
  }

  async function migrateFromLocalStorage() {
    if (localStorage.getItem('yokose-migration-done')) return;
    const count = await db.traps.count();
    if (count > 0) { localStorage.setItem('yokose-migration-done', '1'); return; }
    const raw = localStorage.getItem('yokose-v4');
    if (!raw) { localStorage.setItem('yokose-migration-done', '1'); return; }
    try {
      const old = JSON.parse(raw);
      const now = new Date().toISOString();
      for (const t of old) {
        await db.traps.put({
          id: t.id || crypto.randomUUID(), trapId: t.trapId || 'A-000',
          type: t.type || 'kukuri', status: t.status || '稼働中',
          installedAt: t.installedAt || '', lat: t.lat || '', lng: t.lng || '',
          notes: t.notes || '', sightings: t.sightings || [],
          createdAt: t.createdAt || now, updatedAt: t.updatedAt || now,
          createdBy: null, updatedBy: null, deletedAt: null, deletedBy: null,
          syncStatus: 'pending', pendingOperation: 'insert', lastSyncAt: null,
        });
      }
    } catch (e) { console.warn('[TrapDB] Migration failed:', e); }
    localStorage.setItem('yokose-migration-done', '1');
  }

  return { getAll, getById, save, markDeleted, markSynced, markFailed, getPending, getSyncStats, seedFromServer, retryFailed, migrateFromLocalStorage };
})();
</script>
```

- [ ] **Step 2: ブラウザで TrapDB の動作確認**

```js
// Console で以下を順番に実行
const id = crypto.randomUUID();
await TrapDB.save({id, trapId:'A-TEST', type:'kukuri', status:'稼働中', installedAt:'', lat:'', lng:'', notes:'テスト', sightings:[], createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), createdBy:null, updatedBy:null, deletedAt:null, deletedBy:null})
await TrapDB.getAll()           // → [{trapId:'A-TEST', syncStatus:'pending', pendingOperation:'insert', ...}]
await TrapDB.getPending()       // → 同じレコードが返ること
await TrapDB.getSyncStats()     // → {pending:1, failed:0}
await TrapDB.markSynced(id)
await TrapDB.getSyncStats()     // → {pending:0, failed:0}
await TrapDB.markDeleted(id, null)
await TrapDB.getAll()           // → [] (deletedAt が設定されたので除外)
```

- [ ] **Step 3: コミット**

```bash
git add trap-notes.html
git commit -m "feat: SECTION 3 TrapDB (IndexedDB/Dexie) を追加"
```

---

## Task 4: SECTION 4 - TrapApi（Supabase ラッパー）+ sbClient 移管

**Files:**
- Modify: `trap-notes.html` (SECTION 3 の直後に挿入 + Babel ブロック改修)

---

- [ ] **Step 1: SECTION 4 ブロックを SECTION 3 の `</script>` 直後に挿入する**

```html
<!-- ================================================================
  SECTION 4: TrapApi — Supabase layer
================================================================ -->
<script>
const TrapApi = (() => {
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  async function getSession() {
    const { data } = await client.auth.getSession();
    return data.session;
  }

  async function getCurrentUser() {
    const sess = await getSession();
    if (!sess) return null;
    return { id: sess.user.id, email: sess.user.email };
  }

  async function signInWithGoogle() {
    const url = window.location.href.split('?')[0].split('#')[0];
    await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: url } });
  }

  async function signOut() {
    await client.auth.signOut();
  }

  function onAuthStateChange(callback) {
    const { data: { subscription } } = client.auth.onAuthStateChange(callback);
    return subscription;
  }

  async function checkAllowedEmail(email) {
    const { data } = await client.from('allowed_emails').select('email').eq('email', email).maybeSingle();
    return !!data;
  }

  async function fetchAll() {
    const { data, error } = await client.from('traps')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function upsertTrap(local) {
    const { error } = await client.from('traps').upsert(toServerRecord(local), { onConflict: 'id' });
    if (error) throw error;
  }

  async function softDeleteTrap(id, deletedAt, deletedBy) {
    const { error } = await client.from('traps')
      .update({ deleted_at: deletedAt, deleted_by: deletedBy, updated_at: deletedAt })
      .eq('id', id);
    if (error) throw error;
  }

  return { getSession, getCurrentUser, signInWithGoogle, signOut, onAuthStateChange, checkAllowedEmail, fetchAll, upsertTrap, softDeleteTrap };
})();
</script>
```

- [ ] **Step 2: Babel ブロックの sbClient 行を削除し、Root コンポーネントの認証を TrapApi 経由に変更する**

Babel ブロックの先頭にある以下の1行を削除:
```js
const sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
```
（SUPABASE_URL / SUPABASE_ANON_KEY は既に Step 3 で SECTION 2 に移動済み）

- [ ] **Step 3: Root コンポーネント（`function Root()`）の認証コードを書き換える**

変更前（line 1222〜1257 相当、Task 2 Step 3 後の行番号は変動する）:
```js
useEffect(() => {
  const checkAllowed = async (sess) => {
    if (!sess) { setAuthLoading(false); setAuthSession(null); return; }
    const {data} = await sbClient.from('allowed_emails').select('email').eq('email', sess.user.email).maybeSingle();
    if (!data) {
      await sbClient.auth.signOut();
      setAuthError('このアカウントはアクセスが許可されていません。管理者に連絡してください。');
      setAuthLoading(false); setAuthSession(null);
    } else { setAuthError(''); setAuthSession(sess); setAuthLoading(false); }
  };
  const {data:{subscription}} = sbClient.auth.onAuthStateChange((event, sess) => {
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') { checkAllowed(sess); }
    else if (event === 'SIGNED_OUT') { setAuthSession(null); setAuthLoading(false); }
    else if (event === 'TOKEN_REFRESHED' && sess) { setAuthSession(sess); }
  });
  return () => subscription.unsubscribe();
}, []);
const handleLogin = useCallback(async () => {
  const url = window.location.href.split('?')[0].split('#')[0];
  await sbClient.auth.signInWithOAuth({provider:'google', options:{redirectTo:url}});
}, []);
const handleLogout = useCallback(async () => {
  await sbClient.auth.signOut();
}, []);
```

変更後:
```js
useEffect(() => {
  const checkAllowed = async (sess) => {
    if (!sess) { setAuthLoading(false); setAuthSession(null); return; }
    const allowed = await TrapApi.checkAllowedEmail(sess.user.email);
    if (!allowed) {
      await TrapApi.signOut();
      setAuthError('このアカウントはアクセスが許可されていません。管理者に連絡してください。');
      setAuthLoading(false); setAuthSession(null);
    } else { setAuthError(''); setAuthSession(sess); setAuthLoading(false); }
  };
  const sub = TrapApi.onAuthStateChange((event, sess) => {
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') { checkAllowed(sess); }
    else if (event === 'SIGNED_OUT') { setAuthSession(null); setAuthLoading(false); }
    else if (event === 'TOKEN_REFRESHED' && sess) { setAuthSession(sess); }
  });
  return () => sub.unsubscribe();
}, []);
const handleLogin = useCallback(async () => {
  await TrapApi.signInWithGoogle();
}, []);
const handleLogout = useCallback(async () => {
  await TrapApi.signOut();
}, []);
```

- [ ] **Step 4: Babel ブロック内で残っている `sbClient` 参照を探して削除確認**

```bash
grep -n "sbClient" trap-notes.html
```

Expected: 0 件（TrapApi に完全移行済み）。残っていれば SECTION 4 のメソッドを使うよう修正する。

- [ ] **Step 5: ブラウザで動作確認**

- ページリロード → ログイン画面が表示されること
- Google ログイン → 罠一覧が表示されること（既存データが表示）
- Console: `await TrapApi.getCurrentUser()` → `{id:'uuid...', email:'...'}`

- [ ] **Step 6: コミット**

```bash
git add trap-notes.html
git commit -m "feat: SECTION 4 TrapApi を追加し sbClient を Babel ブロックから移管"
```

---

## Task 5: SECTION 5 - SyncService（同期オーケストレーター）

**Files:**
- Modify: `trap-notes.html` (SECTION 4 の直後に挿入)

---

- [ ] **Step 1: `fullSync()` の二重起動防止設計を確認する**

`SyncService` 内に `_isSyncing` フラグを持ち、以下のパターンで二重起動を防ぐ:
```
fullSync() 呼び出し
  └─ _isSyncing === true → 即 return（何もしない）
  └─ _isSyncing === false
       → _isSyncing = true
       → syncPending() → refreshFromServer()
       → finally: _isSyncing = false（成功・失敗どちらでも解放）
```

polling（30秒）/ window online / visibilitychange / 操作直後 が同時に発火しても
最初の1回だけが実行され、残りは無視される。

- [ ] **Step 2: SECTION 5 ブロックと `window._app` を SECTION 4 の `</script>` 直後に挿入する**

```html
<!-- ================================================================
  SECTION 5: SyncService — sync orchestrator
================================================================ -->
<script>
const SyncService = (() => {
  let _isSyncing  = false;
  let _pollTimer  = null;
  let _eventsSet  = false;

  async function syncPending() {
    const pending = await TrapDB.getPending();
    let succeeded = 0, failed = 0;
    const errors = [];
    const user = await TrapApi.getCurrentUser();

    for (const trap of pending) {
      try {
        if (trap.pendingOperation === 'delete') {
          await TrapApi.softDeleteTrap(trap.id, trap.deletedAt, trap.deletedBy);
        } else {
          const rec = { ...trap };
          if (user) {
            rec.updatedBy = user.id;
            if (trap.pendingOperation === 'insert') rec.createdBy = user.id;
          }
          await TrapApi.upsertTrap(rec);
        }
        await TrapDB.markSynced(trap.id);
        succeeded++;
      } catch (e) {
        await TrapDB.markFailed(trap.id);
        errors.push({ id: trap.id, error: e.message || String(e) });
        failed++;
      }
    }
    return { succeeded, failed, errors };
  }

  async function refreshFromServer() {
    try {
      const serverRecords = await TrapApi.fetchAll();
      await TrapDB.seedFromServer(serverRecords);
      document.dispatchEvent(new CustomEvent('trap-data-changed'));
    } catch (e) {
      console.warn('[SyncService] refreshFromServer failed:', e);
    }
  }

  async function fullSync() {
    if (_isSyncing) return;
    _isSyncing = true;
    document.dispatchEvent(new CustomEvent('sync-state-change', { detail: { syncing: true } }));
    try {
      await syncPending();
      await refreshFromServer();
    } finally {
      _isSyncing = false;
      document.dispatchEvent(new CustomEvent('sync-state-change', { detail: { syncing: false } }));
    }
  }

  async function retryFailed() {
    await TrapDB.retryFailed();
    await fullSync();
  }

  function startPolling(ms) {
    if (_pollTimer) return;
    _pollTimer = setInterval(() => { if (navigator.onLine) fullSync(); }, ms || 30000);
  }

  function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  function bindBrowserEvents() {
    if (_eventsSet) return;
    _eventsSet = true;
    window.addEventListener('online', () => fullSync());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine) fullSync();
    });
  }

  return { syncPending, refreshFromServer, fullSync, retryFailed, startPolling, stopPolling, bindBrowserEvents };
})();

/* ---- グローバル公開（window._app のみ） ---- */
window._app = { db: TrapDB, api: TrapApi, sync: SyncService };
</script>
```

- [ ] **Step 2: ブラウザで SyncService の動作確認**

ログイン済み状態で以下を実行:
```js
typeof window._app          // → 'object'
typeof window._app.sync     // → 'object'
await window._app.sync.fullSync()  // エラーなく完了すること
await TrapDB.getSyncStats()        // → {pending:0, failed:0}（既存データは synced 状態）
```

- [ ] **Step 3: コミット**

```bash
git add trap-notes.html
git commit -m "feat: SECTION 5 SyncService と window._app を追加"
```

---

## Task 6: データ読み込みを IndexedDB-first に変更

**Files:**
- Modify: `trap-notes.html` (Babel ブロック内の初期ロード `useEffect`)

---

- [ ] **Step 1: `showToast` ヘルパーを App コンポーネント内の state 宣言直後に追加する**

`const [toast, setToast] = useState('');` の直後に追加:
```js
const showToast = useCallback((msg, ms) => {
  setToast(msg);
  setTimeout(() => setToast(''), ms || 3500);
}, []);
```

- [ ] **Step 2: 初回読み込みの順序を確認する**

以下の順序を厳守すること:
```
1. TrapDB.migrateFromLocalStorage()
   ├─ yokose-migration-done フラグあり → スキップ
   ├─ IndexedDB にデータあり → フラグをセットしてスキップ
   └─ yokose-v4 が localStorage にあれば → IndexedDB へコピーしてフラグをセット

2. TrapDB.getAll() → setTraps(local)  ← IndexedDB から即時表示

3. SyncService.bindBrowserEvents() / startPolling(30000)  ← イベント登録

4. navigator.onLine の場合のみ:
   SyncService.fullSync() → setTraps(await TrapDB.getAll())  ← Supabase と同期
```

- [ ] **Step 3: 初期ロードの `useEffect`（現在 `sbClient.from('traps')...` を呼んでいる箇所）を書き換える**

変更前:
```js
// Load traps from Supabase on mount
useEffect(() => {
  sbClient.from('traps').select('*')
    .eq('user_id', session.user.id)
    .order('created_at', {ascending:false})
    .then(({data, error}) => {
      if (!error && data) setTraps(data.map(r => toLocalRecord(r)));
    });
}, []);
```

変更後（上記 Step 2 の順序に従う）:
```js
// IndexedDB-first load + background sync
useEffect(() => {
  let mounted = true;
  (async () => {
    // 1. 移行（yokose-v4 → IndexedDB、初回のみ）
    await TrapDB.migrateFromLocalStorage();

    // 2. IndexedDB から即時表示
    const local = await TrapDB.getAll();
    if (mounted) setTraps(local);

    // 3. イベント登録（trap-data-changed でデータを再読み込み）
    const onDataChange = async () => {
      const refreshed = await TrapDB.getAll();
      if (mounted) setTraps(refreshed);
    };
    document.addEventListener('trap-data-changed', onDataChange);
    SyncService.bindBrowserEvents();
    SyncService.startPolling(30000);

    // 4. オンラインなら Supabase と同期
    if (navigator.onLine) {
      await SyncService.fullSync();
      const synced = await TrapDB.getAll();
      if (mounted) setTraps(synced);
    }
  })();
  return () => { mounted = false; };
}, []);
```

- [ ] **Step 4: ブラウザで動作確認**

- ページリロード → 既存の罠一覧が IndexedDB 経由で表示されること
- DevTools > Application > IndexedDB > yokoze-trap-notes > traps にレコードが入っていること
- Console: `await TrapDB.getAll()` で一覧と同じレコードが返ること

- [ ] **Step 5: コミット**

```bash
git add trap-notes.html
git commit -m "feat: 初期データ読み込みを IndexedDB-first + バックグラウンド同期に変更"
```

---

## Task 7: saveTrap を IndexedDB 経由に変更

**Files:**
- Modify: `trap-notes.html` (Babel ブロック内の `saveTrap` 関数)

---

- [ ] **Step 1: `saveTrap` 関数全体を以下に置き換える**

変更前（`sbClient.from('traps').update/insert` を使っている関数）:
```js
const saveTrap = useCallback(async () => {
  if (!draft || !draft.trapId.trim()) return;
  const now = new Date().toISOString();
  const uid = session.user.id;
  if (editTrapId) {
    const {error} = await sbClient.from('traps').update({...}).eq('id', editTrapId).eq('user_id', uid);
    if (!error) setTraps(p => p.map(t => t.id===editTrapId ? {...t, ...draft, updatedAt:now} : t));
  } else {
    const {data, error} = await sbClient.from('traps').insert({...}).select().single();
    if (!error && data) setTraps(p => [dbToTrap(data), ...p]);
  }
  setSF(false); setDraft(null);
}, [draft, editTrapId, session]);
```

変更後:
```js
const saveTrap = useCallback(async () => {
  if (!draft || !draft.trapId.trim()) return;
  const now = new Date().toISOString();
  const user = await TrapApi.getCurrentUser();
  const isOnline = navigator.onLine;

  let trapToSave;
  if (editTrapId) {
    const existing = await TrapDB.getById(editTrapId);
    trapToSave = {
      ...(existing || {}),
      ...draft,
      id:        editTrapId,
      updatedAt: now,
      updatedBy: user ? user.id : null,
    };
  } else {
    trapToSave = {
      id:          crypto.randomUUID(),
      trapId:      draft.trapId,
      type:        draft.type,
      status:      draft.status,
      installedAt: draft.installedAt || '',
      lat:         draft.lat  || '',
      lng:         draft.lng  || '',
      notes:       draft.notes || '',
      sightings:   [],
      createdAt:   now,
      updatedAt:   now,
      createdBy:   user ? user.id : null,
      updatedBy:   user ? user.id : null,
      deletedAt:   null,
      deletedBy:   null,
    };
  }

  await TrapDB.save(trapToSave);
  setTraps(await TrapDB.getAll());
  setSF(false); setDraft(null);

  if (isOnline) {
    await SyncService.fullSync();
    setTraps(await TrapDB.getAll());
    showToast(editTrapId ? '更新して同期しました' : '登録して同期しました');
  } else {
    showToast(editTrapId ? 'オフラインで更新しました。通信回復後に同期します' : 'オフラインで登録しました。通信回復後に同期します');
  }
}, [draft, editTrapId, showToast]);
```

- [ ] **Step 2: ブラウザで動作確認（オンライン）**

- 罠を新規登録 → 一覧に追加される
- 「登録して同期しました」トーストが出る
- Supabase Table Editor で `traps` テーブルにレコードが追加されること

- [ ] **Step 3: ブラウザで動作確認（オフライン）**

- DevTools > Network: Offline に設定
- 罠を新規登録 → 「オフラインで登録しました。通信回復後に同期します」トーストが出る
- 一覧に新しい罠が表示される
- DevTools > Application > IndexedDB で `syncStatus: "pending"` のレコードを確認
- Network を Online に戻す → 数秒後に `syncStatus: "synced"` に変わること

- [ ] **Step 4: コミット**

```bash
git add trap-notes.html
git commit -m "feat: saveTrap を IndexedDB 経由に変更し offline/online 対応トースト追加"
```

---

## Task 8: deleteTrap を論理削除に変更

**Files:**
- Modify: `trap-notes.html` (Babel ブロック内の `deleteTrap` 関数)

---

- [ ] **Step 1: `deleteTrap` 関数全体を以下に置き換える**

変更前（`sbClient.from('traps').delete()...` を使っている関数）:
```js
const deleteTrap = useCallback(async (id) => {
  const {error} = await sbClient.from('traps').delete().eq('id', id).eq('user_id', session.user.id);
  if (!error) {
    setTraps(p => p.filter(t => t.id!==id));
    setDelId(null);
    if (detailId===id) setDetailId(null);
    if (selId===id) setSelId(null);
  }
}, [detailId, selId, session]);
```

変更後:
```js
const deleteTrap = useCallback(async (id) => {
  const user = await TrapApi.getCurrentUser();
  const isOnline = navigator.onLine;

  await TrapDB.markDeleted(id, user ? user.id : null);
  setTraps(await TrapDB.getAll());
  setDelId(null);
  if (detailId === id) setDetailId(null);
  if (selId === id) setSelId(null);

  if (isOnline) {
    await SyncService.fullSync();
    setTraps(await TrapDB.getAll());
    showToast('削除して同期しました');
  } else {
    showToast('オフラインで削除登録しました。通信回復後に同期します');
  }
}, [detailId, selId, showToast]);
```

- [ ] **Step 2: ブラウザで動作確認**

- 罠を削除 → 一覧から消える
- オンライン: Supabase Table Editor で `deleted_at` が設定されていること
- オフライン: IndexedDB で `pendingOperation: "delete"` が設定されること

- [ ] **Step 3: コミット**

```bash
git add trap-notes.html
git commit -m "feat: deleteTrap を論理削除 (markDeleted + softDeleteTrap) に変更"
```

---

## Task 9: saveSighting / deleteSighting を IndexedDB 経由に変更

**Files:**
- Modify: `trap-notes.html` (Babel ブロック内の `saveSighting` / `deleteSighting` 関数)

---

- [ ] **Step 1: `saveSighting` を書き換える**

変更前:
```js
const saveSighting = useCallback(async () => {
  if (!sDraft || !detailId) return;
  const sighting = {id:crypto.randomUUID(), ...sDraft};
  const trap = traps.find(t => t.id===detailId);
  if (!trap) return;
  const newSightings = [...trap.sightings, sighting];
  const now = new Date().toISOString();
  const {error} = await sbClient.from('traps').update({sightings:newSightings, updated_at:now}).eq('id', detailId).eq('user_id', session.user.id);
  if (!error) setTraps(p => p.map(t => t.id===detailId ? {...t, sightings:newSightings, updatedAt:now} : t));
  setSSF(false); setSDraft(null);
}, [sDraft, detailId, traps, session]);
```

変更後:
```js
const saveSighting = useCallback(async () => {
  if (!sDraft || !detailId) return;
  const trap = await TrapDB.getById(detailId);
  if (!trap) return;
  const user = await TrapApi.getCurrentUser();
  const now = new Date().toISOString();
  await TrapDB.save({
    ...trap,
    sightings: [...trap.sightings, { id: crypto.randomUUID(), ...sDraft }],
    updatedAt: now,
    updatedBy: user ? user.id : null,
  });
  setTraps(await TrapDB.getAll());
  setSSF(false); setSDraft(null);
  if (navigator.onLine) { await SyncService.fullSync(); setTraps(await TrapDB.getAll()); }
}, [sDraft, detailId]);
```

- [ ] **Step 2: `deleteSighting` を書き換える**

変更前:
```js
const deleteSighting = useCallback(async (trapId, sightingId) => {
  const trap = traps.find(t => t.id===trapId);
  if (!trap) return;
  const newSightings = trap.sightings.filter(s => s.id!==sightingId);
  const now = new Date().toISOString();
  const {error} = await sbClient.from('traps').update({sightings:newSightings, updated_at:now}).eq('id', trapId).eq('user_id', session.user.id);
  if (!error) setTraps(p => p.map(t => t.id===trapId ? {...t, sightings:newSightings, updatedAt:now} : t));
}, [traps, session]);
```

変更後:
```js
const deleteSighting = useCallback(async (trapId, sightingId) => {
  const trap = await TrapDB.getById(trapId);
  if (!trap) return;
  const user = await TrapApi.getCurrentUser();
  const now = new Date().toISOString();
  await TrapDB.save({
    ...trap,
    sightings: trap.sightings.filter(s => s.id !== sightingId),
    updatedAt: now,
    updatedBy: user ? user.id : null,
  });
  setTraps(await TrapDB.getAll());
  if (navigator.onLine) { await SyncService.fullSync(); setTraps(await TrapDB.getAll()); }
}, []);
```

- [ ] **Step 3: ブラウザで動作確認**

- 詳細画面で目撃を追加 → 詳細一覧に反映される
- 目撃を削除 → 詳細一覧から消える

- [ ] **Step 4: コミット**

```bash
git add trap-notes.html
git commit -m "feat: saveSighting / deleteSighting を IndexedDB 経由に変更"
```

---

## Task 10: SyncStatusBanner を追加

**Files:**
- Modify: `trap-notes.html` (Babel ブロック内)

---

- [ ] **Step 1: `useSyncState` hook を `FilterBar` 関数の直前に追加する**

```js
/* ── useSyncState ─────────────────────────────────────────────── */
function useSyncState() {
  const [stats, setStats]     = React.useState({pending:0, failed:0});
  const [syncing, setSyncing] = React.useState(false);
  const [lastSync, setLastSync] = React.useState(null);

  const refresh = React.useCallback(async () => {
    const s = await TrapDB.getSyncStats();
    setStats(s);
    setLastSync(new Date().toLocaleTimeString('ja-JP', {hour:'2-digit', minute:'2-digit'}));
  }, []);

  React.useEffect(() => {
    const onStateChange = (e) => {
      setSyncing(e.detail.syncing);
      if (!e.detail.syncing) refresh();
    };
    const onDataChange = () => refresh();
    document.addEventListener('sync-state-change', onStateChange);
    document.addEventListener('trap-data-changed', onDataChange);
    refresh();
    return () => {
      document.removeEventListener('sync-state-change', onStateChange);
      document.removeEventListener('trap-data-changed', onDataChange);
    };
  }, [refresh]);

  return { pending: stats.pending, failed: stats.failed, syncing, lastSync };
}
```

- [ ] **Step 2: `SyncStatusBanner` コンポーネントを `useSyncState` の直後に追加する**

```js
/* ── SyncStatusBanner ─────────────────────────────────────────── */
function SyncStatusBanner({onRetry}) {
  const { pending, failed, syncing, lastSync } = useSyncState();
  const isOffline = !navigator.onLine;

  if (syncing) {
    return (
      <div style={{background:'#EFF6FF', color:'#1D4ED8', fontSize:'0.72rem', fontWeight:800, padding:'5px 12px', textAlign:'center', borderBottom:'1px solid #BFDBFE', flexShrink:0}}>
        ⏳ 同期中...
      </div>
    );
  }
  if (failed > 0) {
    return (
      <div onClick={onRetry} style={{background:'#FEF2F2', color:'#DC2626', fontSize:'0.72rem', fontWeight:800, padding:'5px 12px', textAlign:'center', borderBottom:'1px solid #FECACA', flexShrink:0, cursor:'pointer'}}>
        ✗ {failed}件 送信失敗 — タップして再試行
      </div>
    );
  }
  if (pending > 0) {
    return (
      <div style={{background:'#FFFBEB', color:'#92400E', fontSize:'0.72rem', fontWeight:800, padding:'5px 12px', textAlign:'center', borderBottom:'1px solid #FDE68A', flexShrink:0}}>
        ⏳ {pending}件 送信待ち
      </div>
    );
  }
  if (isOffline) return null; // offline-bar が表示するため省略
  if (lastSync) {
    return (
      <div style={{background:'white', color:'#94A3B8', fontSize:'0.68rem', fontWeight:700, padding:'3px 12px', textAlign:'center', borderBottom:'1px solid var(--forest-100)', flexShrink:0}}>
        最終同期: {lastSync}
      </div>
    );
  }
  return null;
}
```

- [ ] **Step 3: App コンポーネントの return 内に SyncStatusBanner を追加する**

`{offline && <div className="offline-bar">...</div>}` の直後に追加:

```js
{offline && <div className="offline-bar">📡 オフラインモード — キャッシュデータを表示中</div>}
<SyncStatusBanner onRetry={() => SyncService.retryFailed().then(async () => setTraps(await TrapDB.getAll()))} />
```

- [ ] **Step 4: ブラウザで動作確認**

- 通常時: ヘッダー下に「最終同期: HH:MM」が薄く表示される
- DevTools Offline → 罠を追加 → 黄色帯「N件 送信待ち」が出る
- Online に戻す → 同期後に「最終同期: HH:MM」に戻る

- [ ] **Step 5: コミット**

```bash
git add trap-notes.html
git commit -m "feat: useSyncState hook と SyncStatusBanner コンポーネントを追加"
```

---

## Task 11: TrapCard に同期ステータスアイコンを追加

**Files:**
- Modify: `trap-notes.html` (Babel ブロック内の `TrapCard` コンポーネント)

---

- [ ] **Step 1: `TrapCard` の props に `syncStatus` を追加し、アイコンを表示する**

`TrapCard` 関数の引数に `syncStatus` を追加:
```js
function TrapCard({trap:t, isOpen, isSel, onToggle, onEdit, onDel, onFly, onDetail, desktop, syncStatus}) {
```

カード内の trapId / status バッジを表示している `<div>` に同期アイコンを追加:
```js
// 変更前:
<span style={{fontWeight:900, fontSize:'1rem', color:'var(--forest-900)', fontFamily:"'JetBrains Mono', monospace", letterSpacing:'0.05em'}}>{t.trapId}</span>
<span className="status-badge" style={{background:st.bg, color:st.text, borderColor:st.border}}>{STATUS_ICON[t.status]} {t.status}</span>

// 変更後（syncStatus アイコンを追加）:
<span style={{fontWeight:900, fontSize:'1rem', color:'var(--forest-900)', fontFamily:"'JetBrains Mono', monospace", letterSpacing:'0.05em'}}>{t.trapId}</span>
<span className="status-badge" style={{background:st.bg, color:st.text, borderColor:st.border}}>{STATUS_ICON[t.status]} {t.status}</span>
{syncStatus === 'pending' && <span style={{fontSize:'0.65rem', color:'#D97706'}} title="同期待ち">⏳</span>}
{syncStatus === 'failed'  && <span style={{fontSize:'0.65rem', color:'#DC2626'}} title="同期失敗">✗</span>}
```

- [ ] **Step 2: TrapCard を呼び出している箇所に `syncStatus` を渡す**

TrapCard をレンダリングしている箇所（モバイルリスト・デスクトップサイドバーの両方）を検索:
```bash
grep -n "TrapCard" trap-notes.html
```

TrapCard が呼ばれる各箇所に `syncStatus={trap.syncStatus}` を追加:
```js
// 例（実際の行番号はファイルの変更量によって変動する）
<TrapCard
  key={t.id}
  trap={t}
  syncStatus={t.syncStatus}
  ...
/>
```

- [ ] **Step 3: ブラウザで動作確認**

- Offline 状態で罠を追加 → カードに ⏳ アイコンが表示される
- Online に戻して同期後 → ⏳ が消える

- [ ] **Step 4: コミット**

```bash
git add trap-notes.html
git commit -m "feat: TrapCard に同期ステータスアイコン（⏳ / ✗）を追加"
```

---

## Task 12: GPS エラーハンドリング改善

**Files:**
- Modify: `trap-notes.html` (Babel ブロック内の `getGPS` 関数 + フォームの GPS エラー表示)

---

- [ ] **Step 1: `getGPS` 関数を書き換える**

変更前:
```js
const getGPS = useCallback(() => {
  if (!navigator.geolocation) { setGpsErr('GPSに対応していません'); return; }
  setGpsLd(true); setGpsErr('');
  navigator.geolocation.getCurrentPosition(
    pos => { setDraft(d => d ? {...d, lat:pos.coords.latitude.toFixed(6), lng:pos.coords.longitude.toFixed(6)} : d); setGpsLd(false); },
    () => { setGpsErr('GPS取得失敗。屋外で再試行してください'); setGpsLd(false); },
    {enableHighAccuracy:true, timeout:15000}
  );
}, []);
```

変更後:
```js
const getGPS = useCallback(() => {
  if (!navigator.geolocation) {
    setGpsErr('このデバイスはGPSに対応していません');
    return;
  }
  setGpsLd(true); setGpsErr('');
  navigator.geolocation.getCurrentPosition(
    pos => {
      setDraft(d => d ? {...d, lat:pos.coords.latitude.toFixed(6), lng:pos.coords.longitude.toFixed(6)} : d);
      setGpsLd(false);
    },
    (err) => {
      setGpsLd(false);
      if (err.code === 1) {
        setGpsErr('位置情報の使用が拒否されています。ブラウザの設定を確認してください');
      } else if (err.code === 3) {
        setGpsErr('GPS取得がタイムアウトしました。屋外で再試行してください');
      } else {
        setGpsErr('GPS取得に失敗しました。手動で入力してください');
      }
      showToast('GPS取得に失敗しました。手動で入力してください', 5000);
    },
    {enableHighAccuracy:true, timeout:15000}
  );
}, [showToast]);
```

- [ ] **Step 2: フォーム内の GPS エラー表示箇所を確認する**

```bash
grep -n "gpsError\|gpsErr" trap-notes.html
```

GPS エラーが表示されている箇所を確認し、エラーメッセージが正しく表示されることを確認する。
既存の表示コード（`{gpsError && <div ...>...}` の形式）はそのまま使用可能。

- [ ] **Step 3: ブラウザで動作確認**

- DevTools でカメラ/位置情報を「ブロック」に設定してフォームを開く
- GPS ボタンを押す → 「位置情報の使用が拒否されています。ブラウザの設定を確認してください」が表示される
- トーストにも「GPS取得に失敗しました。手動で入力してください」が出る

- [ ] **Step 4: コミット**

```bash
git add trap-notes.html
git commit -m "fix: GPS エラーハンドリングを改善（権限拒否・タイムアウト・一般エラーを区別）"
```

---

## 全タスク完了後のチェック

- [ ] `grep -n "sbClient" trap-notes.html` → 0 件（TrapApi に完全移管済み）
- [ ] `grep -n "dbToTrap" trap-notes.html` → 0 件（toLocalRecord に置き換え済み）
- [ ] `grep -n "\.eq('user_id'" trap-notes.html` → 0 件（共有 RLS に移行済み）
- [ ] オンライン: CRUD → 即同期 → 「～して同期しました」トースト
- [ ] オフライン: CRUD → IndexedDB 保存 → 「オフラインで～しました」トースト → オンライン復帰後に自動同期
- [ ] SyncStatusBanner が pending / failed / syncing / 通常を正しく切り替える
- [ ] TrapCard の ⏳ / ✗ アイコンが syncStatus と連動する
- [ ] GPS 拒否・タイムアウト・一般エラーが別メッセージになっている
- [ ] Supabase Table Editor で deleted_at が論理削除で設定されていること

---

## 同期仕様サマリー（README 追記用）

```
オフライン動作:
  - 操作（追加・編集・削除）はすべて IndexedDB に先書き（楽観的更新）
  - オフライン中は操作を pending としてキューに積む

同期タイミング:
  - 操作直後（オンライン時のみ）
  - 30 秒ポーリング
  - window online イベント（ネットワーク復帰）
  - document visibilitychange（タブ復帰）

競合解決: last write wins（updated_at が新しい方を優先）
削除方式: 論理削除（deleted_at を設定）
同期済みフラグ: syncStatus = synced / pending / failed
```
