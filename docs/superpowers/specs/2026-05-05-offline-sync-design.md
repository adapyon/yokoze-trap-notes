# 設計仕様: オフライン同期対応（共有データ化）

**日付:** 2026-05-05
**対象ファイル:** `trap-notes.html`
**方針:** 単一 HTML ファイル構成を維持したまま、共有データ化・オフライン同期を実現する

---

## 1. 背景と目的

### 現状
- `trap-notes.html` は localStorage のみで動作する完全ローカルアプリ
- データは端末ごとに独立しており、複数人での共有ができない
- Supabase プロジェクトは設定済みだが、フロントエンドとの連携はまだない

### 目的
1. traps を Supabase 上の共有データとして管理する
2. オフライン中でも新規登録・編集・削除を可能にする
3. オンライン復帰時に未送信データを自動同期する
4. 同期状態（synced / pending / failed）を UI に表示する

---

## 2. アーキテクチャ

### ファイル構成（単一 HTML ファイル内のスクリプトブロック構成）

```html
<!-- SECTION 1: CDN 読み込み -->
<script src="react CDN"></script>
<script src="react-dom CDN"></script>
<script src="babel-standalone CDN"></script>
<script src="leaflet CDN"></script>
<script src="supabase-js CDN"></script>
<script src="dexie CDN"></script>

<!-- SECTION 2: 定数・ユーティリティ（plain JS） -->
<script>
  // TrapType / TrapStatus 定数
  // trapId 生成（A-001 形式）
  // UUID 生成
  // 日付フォーマット
</script>

<!-- SECTION 3: TrapDB — IndexedDB 層（Dexie） -->
<script> const TrapDB = (() => { ... })(); </script>

<!-- SECTION 4: TrapApi — Supabase 層 -->
<script> const TrapApi = (() => { ... })(); </script>

<!-- SECTION 5: SyncService — 同期オーケストレーター -->
<script> const SyncService = (() => { ... })(); </script>

<!-- SECTION 6: React UI 層（Babel） -->
<script type="text/babel"> /* UI のみ */ </script>
```

### グローバル公開

```js
window._app = { db: TrapDB, api: TrapApi, sync: SyncService };
```

`window` への露出は `_app` の1オブジェクトのみ。React UI 層はこれのみを参照する。

---

## 3. Supabase スキーマ変更

### 追加カラム（`traps` テーブル）

```sql
ALTER TABLE traps ADD COLUMN IF NOT EXISTS created_by  uuid REFERENCES auth.users(id);
ALTER TABLE traps ADD COLUMN IF NOT EXISTS updated_by  uuid REFERENCES auth.users(id);
ALTER TABLE traps ADD COLUMN IF NOT EXISTS deleted_at  timestamptz;
ALTER TABLE traps ADD COLUMN IF NOT EXISTS deleted_by  uuid REFERENCES auth.users(id);
```

### 留意点
- `lat` / `lng` は既存の `text` 型を維持（型変更は今回対象外）
- 通常の一覧取得は `deleted_at IS NULL` を標準条件とする
- RLS は既存の `allowed_emails` + `auth.uid()` ベースを維持

---

## 4. データモデル

### ローカルモデル（IndexedDB に保存するレコード）

```js
{
  // 識別
  id:               string,          // UUID（主キー）
  trapId:           string,          // "A-001" 形式

  // 罠データ
  type:             string,          // TrapType 定数
  status:           string,          // TrapStatus 定数
  installedAt:      string,          // "YYYY-MM-DD"
  lat:              string | null,   // text 互換（既存スキーマに合わせる）
  lng:              string | null,
  notes:            string,
  sightings:        array,

  // 監査
  createdAt:        string,          // ISO datetime
  updatedAt:        string,          // ISO datetime（last write wins の基準）
  createdBy:        string | null,   // auth.uid() の UUID
  updatedBy:        string | null,   // auth.uid() の UUID
  deletedAt:        string | null,   // 論理削除: null = 有効
  deletedBy:        string | null,   // auth.uid() の UUID

  // 同期メタ（ローカル専用・Supabase には送らない）
  syncStatus:       "synced" | "pending" | "failed",
  pendingOperation: "insert" | "update" | "delete" | null,
  lastSyncAt:       string | null,
}
```

### 変換関数

```js
// ローカル → Supabase 送信用
function toServerRecord(local) {
  return {
    id:           local.id,
    trap_id:      local.trapId,
    type:         local.type,
    status:       local.status,
    installed_at: local.installedAt,
    lat:          local.lat,   // text のまま
    lng:          local.lng,
    notes:        local.notes,
    sightings:    local.sightings,
    created_at:   local.createdAt,
    updated_at:   local.updatedAt,
    created_by:   local.createdBy,
    updated_by:   local.updatedBy,
    deleted_at:   local.deletedAt,
    deleted_by:   local.deletedBy,
  };
}

// Supabase → ローカル（同期メタは既存値を保持または初期化）
function toLocalRecord(server, existing = {}) {
  return {
    id:               server.id,
    trapId:           server.trap_id,
    type:             server.type,
    status:           server.status,
    installedAt:      server.installed_at,
    lat:              server.lat ?? null,
    lng:              server.lng ?? null,
    notes:            server.notes ?? "",
    sightings:        server.sightings ?? [],
    createdAt:        server.created_at,
    updatedAt:        server.updated_at,
    createdBy:        server.created_by ?? null,
    updatedBy:        server.updated_by ?? null,
    deletedAt:        server.deleted_at ?? null,
    deletedBy:        server.deleted_by ?? null,
    syncStatus:       existing.syncStatus === "pending" ? "pending" : "synced",
    pendingOperation: existing.syncStatus === "pending" ? existing.pendingOperation : null,
    lastSyncAt:       new Date().toISOString(),
  };
}
```

