"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type StoredUpload = { id: string; surveyId: string; albumId: string; title: string; position: number; name: string; type: string; file: Blob; createdAt: number };
type Status = "queued" | "uploading" | "retrying" | "waiting" | "error";
type UploadItem = StoredUpload & { percent: number; status: Status; error?: string; attempts: number };

const DB_NAME = "rosh-berosh-admin";
const STORE = "uploads";
// כמה קבצים עולים בבת אחת. שלושה מנצלים את הקו גם בזמן שהשרת שומר קובץ
// שהסתיים, בלי להציף את הדפדפן והוורקר בעשרות בקשות של אלבום שלם.
const PARALLEL = 3;
// ניסיונות לכל קובץ לפני שמבקשים מהמנהל ללחוץ "ניסיון חוזר" (המתנה: 1, 2, 4 שניות).
const ATTEMPTS = 4;
// בקשה שאינה מתקדמת כל כך הרבה זמן נחשבת תקועה: מנותקת ומנוסה שוב.
const STALL_MS = 45_000;
// רענון הקטלוג אחרי שיר שהסתיים מאוחד: לא יותר מפעם בשנייה וחצי, ועוד פעם בסוף.
const REFRESH_MS = 1500;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function stored(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

const online = () => typeof navigator === "undefined" || navigator.onLine !== false;
/** כשל שכדאי לנסות שוב לבד: ניתוק, בקשה שנתקעה, או שגיאת שרת חולפת */
const transient = (status: number) => status === 0 || status >= 500 || status === 408 || status === 429;

export function useUploadQueue({ onCompleted, onMessage }: { onCompleted(): void | Promise<void>; onMessage(message: string): void }) {
  const [items, setItems] = useState<UploadItem[]>([]);
  // A pump tick, bumped whenever an upload leaves the active set. The queue effect
  // depends on it, so the next file starts even when the item list itself did
  // not change in the same render (an upload that failed, say).
  const [pump, setPump] = useState(0);
  // The files uploading right now. A Set rather than a boolean so that several
  // files go up at once, and so a finished file cannot leave a stale lock behind.
  const active = useRef(new Set<string>());
  const refreshTimer = useRef(0);
  const completedRef = useRef(onCompleted);
  const messageRef = useRef(onMessage);
  useEffect(() => { completedRef.current = onCompleted; messageRef.current = onMessage; }, [onCompleted, onMessage]);

  // Catalog refreshes are coalesced: an album of fifteen songs used to reload the
  // whole admin overview fifteen times. Now at most one reload per REFRESH_MS,
  // plus one more when the last file lands.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = 0;
      void Promise.resolve(completedRef.current()).catch(() => undefined);
    }, REFRESH_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(refreshTimer.current), []);

  const start = useCallback((next: UploadItem) => {
    setItems((current) => current.map((item) => item.id === next.id ? { ...item, status: "uploading", percent: 0, error: undefined } : item));
    const form = new FormData();
    form.set("albumId", next.albumId); form.set("kind", "audio"); form.set("file", next.file, next.name);
    form.set("title", next.title); form.set("position", String(next.position)); form.set("uploadId", next.id); form.set("surveyId", next.surveyId);
    const xhr = new XMLHttpRequest();
    let stall = 0, stalled = false;
    const watch = () => { window.clearTimeout(stall); stall = window.setTimeout(() => { stalled = true; xhr.abort(); }, STALL_MS); };
    xhr.open("POST", "/api/admin/media");
    xhr.upload.onprogress = (event) => {
      watch();
      if (!event.lengthComputable) return;
      setItems((current) => current.map((item) => item.id === next.id ? { ...item, percent: Math.round(event.loaded / event.total * 100) } : item));
    };
    // The file leaves the active set before anything else happens — before the
    // IndexedDB delete, before the state update and before the catalog refresh —
    // so nothing that fails afterwards can hold the slot and stall the queue.
    const finish = async (status: Status | "done", error?: string) => {
      window.clearTimeout(stall);
      active.current.delete(next.id);
      if (status === "done") {
        try { await stored("readwrite", (store) => store.delete(next.id)); } catch { /* the server reuses a repeated upload id, so a leftover record is harmless */ }
        setItems((current) => current.filter((item) => item.id !== next.id));
      } else {
        const failed: Status = status;
        setItems((current) => current.map((item) => item.id === next.id ? { ...item, status: failed, error } : item));
      }
      setPump((tick) => tick + 1);
      if (status === "done") scheduleRefresh();
    };
    // A network error, a stalled request or a passing server error is retried by
    // itself with a growing pause; only after ATTEMPTS the file waits for a click.
    const retry = (message: string) => {
      const attempts = next.attempts + 1;
      if (!online()) return void finish("waiting", "ממתין לחיבור מחדש");
      if (attempts >= ATTEMPTS) return void finish("error", `${message} אפשר לנסות שוב.`);
      setItems((current) => current.map((item) => item.id === next.id ? { ...item, attempts } : item));
      void finish("retrying", `${message} מנסים שוב…`);
      window.setTimeout(() => {
        setItems((current) => current.map((item) => item.id === next.id && item.status === "retrying" ? { ...item, status: online() ? "queued" : "waiting" } : item));
        setPump((tick) => tick + 1);
      }, 1000 * 2 ** (attempts - 1));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return void finish("done");
      let error = "העלאת הקובץ נכשלה.";
      try { error = JSON.parse(xhr.responseText).error || error; } catch { /* non-JSON response */ }
      if (transient(xhr.status)) retry(error); else void finish("error", error);
    };
    xhr.onerror = () => retry("שגיאת רשת.");
    xhr.ontimeout = () => retry("ההעלאה נתקעה.");
    xhr.onabort = () => { if (stalled) retry("ההעלאה נתקעה."); else void finish("waiting", "ההעלאה הופסקה ותמשיך בחיבור הבא"); };
    watch();
    xhr.send(form);
  }, [scheduleRefresh]);

  const processQueue = useCallback(() => {
    if (!online()) return;
    for (const next of items) {
      if (active.current.size >= PARALLEL) break;
      if (next.status !== "queued" || active.current.has(next.id)) continue;
      active.current.add(next.id);
      start(next);
    }
  }, [items, start]);

  useEffect(() => {
    void stored("readonly", (store) => store.getAll()).then((records) => setItems((records as StoredUpload[]).map((item) => ({ ...item, percent: 0, attempts: 0, status: online() ? "queued" : "waiting" })))).catch(() => messageRef.current("לא ניתן לשחזר את תור ההעלאות בדפדפן הזה."));
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => processQueue(), 0); return () => window.clearTimeout(timer); }, [processQueue, pump]);
  useEffect(() => {
    const wake = () => { setItems((current) => current.map((item) => item.status === "waiting" ? { ...item, status: "queued", attempts: 0, error: undefined } : item)); setPump((tick) => tick + 1); };
    window.addEventListener("online", wake);
    return () => window.removeEventListener("online", wake);
  }, []);

  const enqueue = useCallback(async (surveyId: string, albumId: string, files: Array<{ file: File; position: number }>) => {
    const records: StoredUpload[] = files.map(({ file, position }) => ({ id: crypto.randomUUID(), surveyId, albumId, title: file.name.replace(/\.[^.]+$/, "").replace(/^\d+[\s._-]*/, ""), position, name: file.name, type: file.type, file, createdAt: Date.now() }));
    await Promise.all(records.map((record) => stored("readwrite", (store) => store.put(record))));
    setItems((current) => [...current, ...records.map((item): UploadItem => ({ ...item, percent: 0, attempts: 0, status: online() ? "queued" : "waiting" }))]);
    messageRef.current(`${records.length} קבצים נוספו לתור ההעלאות.`);
  }, []);

  const retry = (id: string) => { setItems((current) => current.map((item) => item.id === id ? { ...item, status: online() ? "queued" : "waiting", attempts: 0, error: undefined } : item)); setPump((tick) => tick + 1); };
  const remove = async (id: string) => { await stored("readwrite", (store) => store.delete(id)); setItems((current) => current.filter((item) => item.id !== id)); setPump((tick) => tick + 1); };

  const uploading = items.filter((item) => item.status === "uploading").length;
  const label = (item: UploadItem) => item.status === "uploading" ? `${item.percent}%` : item.status === "retrying" ? item.error || "מנסים שוב…" : item.status === "waiting" ? item.error || "ממתין לחיבור" : item.status === "error" ? item.error : "ממתין בתור";
  const panel = items.length ? <section className="upload-queue"><header><h3>תור העלאות</h3><span>{items.length} קבצים{uploading > 1 ? ` · ${uploading} עולים עכשיו` : ""}</span></header>{items.map((item) => <article key={item.id}><div><b>{item.title}</b><small>{label(item)}</small></div><progress max="100" value={item.percent} />{item.status === "error" && <button onClick={() => retry(item.id)}>ניסיון חוזר</button>}<button className="queue-remove" onClick={() => void remove(item.id)}>הסרה</button></article>)}</section> : null;
  return { enqueue, panel, hasPending: items.length > 0 };
}
