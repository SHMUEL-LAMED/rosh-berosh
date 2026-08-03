export type UploadFile = { file: File; path: string };

export function fromDirectory(files: FileList | File[]): UploadFile[] {
  return Array.from(files).filter((file) => file.size > 0).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

export async function fromZip(zip: File): Promise<UploadFile[]> {
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
    if (view.getUint32(index, true) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("קובץ ה־ZIP אינו תקין.");
  const entries = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const result: UploadFile[] = [];
  for (let index = 0; index < entries; index++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("מבנה ZIP אינו נתמך.");
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const path = new TextDecoder().decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith("/") || path.startsWith("__MACOSX/")) continue;
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("רשומת ZIP פגומה.");
    const localNameLength = view.getUint16(localOffset + 26, true), localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(start, start + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = compressed;
    else if (method === 8) {
      const stream = new Blob([new Uint8Array(compressed).buffer]).stream().pipeThrough(new DecompressionStream("deflate-raw" as "deflate"));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error(`שיטת דחיסה ${method} אינה נתמכת.`);
    if (uncompressedSize && data.length !== uncompressedSize) throw new Error(`הקובץ ${path} לא חולץ בשלמותו.`);
    result.push({ file: new File([new Uint8Array(data).buffer], path.split("/").pop() || "file", { type: mimeFor(path) }), path });
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

function mimeFor(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac" } as Record<string, string>)[extension || ""] || "application/octet-stream";
}
