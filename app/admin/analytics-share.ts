/**
 * ציור תמונת שיתוף על קנבס. הכול נעשה בדפדפן ובלי שום תלות: אין כאן
 * צילום מסך אלא ציור מחדש של עשרת המובילים, כדי שהתמונה תצא באותה איכות
 * בכל מסך ותתאים לוואטסאפ ולסטורי.
 *
 * עברית על קנבס דורשת כיוון מפורש — `ctx.direction` — כי הקנבס אינו יורש
 * את כיוון המסמך, ובלעדיו סימני פיסוק ומספרים היו קופצים לצד הלא נכון.
 */

export type ShareRow = { place: number; title: string; subtitle?: string; value: string; fill: number };
export type ShareOptions = { title: string; kicker: string; footer: string; rows: ShareRow[]; shape?: "post" | "story" };

const BACKGROUND = "#0b0d1c";
const GOLD = "#c4952e";
const GOLD_LIGHT = "#e0cd82";
const INK = "#f8f7ff";
const MUTED = "#a9b0c6";
const TEAL = "#5fe0c8";

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/** מקצר לפי רוחב אמיתי ולא לפי מספר תווים, כדי ששום שם לא ייחתך באמצע. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export function drawShareImage(options: ShareOptions): HTMLCanvasElement {
  const story = options.shape === "story";
  const width = 1080, height = story ? 1920 : 1350;
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.scale(scale, scale);
  ctx.direction = "rtl";
  ctx.textBaseline = "middle";
  const family = '"Heebo", "Assistant", system-ui, -apple-system, "Segoe UI", sans-serif';

  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(width * 0.8, 0, 0, width * 0.8, 0, width);
  glow.addColorStop(0, "rgba(196,149,46,.28)");
  glow.addColorStop(1, "rgba(196,149,46,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  const margin = 72;
  const right = width - margin;
  ctx.textAlign = "right";
  ctx.fillStyle = GOLD_LIGHT;
  ctx.font = `600 26px ${family}`;
  ctx.fillText(options.kicker, right, margin + 14);
  ctx.fillStyle = INK;
  ctx.font = `800 74px ${family}`;
  ctx.fillText(options.title, right, margin + 82);

  const rows = options.rows.slice(0, story ? 10 : 10);
  const top = margin + 150;
  const available = height - top - margin - 56;
  const gap = 12;
  const rowHeight = Math.min(110, (available - gap * (rows.length - 1)) / Math.max(1, rows.length));
  const fontScale = Math.min(1, rowHeight / 96);

  rows.forEach((row, index) => {
    const y = top + index * (rowHeight + gap);
    ctx.fillStyle = "rgba(255,255,255,.05)";
    roundedRect(ctx, margin, y, width - margin * 2, rowHeight, 20);
    ctx.fill();

    // הפס גדל מצד הכותרת, כלומר מימין, ככיוון הקריאה.
    const fillWidth = Math.max(6, (width - margin * 2) * Math.max(0, Math.min(1, row.fill)));
    const bar = ctx.createLinearGradient(right, 0, right - fillWidth, 0);
    bar.addColorStop(0, index === 0 ? "rgba(224,205,130,.55)" : "rgba(196,149,46,.34)");
    bar.addColorStop(1, "rgba(196,149,46,.05)");
    ctx.save();
    roundedRect(ctx, margin, y, width - margin * 2, rowHeight, 20);
    ctx.clip();
    ctx.fillStyle = bar;
    ctx.fillRect(right - fillWidth, y, fillWidth, rowHeight);
    ctx.restore();

    const badgeRadius = rowHeight * 0.3;
    const badgeX = right - 34 - badgeRadius;
    ctx.beginPath();
    ctx.arc(badgeX, y + rowHeight / 2, badgeRadius, 0, Math.PI * 2);
    ctx.fillStyle = index === 0 ? GOLD : "#252a46";
    ctx.fill();
    ctx.fillStyle = index === 0 ? "#1a1810" : INK;
    ctx.font = `800 ${Math.round(34 * fontScale)}px ${family}`;
    ctx.textAlign = "center";
    ctx.fillText(String(row.place), badgeX, y + rowHeight / 2 + 2);

    ctx.textAlign = "right";
    const textRight = badgeX - badgeRadius - 22;
    const valueWidth = 190 * fontScale;
    const maxTitle = textRight - margin - valueWidth - 20;
    ctx.fillStyle = INK;
    ctx.font = `700 ${Math.round(38 * fontScale)}px ${family}`;
    ctx.fillText(fit(ctx, row.title, maxTitle), textRight, y + rowHeight / 2 - (row.subtitle ? 15 : 0));
    if (row.subtitle) {
      ctx.fillStyle = MUTED;
      ctx.font = `400 ${Math.round(25 * fontScale)}px ${family}`;
      ctx.fillText(fit(ctx, row.subtitle, maxTitle), textRight, y + rowHeight / 2 + 20);
    }
    ctx.textAlign = "left";
    ctx.fillStyle = TEAL;
    ctx.font = `800 ${Math.round(36 * fontScale)}px ${family}`;
    ctx.fillText(row.value, margin + 26, y + rowHeight / 2);
    ctx.textAlign = "right";
  });

  ctx.fillStyle = MUTED;
  ctx.font = `400 24px ${family}`;
  ctx.fillText(options.footer, right, height - margin + 6);
  return canvas;
}

export function downloadShareImage(options: ShareOptions, filename: string): void {
  const canvas = drawShareImage(options);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }, "image/png");
}
