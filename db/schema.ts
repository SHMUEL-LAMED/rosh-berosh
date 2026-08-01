import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const surveys = sqliteTable("surveys", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  type: text("type").notNull().default("single"),
  status: text("status").notNull().default("draft"),
  question: text("question").notNull(),
  optionsJson: text("options_json").notNull(),
  channelsJson: text("channels_json").notNull().default('["site"]'),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
}, (table) => [index("surveys_status_idx").on(table.status)]);

export const votes = sqliteTable("votes", {
  id: text("id").primaryKey(),
  surveyId: text("survey_id").notNull().references(() => surveys.id, { onDelete: "cascade" }),
  voterKey: text("voter_key").notNull(),
  answersJson: text("answers_json").notNull(),
  channel: text("channel").notNull().default("site"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex("votes_survey_voter_unique").on(table.surveyId, table.voterKey),
  index("votes_survey_idx").on(table.surveyId),
]);
