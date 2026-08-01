import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { surveys, votes } from "../../../db/schema";

export async function POST(request: Request) {
  const body = await request.json() as Record<string, unknown>;
  const surveyId = String(body.surveyId ?? "");
  const voterKey = String(body.voterKey ?? "").trim();
  const answers = Array.isArray(body.answers) ? body.answers.map(String) : [];
  if (!surveyId || !voterKey || answers.length === 0) return Response.json({ error: "חסרים פרטי הצבעה." }, { status: 400 });
  const db = await getDb();
  const [survey] = await db.select().from(surveys).where(eq(surveys.id, surveyId)).limit(1);
  if (!survey || survey.status !== "published") return Response.json({ error: "הסקר אינו פתוח להצבעה." }, { status: 404 });
  try {
    await db.insert(votes).values({ id: crypto.randomUUID(), surveyId, voterKey, answersJson: JSON.stringify(answers), channel: "site" });
  } catch {
    return Response.json({ error: "כבר הצבעת בסקר הזה." }, { status: 409 });
  }
  return Response.json({ ok: true }, { status: 201 });
}
