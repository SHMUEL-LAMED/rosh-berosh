import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const surveys = sqliteTable("surveys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
});

export const albums = sqliteTable("albums", {
  id: text("id").primaryKey(),
  surveyId: text("survey_id").notNull().default("main").references(() => surveys.id),
  title: text("title").notNull(),
  artistName: text("artist_name").notNull(),
  coverUrl: text("cover_url"),
  position: integer("position").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => [index("albums_survey_idx").on(table.surveyId)]);

export const songs = sqliteTable("songs", {
  id: text("id").primaryKey(),
  albumId: text("album_id").notNull().references(() => albums.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  audioUrl: text("audio_url"),
  coverUrl: text("cover_url"),
  previewStart: integer("preview_start").notNull().default(0),
  previewEnd: integer("preview_end").notNull().default(0),
  position: integer("position").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => [index("songs_album_idx").on(table.albumId)]);

export const artists = sqliteTable("artists", {
  id: text("id").primaryKey(),
  surveyId: text("survey_id").notNull().default("main").references(() => surveys.id),
  name: text("name").notNull(),
  imageUrl: text("image_url"),
  position: integer("position").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => [index("artists_survey_idx").on(table.surveyId)]);

export const ballots = sqliteTable("ballots", {
  id: text("id").primaryKey(),
  surveyId: text("survey_id").notNull().default("main").references(() => surveys.id),
  voterKey: text("voter_key").notNull(),
  channel: text("channel").notNull().default("site"),
  fingerprint: text("fingerprint"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex("ballots_voter_survey_unique").on(table.surveyId, table.voterKey),
  index("ballots_survey_created_idx").on(table.surveyId, table.createdAt),
  index("ballots_fingerprint_idx").on(table.fingerprint).where(sql`fingerprint is not null`),
]);

export const albumVotes = sqliteTable("album_votes", {
  ballotId: text("ballot_id").notNull().references(() => ballots.id, { onDelete: "cascade" }),
  albumId: text("album_id").notNull().references(() => albums.id),
}, (table) => [
  uniqueIndex("album_votes_unique").on(table.ballotId, table.albumId),
  index("album_votes_album_idx").on(table.albumId),
]);

export const songVotes = sqliteTable("song_votes", {
  ballotId: text("ballot_id").notNull().references(() => ballots.id, { onDelete: "cascade" }),
  albumId: text("album_id").notNull().references(() => albums.id),
  songId: text("song_id").notNull().references(() => songs.id),
}, (table) => [
  uniqueIndex("song_votes_unique").on(table.ballotId, table.albumId, table.songId),
  index("song_votes_song_idx").on(table.songId),
]);

export const artistVotes = sqliteTable("artist_votes", {
  ballotId: text("ballot_id").notNull().references(() => ballots.id, { onDelete: "cascade" }),
  artistId: text("artist_id").notNull().references(() => artists.id),
}, (table) => [
  uniqueIndex("artist_votes_unique").on(table.ballotId, table.artistId),
  index("artist_votes_artist_idx").on(table.artistId),
]);

export const pollSettings = sqliteTable("poll_settings", {
  id: text("id").primaryKey().default("main"),
  votingOpen: integer("voting_open", { mode: "boolean" }).notNull().default(true),
  albumsEnabled: integer("albums_enabled", { mode: "boolean" }).notNull().default(true),
  albumsMin: integer("albums_min").notNull().default(5),
  albumsMax: integer("albums_max").notNull().default(5),
  songsEnabled: integer("songs_enabled", { mode: "boolean" }).notNull().default(true),
  songsMin: integer("songs_min").notNull().default(1),
  songsMax: integer("songs_max").notNull().default(1),
  artistsEnabled: integer("artists_enabled", { mode: "boolean" }).notNull().default(true),
  artistsMin: integer("artists_min").notNull().default(1),
  artistsMax: integer("artists_max").notNull().default(3),
});

export const ballotRateLimits = sqliteTable("ballot_rate_limits", {
  bucket: text("bucket").primaryKey(),
  count: integer("count").notNull(),
  resetAt: integer("reset_at").notNull(),
}, (table) => [index("ballot_rate_limits_reset_idx").on(table.resetAt)]);

export const ivrRecorders = sqliteTable("ivr_recorders", {
  phone: text("phone").primaryKey(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
});

export const ivrPrompts = sqliteTable("ivr_prompts", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  audioUrl: text("audio_url").notNull(),
  yemotPath: text("yemot_path").notNull().default(""),
  updatedAt: integer("updated_at").notNull(),
});

export const ivrStoreMeta = sqliteTable("ivr_store_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const ivrAdminAudit = sqliteTable("ivr_admin_audit", {
  id: text("id").primaryKey(),
  phone: text("phone").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  status: integer("status").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [index("ivr_admin_audit_created_idx").on(table.createdAt)]);

export const authSessions = sqliteTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userSub: text("user_sub").notNull(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  picture: text("picture"),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [index("auth_sessions_expires_idx").on(table.expiresAt)]);

export const siteBallotProgress = sqliteTable("site_ballot_progress", {
  surveyId: text("survey_id").notNull().references(() => surveys.id, { onDelete: "cascade" }),
  userSub: text("user_sub").notNull(),
  dataJson: text("data_json").notNull(),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex("site_ballot_progress_unique").on(table.surveyId, table.userSub),
  index("site_ballot_progress_updated_idx").on(table.updatedAt),
]);

export const mediaUploads = sqliteTable("media_uploads", {
  id: text("id").primaryKey(),
  surveyId: text("survey_id").notNull().references(() => surveys.id, { onDelete: "cascade" }),
  albumId: text("album_id").notNull().references(() => albums.id, { onDelete: "cascade" }),
  songId: text("song_id").notNull().references(() => songs.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [index("media_uploads_created_idx").on(table.createdAt)]);

export const subscribers = sqliteTable("subscribers", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name"),
  source: text("source").notNull().default("site"),
  surveyId: text("survey_id"),
  userSub: text("user_sub"),
  consentedAt: integer("consented_at").notNull().default(sql`(unixepoch())`),
  unsubscribedAt: integer("unsubscribed_at"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex("subscribers_email_unique").on(table.email),
  index("subscribers_created_idx").on(table.createdAt),
]);
