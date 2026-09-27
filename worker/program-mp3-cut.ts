/** Lossless MP3 frame cutter. The source is read in bounded R2 ranges and never overwritten.
 * All frame timestamps are measured from MPEG samples, so VBR files do not drift. */
export type Cut = { start: number; end: number };
export function validateCuts(input: unknown, duration: number): Cut[] {
  if (!Array.isArray(input) || !input.length || input.length > 30 || !Number.isFinite(duration) || duration <= 0) throw Error('קטעי החיתוך אינם תקינים.');
  const cuts = input.map((item) => ({ start: Number(item?.start), end: Number(item?.end) })).sort((a, b) => a.start - b.start);
  if (cuts.some((c, i) => !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0 || c.end > duration + 2 || c.end - c.start < .2 || (i > 0 && c.start < cuts[i - 1].end))) throw Error('זמני החיתוך חופפים או חורגים מאורך ההקלטה.');
  if (cuts.reduce((sum, c) => sum + c.end - c.start, 0) >= duration - 1) throw Error('אי אפשר להסיר את כל התוכנית.');
  return cuts;
}
export function mp3Frame(bytes: Uint8Array, at: number): { length: number; seconds: number } | null {
  if (at + 4 > bytes.length || bytes[at] !== 255 || (bytes[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[at + 1] >> 3) & 3, layer = (bytes[at + 1] >> 1) & 3;
  const bitrateIndex = bytes[at + 2] >> 4, rateIndex = (bytes[at + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3) return null;
  const rates = [44100, 48000, 32000];
  const rate = Math.round(rates[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4));
  const bitrates = version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor((version === 3 ? 144 : 72) * bitrates[bitrateIndex] * 1000 / rate) + ((bytes[at + 2] >> 1) & 1);
  return length >= 24 && length <= 2048 ? { length, seconds: samples / rate } : null;
}
export async function cutMp3(media: R2Bucket, sourceKey: string, size: number, cuts: Cut[], destinationKey: string) {
  const upload = await media.createMultipartUpload(destinationKey, { httpMetadata: { contentType: 'audio/mpeg', cacheControl: 'public, max-age=31536000, immutable' } });
  const partSize = 8 * 1024 * 1024, readSize = 2 * 1024 * 1024;
  const buffer = new Uint8Array(partSize + 2048);
  const parts: Array<{ partNumber: number; etag: string }> = [];
  let firstPart: Uint8Array | null = null, xingOffset = -1, keptFrames = 0, keptBytes = 0;
  let used = 0, offset = 0, carry = new Uint8Array(0), seconds = 0, frames = 0, skipped = 0, cutIndex = 0, desync = 0;
  try {
    while (offset < size) {
      const length = Math.min(readSize, size - offset);
      const object = await media.get(sourceKey, { range: { offset, length } });
      if (!object) throw Error('קובץ המקור אינו זמין.');
      const incoming = new Uint8Array(await object.arrayBuffer());
      if (incoming.length !== length) throw Error('קריאת ההקלטה נקטעה.');
      const chunk = new Uint8Array(carry.length + incoming.length);
      chunk.set(carry); chunk.set(incoming, carry.length);
      offset += length;
      let pos = 0;
      // Skip ID3v2 tag at file start. Preserve no stale duration metadata in edited file.
      if (offset === length && chunk.length >= 10 && String.fromCharCode(...chunk.subarray(0, 3)) === 'ID3') {
        const tagSize = ((chunk[6] & 127) << 21) | ((chunk[7] & 127) << 14) | ((chunk[8] & 127) << 7) | (chunk[9] & 127);
        if (tagSize + 10 > readSize) throw Error('תג MP3 גדול מדי.');
        pos = tagSize + 10;
      }
      while (pos + 4 <= chunk.length) {
        const frame = mp3Frame(chunk, pos);
        if (!frame || pos + frame.length > chunk.length) {
          if (frame && offset < size) break;
          // Allow an ID3v1 trailer, but never silently edit a corrupt stream.
          if (offset === size && chunk.length - pos <= 128 && String.fromCharCode(...chunk.subarray(pos, pos + 3)) === 'TAG') { pos = chunk.length; break; }
          if (++desync > (frames ? 4096 : 65536)) throw Error('מבנה ה־MP3 פגום או שההקלטה אינה MP3.');
          pos++; continue;
        }
        desync = 0;
        const start = seconds, end = seconds + frame.seconds;
        while (cutIndex < cuts.length && cuts[cutIndex].end <= start) cutIndex++;
        const remove = cutIndex < cuts.length && cuts[cutIndex].start < end && cuts[cutIndex].end > start;
        // LAME/Xing/VBRI seek headers contain the source's old frame count.
        // Keeping one makes players show the unedited duration after a cut.
        const firstFrame = frames === 0 ? chunk.subarray(pos, pos + frame.length) : null;
        const seekHeader = !!firstFrame && ['Xing', 'Info'].some((tag) => {
          const code = [...tag].map((c) => c.charCodeAt(0));
          return firstFrame.some((byte, at) => {
            if (byte !== code[0] || !code.every((value, i) => firstFrame[at + i] === value)) return false;
            xingOffset = used + at; return true;
          });
        });
        if (remove && !seekHeader) skipped++; else {
          buffer.set(chunk.subarray(pos, pos + frame.length), used); used += frame.length;
          keptBytes += frame.length; keptFrames++;
          if (used >= partSize) {
            if (!firstPart) { firstPart = buffer.slice(0, used); parts.push({ partNumber: 1, etag: '' }); }
            else parts.push(await upload.uploadPart(parts.length + 1, buffer.slice(0, used)));
            used = 0;
          }
        }
        seconds = end; frames++; pos += frame.length;
      }
      carry = chunk.slice(pos);
      if (carry.length > 65536) throw Error('לא ניתן לפענח את קובץ ה־MP3.');
    }
    if (!frames || !skipped || !used && !parts.length) throw Error('לא נמצאו מסגרות שמע בתחום שנבחר.');
    if (used) {
      if (!firstPart) { firstPart = buffer.slice(0, used); parts.push({ partNumber: 1, etag: '' }); }
      else parts.push(await upload.uploadPart(parts.length + 1, buffer.slice(0, used)));
    }
    if (!firstPart) throw Error('ההקלטה הערוכה ריקה.');
    if (xingOffset >= 0 && xingOffset + 16 <= firstPart.length) {
      const view = new DataView(firstPart.buffer, firstPart.byteOffset, firstPart.byteLength);
      // The old TOC and duration refer to the original file. Keep only the
      // updated frame/byte counters; players use these for accurate VBR length.
      view.setUint32(xingOffset + 4, 3);
      view.setUint32(xingOffset + 8, keptFrames);
      view.setUint32(xingOffset + 12, keptBytes);
    }
    parts[0] = await upload.uploadPart(1, firstPart);
    await upload.complete(parts);
    return { duration: seconds, removedSeconds: cuts.reduce((sum, c) => sum + c.end - c.start, 0), frames, skipped };
  } catch (error) { await upload.abort().catch(() => {}); throw error; }
}
