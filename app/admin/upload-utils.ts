import { unzipSync } from "fflate";

export type UploadFile = { file: File; path: string };

export function fromDirectory(files: FileList | File[]): UploadFile[] {
  return Array.from(files).filter((file) => file.size > 0).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

// Uses fflate for full ZIP-spec coverage (ZIP64, data descriptors, stored/deflate),
// which the previous hand-rolled reader did not handle. Directory entries and macOS
// metadata (__MACOSX, dotfiles) are skipped.
export async function fromZip(zip: File): Promise<UploadFile[]> {
  const bytes = new Uint8Array(await zip.arrayBuffer());
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: (file) => !file.name.endsWith("/") && !file.name.startsWith("__MACOSX/") });
  } catch {
    throw new Error("לא ניתן לפתוח את קובץ ה-ZIP. ייתכן שהוא דחוס בשיטה שאינה נתמכת (למשל Deflate64) או מוגן בסיסמה — נסו לדחוס מחדש כ-ZIP רגיל או להעלות את התיקייה ישירות.");
  }
  const result: UploadFile[] = [];
  for (const [path, data] of Object.entries(entries)) {
    const name = path.split("/").pop() || "file";
    if (!data.length || name.startsWith(".")) continue;
    result.push({ file: new File([new Uint8Array(data).buffer], name, { type: mimeFor(path) }), path });
  }
  return result;
}

export function splitAlbumFiles(files: UploadFile[]) {
  const images = files.filter(({ file, path }) => file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif)$/i.test(path));
  const audio = files.filter(({ file, path }) => file.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(path));
  return { cover: images[0]?.file, audio: audio.map(({ file }) => file) };
}

export async function suggestChorus(url: string): Promise<{ start: number; end: number }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("לא ניתן לנתח את קובץ השמע.");
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    const channel = buffer.getChannelData(0), sampleRate = buffer.sampleRate, seconds = Math.floor(buffer.duration);
    if (seconds <= 35) return { start: 0, end: Math.floor(buffer.duration) };
    const energy: number[] = [];
    for (let second = 0; second < seconds; second++) {
      const from = second * sampleRate, to = Math.min(channel.length, from + sampleRate);
      let sum = 0, count = 0;
      for (let sample = from; sample < to; sample += 16) { sum += channel[sample] * channel[sample]; count++; }
      energy.push(Math.sqrt(sum / Math.max(1, count)));
    }
    const length = Math.min(30, Math.max(18, Math.round(buffer.duration * 0.18)));
    let bestStart = Math.round(buffer.duration * 0.25), bestScore = -1;
    for (let start = Math.round(buffer.duration * 0.18); start + length < buffer.duration * 0.92; start++) {
      const score = energy.slice(start, start + length).reduce((sum, value) => sum + value, 0);
      if (score > bestScore) { bestScore = score; bestStart = start; }
    }
    return { start: bestStart, end: Math.min(Math.floor(buffer.duration), bestStart + length) };
  } finally { await context.close(); }
}

// Converts a recorded audio Blob (e.g. MediaRecorder webm/opus) into a mono
// 16-bit PCM WAV File — a format both the browser and the Yemot phone line accept.
export async function blobToWav(blob: Blob): Promise<File> {
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioCtx();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const length = buffer.length, channels = buffer.numberOfChannels, sampleRate = buffer.sampleRate;
    const mono = new Float32Array(length);
    for (let channel = 0; channel < channels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < length; index++) mono[index] += data[index] / channels;
    }
    const output = new ArrayBuffer(44 + length * 2), view = new DataView(output);
    const writeText = (offset: number, text: string) => { for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index)); };
    writeText(0, "RIFF"); view.setUint32(4, 36 + length * 2, true); writeText(8, "WAVE");
    writeText(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeText(36, "data"); view.setUint32(40, length * 2, true);
    let offset = 44;
    for (let index = 0; index < length; index++) { const sample = Math.max(-1, Math.min(1, mono[index])); view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true); offset += 2; }
    return new File([output], `recording-${Date.now()}.wav`, { type: "audio/wav" });
  } finally { await context.close(); }
}

function mimeFor(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac" } as Record<string, string>)[extension || ""] || "application/octet-stream";
}
