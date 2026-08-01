import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { surveys, votes } from "../../../db/schema";

const parse = (value: string) => {
  try { return JSON.parse(value); } catch { return []; }
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const onlyPublished = url.searchParams.get("published") === "1";
  const db = await getDb();
  const rows = await db.select({
    id: surveys.id,
    title: surveys.title,
    description: surveys.description,
    type: surveys.type,
    status: surveys.status,
    question: surveys.question,
    optionsJson: surveys.optionsJson,
    channelsJson: surveys.channelsJson,
    createdAt: surveys.createdAt,
    votesCount: sql<number>`count(${votes.id})`,
  }).from(surveys).leftJoin(votes, eq(surveys.id, votes.surveyId))
    .where(onlyPublished ? eq(surveys.status, "published") : undefined)
    .groupBy(surveys.id).orderBy(desc(surveys.createdAt));

  return Response.json({ surveys: rows.map((row) => ({
    ...row, options: parse(row.optionsJson), channels: parse(row.channelsJson),
  })) });
}

export async function POST(request: Request) {
  const body = await request.json() as Record<string, unknown>;
  const title = String(body.title ?? "").trim();
  const question = String(body.question ?? "").trim();
  const options = Array.isArray(body.options) ? body.options.map(String).map((v) => v.trim()).filter(Boolean) : [];
  const channels = Array.isArray(body.channels) ? body.channels.map(String) : ["site"];
  const type = ["single", "multiple", "ranking"].includes(String(body.type)) ? String(body.type) : "single";
  const status = body.status === "published" ? "published" : "draft";
  if (!title || !question || options.length < 2) return Response.json({ error: "יש למלא שם, שאלה ולפחות שתי תשובות." }, { status: 400 });

  const id = crypto.randomUUID();
  const db = await getDb();
  await db.insert(surveys).values({ id, title, question, type, status, optionsJson: JSON.stringify(options), channelsJson: JSON.stringify(channels) });
  return Response.json({ id }, { status: 201 });
}
