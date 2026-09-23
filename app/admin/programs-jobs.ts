/* עבודות על הרבה תוכניות בבת אחת: אורך, תמונות, תמונות קטנות, תיאורים.
   רצות ברקע (אפשר להמשיך לעבוד ולעבור בין החלקים), מתקדמות אחת־אחת, ואפשר
   לעצור באמצע. כל תוצאה נכנסת לטיוטה — ולאתר רק בלחיצה על "פרסום". */

import { createMapStore } from "./programs-core";

export type Job = { running: boolean; stop: boolean; done: number; failed: number; total: number; text: string };
const jobs = createMapStore<Job>();

export const useJob = (name: string) => jobs.useEntry(name);
export const stopJob = (name: string) => { if (jobs.get(name)?.running) jobs.set(name, { stop: true }); };

export async function runJob<T>(name: string, items: T[], work: (item: T) => Promise<void>, { concurrency = 1, what = "תוכניות" }: { concurrency?: number; what?: string }, onMessage: (message: string) => void) {
  if (jobs.get(name)?.running) return;
  const job: Job = { running: true, stop: false, done: 0, failed: 0, total: items.length, text: `0/${items.length}` };
  const paint = () => { job.text = `${job.done}/${job.total}${job.failed ? ` · ${job.failed} נכשלו` : ""}`; jobs.set(name, { ...job, stop: jobs.get(name)?.stop || false }); };
  paint();
  let i = 0;
  const worker = async () => {
    while (i < items.length && !jobs.get(name)?.stop) {
      const item = items[i++];
      try { await work(item); } catch { job.failed++; }
      job.done++; paint();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) || 1 }, worker));
  const stopped = !!jobs.get(name)?.stop;
  job.running = false; paint();
  onMessage(stopped ? `נעצר: ${job.done - job.failed} ${what} עודכנו.` : `הסתיים: ${job.done - job.failed} ${what} עודכנו${job.failed ? `, ${job.failed} נכשלו` : ""}. לחצו „פרסום” כדי שזה יופיע באתר.`);
}
