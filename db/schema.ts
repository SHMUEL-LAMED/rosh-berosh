import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const albums = sqliteTable("albums", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  artistName: text("artist_name").notNull(),
  coverUrl: text("cover_url"),
  position: integer("position").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const songs = sqliteTable("songs", {
  id: text("id").primaryKey(),
  albumId: text("album_id").notNull().references(() => albums.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  audioUrl: text("audio_url"),
  position: integer("position").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => [index("songs_album_idx").on(table.albumId)]);

export const artists = sqliteTable("artists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  imageUrl: text("image_url"),
  position: integer("position").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const ballots = sqliteTable("ballots", {
  id: text("id").primaryKey(),
  voterKey: text("voter_key").notNull(),
  channel: text("channel").notNull().default("site"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [uniqueIndex("ballots_voter_unique").on(table.voterKey)]);

export const albumVotes = sqliteTable("album_votes", {
  ballotId: text("ballot_id").notNull().references(() => ballots.id, { onDelete: "cascade" }),
  albumId: text("album_id").notNull().references(() => albums.id),
}, (table) => [uniqueIndex("album_votes_unique").on(table.ballotId, table.albumId)]);

export const songVotes = sqliteTable("song_votes", {
  ballotId: text("ballot_id").notNull().references(() => ballots.id, { onDelete: "cascade" }),
  albumId: text("album_id").notNull().references(() => albums.id),
  songId: text("song_id").notNull().references(() => songs.id),
}, (table) => [uniqueIndex("song_votes_album_unique").on(table.ballotId, table.albumId)]);

export const artistVotes = sqliteTable("artist_votes", {
  ballotId: text("ballot_id").notNull().references(() => ballots.id, { onDelete: "cascade" }),
  artistId: text("artist_id").notNull().references(() => artists.id),
}, (table) => [uniqueIndex("artist_votes_unique").on(table.ballotId, table.artistId)]);
