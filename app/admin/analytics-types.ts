/** צורת התשובה של GET /api/admin/analytics. משותף לשרת (worker/analytics.ts) וללשונית "נתונים מתקדמים". */
export type RankedItem = { id: string; title: string; subtitle?: string; votes: number; site: number; phone: number; share: number; place: number; sitePlace: number; phonePlace: number; gapAbove: number | null; gapBelow: number | null };
export type AlbumBreakdown = { id: string; title: string; artistName: string; coverUrl?: string | null; votes: number; songs: Array<{ id: string; title: string; votes: number; share: number }>; topSong: { id: string; title: string; votes: number; share: number } | null; songVotes: number; concentration: number };
export type DurationSummary = { count: number; average: number; median: number; total: number };
export type StageDurations = { albums: DurationSummary; songs: DurationSummary; artists: DurationSummary; summary: DurationSummary };
export type ShareBucket = { label: string; count: number; share: number };
export type ChannelTiming = { overall: DurationSummary; stages: StageDurations; distribution: ShareBucket[]; sessions: ShareBucket[]; fastest: number; slowest: number };
export type NamedItem = { id: string; title: string; subtitle?: string };
export type ZeroVoteItem = NamedItem & { active: number };
export type DailyPoint = { bucket: number; site: number; phone: number; total: number; cumulative: number };
export type AuditRow = { id: string; phone: string; action: string; target?: string | null; status: number; createdAt: number };

export type Analytics = {
  generatedAt: number;
  totals: { ballots: number; site: number; phone: number; firstAt: number | null; lastAt: number | null; albums: number; songs: number; artists: number };
  rankings: { albums: RankedItem[]; songs: RankedItem[]; artists: RankedItem[] };
  albumBreakdown: AlbumBreakdown[];
  zeroVotes: { albums: ZeroVoteItem[]; songs: ZeroVoteItem[]; artists: ZeroVoteItem[] };
  artistAlbums: Array<{ id: string; name: string; votes: number; top: Array<{ id: string; title: string; votes: number; share: number }>; own: Array<{ id: string; title: string; albumVotes: number; both: number; ofArtistVoters: number; ofAlbumVoters: number }> }>;
  albumCompanions: Array<{ id: string; title: string; votes: number; top: Array<{ id: string; title: string; votes: number; share: number }> }>;
  artistPairs: Array<{ a: string; b: string; votes: number; shareOfA: number; shareOfB: number }>;
  combos: { top: Array<{ albums: string[]; votes: number; share: number }>; distinct: number; repeated: number };
  timing: { all: ChannelTiming; site: ChannelTiming; phone: ChannelTiming; untracked: number };
  daily: { series: DailyPoint[]; peak: DailyPoint | null };
  blocked: Array<{ fingerprint: string; blockedBy: string; createdAt: number; ballots: number; lastBallotAt: number | null }>;
  audit: { recent: AuditRow[]; last30Days: { total: number; failed: number } };
  content: { songsWithoutAudio: NamedItem[]; songsWithoutPreview: NamedItem[]; albumsWithoutCover: NamedItem[]; artistsWithoutImage: NamedItem[]; missingPrompts: NamedItem[]; inactive: { albums: number; songs: number; artists: number } };
};
