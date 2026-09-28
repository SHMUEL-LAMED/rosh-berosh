/* בניית אתר התוכניות עכשיו: דפי השיתוף לוואטסאפ, מפת האתר לגוגל ועותק הקטלוג באתר נבנים ב־GitHub
   Actions (pages.yml במאגר rosh-berosh-2) — בכל דחיפה ופעם ביום בלילה. מכאן אפשר להפעיל את אותה
   בנייה מיד, ולראות מתי רצה בפעם האחרונה ואיך הסתיימה. צריך טוקן של GitHub (GITHUB_TOKEN בסביבת
   Cloudflare) עם הרשאת Actions: Read and write למאגר של אתר התוכניות; בלעדיו הכפתור מסביר מה חסר. */

export type SiteBuildEnv = { GITHUB_TOKEN?: string; PROGRAM_SITE_REPO?: string };
export const DEFAULT_SITE_REPO = "SHMUEL-LAMED/rosh-berosh-2";
export const SITE_WORKFLOW = "pages.yml";

const repoOf = (env: SiteBuildEnv) => (/^[\w.-]+\/[\w.-]+$/.test(env.PROGRAM_SITE_REPO || "") ? env.PROGRAM_SITE_REPO! : DEFAULT_SITE_REPO);
const headers = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "rosh-berosh-worker" });

export type SiteBuildRun = { status: string; conclusion: string | null; event: string; createdAt: string; updatedAt: string; url: string };
export type SiteBuildState = { configured: boolean; repo: string; last: SiteBuildRun | null; error?: string };

/** הריצה האחרונה של בניית האתר */
export async function siteBuildState(env: SiteBuildEnv, fetcher: typeof fetch = fetch): Promise<SiteBuildState> {
  const repo = repoOf(env);
  if (!env.GITHUB_TOKEN) return { configured: false, repo, last: null };
  try {
    const response = await fetcher(`https://api.github.com/repos/${repo}/actions/workflows/${SITE_WORKFLOW}/runs?per_page=1`, { headers: headers(env.GITHUB_TOKEN) });
    if (!response.ok) return { configured: true, repo, last: null, error: githubError(response.status) };
    const body = await response.json() as { workflow_runs?: Array<{ status: string; conclusion: string | null; event: string; created_at: string; updated_at: string; html_url: string }> };
    const run = body.workflow_runs?.[0];
    return { configured: true, repo, last: run ? { status: run.status, conclusion: run.conclusion, event: run.event, createdAt: run.created_at, updatedAt: run.updated_at, url: run.html_url } : null };
  } catch {
    return { configured: true, repo, last: null, error: "אין חיבור ל־GitHub כרגע." };
  }
}

/** מפעיל את בניית האתר עכשיו. מחזיר שגיאה בעברית, או null כשההפעלה התקבלה. */
export async function triggerSiteBuild(env: SiteBuildEnv, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!env.GITHUB_TOKEN) return "הבנייה המיידית עוד לא מחוברת: חסר GITHUB_TOKEN בהגדרות השרת.";
  try {
    const response = await fetcher(`https://api.github.com/repos/${repoOf(env)}/actions/workflows/${SITE_WORKFLOW}/dispatches`, { method: "POST", headers: { ...headers(env.GITHUB_TOKEN), "content-type": "application/json" }, body: JSON.stringify({ ref: "main" }) });
    return response.status === 204 || response.ok ? null : githubError(response.status);
  } catch {
    return "אין חיבור ל־GitHub כרגע. נסו שוב בעוד רגע.";
  }
}

function githubError(status: number) {
  if (status === 401) return "הטוקן של GitHub אינו תקף או שפג תוקפו.";
  if (status === 403 || status === 404) return "לטוקן של GitHub אין הרשאה להפעיל את הבנייה במאגר של אתר התוכניות (צריך Actions: Read and write).";
  if (status === 422) return "GitHub סירב להפעיל את הבנייה (ייתכן שהענף main אינו קיים).";
  return `GitHub החזיר שגיאה ${status}.`;
}