---

## 5. サービス層 API

### TrapDB（IndexedDB / Dexie）

**Dexie スキーマ:**
```js
db.version(1).stores({
  traps: "id, trapId, status, syncStatus, deletedAt, updatedAt"
});
```

**メソッド一覧:**

| メソッド | 説明 |
|---|---|
| `getAll()` | 論理削除済みを除く全件（`deletedAt == null`） |
| `getById(id)` | 1件取得 |
| `save(trap)` | 新規または上書き保存（内部ルール後述） |
| `markDeleted(id, userId)` | `deletedAt`・`deletedBy` を設定し pending に |
| `markSynced(id)` | `syncStatus = "synced"`, `pendingOperation = null` |
| `markFailed(id)` | `syncStatus = "failed"` |
| `getPending()` | `syncStatus == "pending"` の全件 |
| `seedFromServer(records)` | Supabase から取得した最新データを一括反映 |
| `migrateFromLocalStorage()` | `yokose-v4` キーから初回移行 |

**save(trap) の内部ルール:**
```
新規（IndexedDB に id が存在しない）:
  createdAt    = 引数に無ければ現在時刻を補完
  updatedAt    = 現在時刻
  syncStatus   = "pending"
  pendingOperation = "insert"

更新（IndexedDB に id が存在する）:
  updatedAt    = 現在時刻（必ず上書き）
  syncStatus   = "pending"
  pendingOperation = "update"
  ※ pendingOperation がすでに "insert" の場合は "insert" を維持
```

**seedFromServer の競合ルール:**
```
① ローカルに同一 id の pending レコードがある → スキップ（ローカル優先）
② ローカルに同一 id があり pending でない   → サーバー値で上書き
③ ローカルに存在しない                      → 新規追加
④ サーバーの deleted_at が非 null           → IndexedDB に保存するが getAll() から除外
```

---

### TrapApi（Supabase）

| メソッド | 説明 |
|---|---|
| `getSession()` | 現在の認証セッション |
| `getCurrentUser()` | `{ id: uid, email }` または `null` |
| `signInWithGoogle()` | Google OAuth |
| `signOut()` | ログアウト |
| `onAuthStateChange(cb)` | 認証状態変化のリスナー登録 |
| `fetchAll()` | `deleted_at IS NULL` の全件取得 |
| `upsertTrap(trap)` | INSERT または UPDATE（id で衝突解決） |
| `softDeleteTrap(id, deletedAt, deletedBy)` | `deleted_at` / `deleted_by` を UPDATE |

---

### SyncService（同期オーケストレーター）

| メソッド | 説明 |
|---|---|
| `syncPending()` | pending キューを全件サーバーへ送信 → `Promise<SyncResult>` |
| `refreshFromServer()` | Supabase から最新取得 → `seedFromServer()` → UI 通知 |
| `fullSync()` | `syncPending()` → `refreshFromServer()` の標準フロー |
| `startPolling(ms = 30000)` | 定期ポーリング開始 |
| `stopPolling()` | ポーリング停止 |
| `bindBrowserEvents()` | `online` / `visibilitychange` イベント登録（初回のみ） |

**SyncResult:**
```js
{ succeeded: number, failed: number, errors: [{ id, error }] }
```

**failed レコードの扱い:**
- `syncPending()` は `syncStatus === "pending"` のレコードのみを対象にする
- `syncStatus === "failed"` のレコードは自動再試行しない
- 手動再試行: SyncStatusBanner の「タップして再試行」を押すと `failed` を `pending` に戻してから `fullSync()` を実行する

---

## 6. 同期フロー

### 操作時フロー

```
ユーザー操作（追加・編集・削除）
  → TrapDB.save() / .markDeleted()
  → syncStatus: "pending" で IndexedDB に保存
  → UI は即座にローカルデータを表示（楽観的更新）
  → オンラインなら SyncService.fullSync() を即時実行
  → オフラインなら次のトリガーまで待機
```

### 自動同期トリガー

各トリガーは `fullSync()` を呼び出す。

| トリガー | 説明 |
|---|---|
| 30 秒ポーリング | `startPolling(30000)` → 定期的に `fullSync()` |
| `window: online` | ネットワーク復帰時 → `fullSync()` |
| `document: visibilitychange` | ブラウザタブがフォアグラウンドに戻った時 → `fullSync()` |
| 操作直後 | オンライン確認後に `fullSync()` |

