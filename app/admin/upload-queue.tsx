"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type StoredUpload = { id: string; surveyId: string; albumId: string; title: string; position: number; name: string; type: string; file: Blob; createdAt: number };
type UploadItem = StoredUpload & { percent: number; status: "queued" | "uploading" | "waiting" | "error"; error?: string };

const DB_NAME = "rosh-berosh-admin";
const STORE = "uploads";

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

export function useUploadQueue({ onCompleted, onMessage }: { onCompleted(): void | Promise<void>; onMessage(message: string): void }) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const processing = useRef(false);
  const completedRef = useRef(onCompleted);
  const messageRef = useRef(onMessage);
  useEffect(() => { completedRef.current = onCompleted; messageRef.current = onMessage; }, [onCompleted, onMessage]);

  const processQueue = useCallback(async () => {
    if (processing.current || !navigator.onLine) return;
    const next = items.find((item) => item.status === "queued" || item.status === "waiting");
    if (!next) return;
    processing.current = true;
    setItems((current) => current.map((item) => item.id === next.id ? { ...item, status: "uploading", percent: 0, error: undefined } : item));
    const form = new FormData();
    form.set("albumId", next.albumId); form.set("kind", "audio"); form.set("file", next.file, next.name);
    form.set("title", next.title); form.set("position", String(next.position)); form.set("uploadId", next.id); form.set("surveyId", next.surveyId);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/admin/media");
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      setItems((current) => current.map((item) => item.id === next.id ? { ...item, percent: Math.round(event.loaded / event.total * 100) } : item));
    };
    const finish = async (status: UploadItem["status"], error?: string) => {
      if (status === "queued") {
        await stored("readwrite", (store) => store.delete(next.id));
        setItems((current) => current.filter((item) => item.id !== next.id));
        await completedRef.current();
      } else {
        setItems((current) => current.map((item) => item.id === next.id ? { ...item, status, error } : item));
      }
      processing.current = false;
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) void finish("queued");
      else {
        let error = "העלאת הקובץ נכשלה.";
        try { error = JSON.parse(xhr.responseText).error || error; } catch { /* non-JSON response */ }
        void finish("error", error);
      }
    };
    xhr.onerror = () => void finish(navigator.onLine ? "error" : "waiting", navigator.onLine ? "שגיאת רשת. אפשר לנסות שוב." : "ממתין לחיבור מחדש");
    xhr.onabort = () => void finish("waiting", "ההעלאה הופסקה ותמשיך בחיבור הבא");
    xhr.send(form);
  }, [items]);

  useEffect(() => {
    void stored("readonly", (store) => store.getAll()).then((records) => setItems((records as StoredUpload[]).map((item) => ({ ...item, percent: 0, status: navigator.onLine ? "queued" : "waiting" })))).catch(() => messageRef.current("לא ניתן לשחזר את תור ההעלאות בדפדפן הזה."));
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void processQueue(), 0); return () => window.clearTimeout(timer); }, [processQueue]);
  useEffect(() => {
    const online = () => setItems((current) => current.map((item) => item.status === "waiting" ? { ...item, status: "queued", error: undefined } : item));
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);

  const enqueue = useCallback(async (surveyId: string, albumId: string, files: Array<{ file: File; position: number }>) => {
    const records: StoredUpload[] = files.map(({ file, position }) => ({ id: crypto.randomUUID(), surveyId, albumId, title: file.name.replace(/\.[^.]+$/, "").replace(/^\d+[\s._-]*/, ""), position, name: file.name, type: file.type, file, createdAt: Date.now() }));
    await Promise.all(records.map((record) => stored("readwrite", (store) => store.put(record))));
    setItems((current) => [...current, ...records.map((item): UploadItem => ({ ...item, percent: 0, status: navigator.onLine ? "queued" : "waiting" }))]);
    messageRef.current(`${records.length} קבצים נוספו לתור ההעלאות.`);
  }, []);

  const retry = (id: string) => setItems((current) => current.map((item) => item.id === id ? { ...item, status: navigator.onLine ? "queued" : "waiting", error: undefined } : item));
  const remove = async (id: string) => { await stored("readwrite", (store) => store.delete(id)); setItems((current) => current.filter((item) => item.id !== id)); };

  const panel = items.length ? <section className="upload-queue"><header><h3>תור העלאות</h3><span>{items.length} קבצים</span></header>{items.map((item) => <article key={item.id}><div><b>{item.title}</b><small>{item.status === "uploading" ? `${item.percent}%` : item.status === "waiting" ? "ממתין לחיבור" : item.status === "error" ? item.error : "ממתין בתור"}</small></div><progress max="100" value={item.percent} />{item.status === "error" && <button onClick={() => retry(item.id)}>ניסיון חוזר</button>}<button className="queue-remove" onClick={() => void remove(item.id)}>הסרה</button></article>)}</section> : null;
  return { enqueue, panel, hasPending: items.length > 0 };
}
