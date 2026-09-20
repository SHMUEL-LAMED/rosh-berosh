/** צורת התשובה של GET /api/admin/analytics. משותף לשרת (worker/analytics.ts) וללשונית "נתונים מתקדמים". */
export type RankedItem = { id: string; title: string; subtitle?: string; votes: number; site: number; phone: number; share: number; place: number; sitePlace: number; phonePlace: number; gapAbove: number | null; gapBelow: number | null };
export type AlbumBreakdown = { id: string; title: string; artistName: string; coverUrl?: string | null; votes: number; songs: Array<{ id: string; title: string; votes: number; share: number }>; topSong: { id: string; title: string; votes: number; share: number } | null; songVotes: number; concentration: number };
export type DurationSummary = { count: number; average: number; median: number; p25: number; p75: number; p90: number; min: number; max: number; total: number };
export type StageDurations = { albums: DurationSummary; songs: DurationSummary; artists: DurationSummary; summary: DurationSummary };
export type ShareBucket = { label: string; count: number; share: number };
export type ChannelTiming = { overall: DurationSummary; stages: StageDurations; distribution: ShareBucket[]; sessions: ShareBucket[]; fastest: number; slowest: number };
export type NamedItem = { id: string; title: string; subtitle?: string };
export type ZeroVoteItem = NamedItem & { active: number };
export type DailyPoint = { bucket: number; site: number; phone: number; total: number; cumulative: number };
export type AuditRow = { id: string; phone: string; action: string; target?: string | null; status: number; createdAt: number };

/** קצב: חלון זמן, כמה הצבעות נכנסו בו, והשוואה לחלון הקודם באותו אורך. */
export type PaceWindow = { label: string; seconds: number; votes: number; site: number; phone: number; previous: number; changePercent: number | null };
/** מרוץ הדירוג: לכל פריט מוביל, הקולות המצטברים שלו בסוף כל יום. */
export type RaceSeries = { id: string; title: string; points: Array<{ bucket: number; cumulative: number }>; finalPlace: number };
export type Concentration = { index: number; gini: number; topFiveShare: number; itemsForHalf: number; leadPercent: number | null };
export type PositionBias = { correlation: number | null; items: number; verdict: "none" | "weak" | "clear" };
export type AbandonedStage = { stage: number; label: string; count: number; oldestAt: number | null; newestAt: number | null };
export type SurveyComparison = { id: string; name: string; total: number; firstAt: number | null; atSameElapsed: number | null };

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
  timing: { all: ChannelTiming; site: ChannelTiming; phone: ChannelTiming; untracked: number; sampled: boolean; sampleSize: number };
  daily: { series: DailyPoint[]; peak: DailyPoint | null; peakHour: { weekday: number; hour: number; votes: number } | null };
  /** תאים לפי יום בשבוע (0=ראשון) על שעה מקומית, בשעון ישראל. */
  activity: { cells: number[][]; site: number[][]; phone: number[][]; max: number };
  pace: { windows: PaceWindow[]; perDay: number; quietHours: number | null };
  race: { albums: RaceSeries[]; artists: RaceSeries[] };
  concentration: { albums: Concentration; artists: Concentration; songs: Concentration };
  positionBias: { albums: PositionBias; artists: PositionBias; songs: PositionBias };
  abandoned: { site: AbandonedStage[]; siteTotal: number; phoneTotal: number; phoneTruncated: boolean; completionRate: number | null };
  returning: { voters: number; share: number; surveys: SurveyComparison[]; previous: SurveyComparison | null };
  subscribers: { total: number; fromThisSurvey: number; share: number };
  stageDropoff: Array<{ id: string; title: string; albumVotes: number; withoutSong: number; share: number }>;
  blocked: Array<{ fingerprint: string; blockedBy: string; createdAt: number; ballots: number; lastBallotAt: number | null }>;
  audit: { recent: AuditRow[]; last30Days: { total: number; failed: number } };
  content: { songsWithoutAudio: NamedItem[]; songsWithoutPreview: NamedItem[]; albumsWithoutCover: NamedItem[]; artistsWithoutImage: NamedItem[]; missingPrompts: NamedItem[]; inactive: { albums: number; songs: number; artists: number } };
};