### 競合解決

- **方式:** Last write wins（`updated_at` が新しい方を優先）
- **pending 保護:** ローカルに pending がある間はサーバーデータで上書きしない
- **削除優先度:** `deleted_at` が設定されたレコードは一覧から除外される

### 競合が起きうる箇所（コメントで明記する）

1. 2人が同じ罠を同時にオフライン編集した場合、後からオンラインになった方が勝つ
2. 一方が削除、他方が編集した場合、削除済み（`deleted_at` あり）が優先される
3. 30 秒ポーリングは pending を保護するが、別端末の変更はポーリング後に反映される

---

## 7. UI 変更

### SyncStatusBanner（一覧画面上部）

| 状態 | 表示 |
|---|---|
| 全件 synced | 「最終同期: HH:MM」（グレー、目立たない） |
| pending あり | 「N件 送信待ち」（黄色帯） |
| failed あり | 「N件 送信失敗 — タップして再試行」（赤帯） |
| オフライン | 「オフライン — 変更はローカルに保存中」（グレー帯） |
| 同期中 | 「同期中...」（薄青帯 + スピナー） |

### 罠カードの同期アイコン

| syncStatus | アイコン | 色 |
|---|---|---|
| synced | ✓ | グレー |
| pending | ⏳ | 黄色 |
| failed | ✗ | 赤 |

### 操作結果トースト（操作直後に短く表示）

| 操作 | オンライン時 | オフライン時 |
|---|---|---|
| 新規登録 | 「登録して同期しました」 | 「オフラインで登録しました。通信回復後に同期します」 |
| 編集保存 | 「更新して同期しました」 | 「オフラインで更新しました。通信回復後に同期します」 |
| 削除 | 「削除して同期しました」 | 「オフラインで削除登録しました。通信回復後に同期します」 |
| GPS 取得失敗 | 「GPS取得に失敗しました。手動で入力してください」（共通） | ← 同左 |
| 同期失敗 | 「同期に失敗しました。次回接続時に再試行します」 | — |

**実装:** Babel ブロック内に `showToast(message, type)` を実装（表示時間: 通常 3 秒 / エラー 5 秒）

### ログイン状態表示

| 状態 | 表示 |
|---|---|
| 未ログイン | 「Google でログイン」ボタンのみ表示 |
| ログイン済み | 右上に email 表示 + ログアウトボタン |
| allowed_emails 対象外 | 「利用許可がありません」メッセージ表示 |

### GPS 取得失敗時のフロー

```
取得中        → 「GPS取得中...」スピナー
取得成功      → 座標フィールドに自動入力
取得失敗      → トースト「GPS取得に失敗しました。手動で入力してください」
              + 地図クリックによる座標選択は引き続き使用可能
権限拒否      → 「位置情報の使用が拒否されています。ブラウザの設定を確認してください」
```

---

## 8. 既存データ移行

```
条件: IndexedDB が空 かつ localStorage に yokose-v4 が存在する場合

処理:
  1. yokose-v4 の全レコードを読み込む
  2. syncStatus: "pending", pendingOperation: "insert" で IndexedDB に投入
  3. 起動後の自動同期（fullSync）で Supabase へアップロード
  4. 同期成功後に localStorage を削除

条件: IndexedDB にデータあり → 移行済みとみなし何もしない
```

---

## 9. 手動テスト手順

```
1. 通常操作（オンライン）
   □ Google ログインできる
   □ 罠を新規登録できる → 「登録して同期しました」トーストが出る
   □ 一覧に ✓ アイコンが表示される
   □ 別端末から同じ罠が見える（30秒以内）

2. オフライン操作
   □ DevTools > Network: Offline に設定
   □ 罠を新規登録 → 「オフラインで登録しました」トーストが出る
   □ 一覧に ⏳ アイコンが表示される
   □ バナーに「N件 送信待ち」が表示される

3. オンライン復帰
   □ Network: Online に戻す
   □ 数秒以内に自動同期が走る
   □ ⏳ が ✓ に変わる
   □ バナーが「最終同期: HH:MM」に戻る

4. 論理削除
   □ 罠を削除 → 一覧から消える
   □ Supabase で deleted_at が設定されていることを確認

5. 既存データ移行
   □ 新しいコードで初回起動時、yokose-v4 のデータが一覧に表示される
   □ 同期後に Supabase にも反映される
```

---

## 10. 残課題

| 項目 | 優先度 | 備考 |
|---|---|---|
| Vite 移行 | 低 | 将来の全面改修時に再検討 |
| 写真添付機能 | 低 | 今回対象外、将来拡張 |
| 地図機能拡張 | 低 | 今回対象外 |
| lat/lng の numeric 型移行 | 低 | 今回は text 互換を維持 |
| 管理用バッチ（物理削除） | 低 | 必要なら手動対応 |
| Supabase Realtime への移行 | 低 | 同時利用者が増えた場合に再検討 |
| 2端末同時オフライン編集の競合通知 | 中 | 現状は last write wins で無言上書き |
