import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

type TrapStatus = "稼働中" | "要確認" | "撤去済み";
type TrapType = "くくり罠" | "箱罠" | "囲い罠" | "はこわな（大）" | "その他";

interface Trap {
  id: string;
  name: string;
  lat: string;
  lng: string;
  installedAt: string;
  type: TrapType;
  status: TrapStatus;
  notes: string;
  updatedAt: string;
}

const STATUS_COLOR: Record<TrapStatus, string> = {
  稼働中: "bg-emerald-100 text-emerald-800 border-emerald-300",
  要確認: "bg-amber-100 text-amber-800 border-amber-300",
  撤去済み: "bg-slate-100 text-slate-600 border-slate-300",
};

const STORAGE_KEY = "yokose-trap-notes";

function loadTraps(): Trap[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveTraps(traps: Trap[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(traps));
}

function formatDate(iso: string) {
  return iso ? new Date(iso).toLocaleDateString("ja-JP") : "—";
}

const EMPTY_FORM: Omit<Trap, "id" | "updatedAt"> = {
  name: "",
  lat: "",
  lng: "",
  installedAt: new Date().toISOString().slice(0, 10),
  type: "くくり罠",
  status: "稼働中",
  notes: "",
};

export default function App() {
  const [traps, setTraps] = useState<Trap[]>(loadTraps);
  const [filterStatus, setFilterStatus] = useState<TrapStatus | "すべて">("すべて");
  const [filterType, setFilterType] = useState<TrapType | "すべて">("すべて");
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [gpsLoading, setGpsLoading] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => saveTraps(traps), [traps]);

  const filtered = traps.filter((t) => {
    if (filterStatus !== "すべて" && t.status !== filterStatus) return false;
    if (filterType !== "すべて" && t.type !== filterType) return false;
    if (search && !t.name.includes(search) && !t.notes.includes(search)) return false;
    return true;
  });

  function openNew() {
    setEditId(null);
    setForm({ ...EMPTY_FORM, installedAt: new Date().toISOString().slice(0, 10) });
    setDialogOpen(true);
  }

  function openEdit(trap: Trap) {
    setEditId(trap.id);
    setForm({
      name: trap.name,
      lat: trap.lat,
      lng: trap.lng,
      installedAt: trap.installedAt,
      type: trap.type,
      status: trap.status,
      notes: trap.notes,
    });
    setDialogOpen(true);
  }

  function handleSave() {
    if (!form.name.trim()) return;
    const now = new Date().toISOString();
    if (editId) {
      setTraps((prev) =>
        prev.map((t) => (t.id === editId ? { ...t, ...form, updatedAt: now } : t))
      );
    } else {
      const newTrap: Trap = { ...form, id: crypto.randomUUID(), updatedAt: now };
      setTraps((prev) => [newTrap, ...prev]);
    }
    setDialogOpen(false);
  }

  function handleDelete(id: string) {
    setTraps((prev) => prev.filter((t) => t.id !== id));
    setDeleteConfirm(null);
    if (detailId === id) setDetailId(null);
  }

  function getGPS() {
    if (!navigator.geolocation) return;
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({
          ...f,
          lat: pos.coords.latitude.toFixed(6),
          lng: pos.coords.longitude.toFixed(6),
        }));
        setGpsLoading(false);
      },
      () => setGpsLoading(false),
      { enableHighAccuracy: true }
    );
  }

  const detail = traps.find((t) => t.id === detailId);
  const counts = {
    稼働中: traps.filter((t) => t.status === "稼働中").length,
    要確認: traps.filter((t) => t.status === "要確認").length,
    撤去済み: traps.filter((t) => t.status === "撤去済み").length,
  };

  return (
    <div className="min-h-screen bg-stone-50 font-sans">
      {/* Header */}
      <header className="bg-stone-800 text-stone-100 px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold tracking-tight">横瀬町 罠猟ノート</h1>
          <p className="text-xs text-stone-400">埼玉県秩父郡横瀬町</p>
        </div>
        <Button
          onClick={openNew}
          className="bg-emerald-600 hover:bg-emerald-700 text-white text-sm h-9 px-3"
        >
          ＋ 罠を追加
        </Button>
      </header>

      {/* Summary bar */}
      <div className="bg-stone-700 text-stone-200 px-4 py-2 flex gap-4 text-xs">
        <span>全{traps.length}件</span>
        <span className="text-emerald-400">稼働中 {counts["稼働中"]}</span>
        <span className="text-amber-400">要確認 {counts["要確認"]}</span>
        <span className="text-stone-400">撤去 {counts["撤去済み"]}</span>
      </div>

      {/* Filters */}
      <div className="px-4 py-3 bg-white border-b border-stone-200 flex flex-wrap gap-2 items-center">
        <Input
          placeholder="名前・メモで検索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-sm w-40 flex-shrink-0"
        />
        <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as TrapStatus | "すべて")}>
          <SelectTrigger className="h-8 text-sm w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="すべて">状態：全て</SelectItem>
            <SelectItem value="稼働中">稼働中</SelectItem>
            <SelectItem value="要確認">要確認</SelectItem>
            <SelectItem value="撤去済み">撤去済み</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterType} onValueChange={(v) => setFilterType(v as TrapType | "すべて")}>
          <SelectTrigger className="h-8 text-sm w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="すべて">種類：全て</SelectItem>
            <SelectItem value="くくり罠">くくり罠</SelectItem>
            <SelectItem value="箱罠">箱罠</SelectItem>
            <SelectItem value="囲い罠">囲い罠</SelectItem>
            <SelectItem value="はこわな（大）">はこわな（大）</SelectItem>
            <SelectItem value="その他">その他</SelectItem>
          </SelectContent>
        </Select>
        {(filterStatus !== "すべて" || filterType !== "すべて" || search) && (
          <Button
            variant="ghost"
            className="h-8 text-xs text-stone-500 px-2"
            onClick={() => { setFilterStatus("すべて"); setFilterType("すべて"); setSearch(""); }}
          >
            クリア
          </Button>
        )}
      </div>

      {/* List */}
      <main className="px-4 py-3 space-y-2 max-w-2xl mx-auto">
        {filtered.length === 0 && (
          <div className="text-center text-stone-400 py-16 text-sm">
            {traps.length === 0 ? "罠を追加してください" : "該当する罠がありません"}
          </div>
        )}
        {filtered.map((trap) => (
          <div
            key={trap.id}
            className="bg-white border border-stone-200 rounded p-3 cursor-pointer hover:border-stone-400 transition-colors"
            onClick={() => setDetailId(trap.id === detailId ? null : trap.id)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm text-stone-800 truncate">{trap.name}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded border font-medium ${STATUS_COLOR[trap.status]}`}
                  >
                    {trap.status}
                  </span>
                  <span className="text-xs text-stone-500 bg-stone-100 px-1.5 py-0.5 rounded">
                    {trap.type}
                  </span>
                </div>
                <div className="text-xs text-stone-500 mt-1 flex gap-3 flex-wrap">
                  <span>設置 {formatDate(trap.installedAt)}</span>
                  {trap.lat && trap.lng && (
                    <span className="font-mono">
                      {parseFloat(trap.lat).toFixed(4)}, {parseFloat(trap.lng).toFixed(4)}
                    </span>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                className="text-xs h-7 px-2 text-stone-400 hover:text-stone-700 flex-shrink-0"
                onClick={(e) => { e.stopPropagation(); openEdit(trap); }}
              >
                編集
              </Button>
            </div>

            {detailId === trap.id && (
              <div className="mt-3 pt-3 border-t border-stone-100 text-sm space-y-2">
                {trap.lat && trap.lng && (
                  <div>
                    <span className="text-stone-500 text-xs block">GPS座標</span>
                    <p className="font-mono text-stone-700">
                      緯度 {trap.lat} / 経度 {trap.lng}
                    </p>
                    <a
                      href={`https://maps.google.com/maps?q=${trap.lat},${trap.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Google マップで開く
                    </a>
                  </div>
                )}
                {trap.notes && (
                  <div>
                    <span className="text-stone-500 text-xs block">メモ</span>
                    <p className="text-stone-700 whitespace-pre-wrap text-sm">{trap.notes}</p>
                  </div>
                )}
                <div className="text-xs text-stone-400">更新: {new Date(trap.updatedAt).toLocaleString("ja-JP")}</div>
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    className="text-xs h-7 px-2 text-red-500 hover:text-red-700 hover:bg-red-50"
                    onClick={(e) => { e.stopPropagation(); setDeleteConfirm(trap.id); }}
                  >
                    削除
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </main>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md mx-4">
          <DialogHeader>
            <DialogTitle>{editId ? "罠を編集" : "新しい罠を追加"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-sm">名前・識別番号 *</Label>
              <Input
                className="mt-1"
                placeholder="例: A-01 武甲山北斜面"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm">罠の種類</Label>
                <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as TrapType }))}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="くくり罠">くくり罠</SelectItem>
                    <SelectItem value="箱罠">箱罠</SelectItem>
                    <SelectItem value="囲い罠">囲い罠</SelectItem>
                    <SelectItem value="はこわな（大）">はこわな（大）</SelectItem>
                    <SelectItem value="その他">その他</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-sm">状態</Label>
                <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as TrapStatus }))}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="稼働中">稼働中</SelectItem>
                    <SelectItem value="要確認">要確認</SelectItem>
                    <SelectItem value="撤去済み">撤去済み</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label className="text-sm">設置日</Label>
              <Input
                className="mt-1"
                type="date"
                value={form.installedAt}
                onChange={(e) => setForm((f) => ({ ...f, installedAt: e.target.value }))}
              />
            </div>

            <div>
              <Label className="text-sm">GPS座標</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  placeholder="緯度 (35.xxxx)"
                  value={form.lat}
                  onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value }))}
                  className="font-mono text-sm"
                />
                <Input
                  placeholder="経度 (139.xxxx)"
                  value={form.lng}
                  onChange={(e) => setForm((f) => ({ ...f, lng: e.target.value }))}
                  className="font-mono text-sm"
                />
              </div>
              <Button
                variant="outline"
                className="mt-2 h-8 text-xs w-full"
                onClick={getGPS}
                disabled={gpsLoading}
              >
                {gpsLoading ? "取得中..." : "📍 現在地を取得"}
              </Button>
            </div>

            <div>
              <Label className="text-sm">メモ</Label>
              <Textarea
                className="mt-1 text-sm resize-none"
                rows={3}
                placeholder="獣道の状況、餌の種類、前回確認日など"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter className="mt-2 gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              キャンセル
            </Button>
            <Button
              onClick={handleSave}
              disabled={!form.name.trim()}
              className="bg-stone-800 hover:bg-stone-700 text-white"
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-sm mx-4">
          <DialogHeader>
            <DialogTitle>削除の確認</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-stone-600">
            「{traps.find((t) => t.id === deleteConfirm)?.name}」を削除しますか？この操作は元に戻せません。
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              キャンセル
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
            >
              削除する
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
