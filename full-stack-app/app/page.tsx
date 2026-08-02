"use client";

import { useEffect, useMemo, useState } from "react";

type Survey = { id: string; title: string; status: string; votesCount: number; question: string; options: string[]; channels: string[]; audioPath?: string | null; audioStatus?: string };

function Icon({ children }: { children: React.ReactNode }) {
  return <span className="nav-icon" aria-hidden="true">{children}</span>;
}

export default function Home() {
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [surveyType, setSurveyType] = useState("single");
  const [publishNow, setPublishNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState("");
  const totalVotes = useMemo(() => surveys.reduce((sum, survey) => sum + Number(survey.votesCount || 0), 0), [surveys]);

  const loadSurveys = async () => {
    try {
      const response = await fetch("/api/surveys", { cache: "no-store" });
      if (response.ok) setSurveys((await response.json()).surveys ?? []);
    } catch { /* The dashboard remains usable while the database starts. */ }
  };

  useEffect(() => { void loadSurveys(); }, []);

  const uploadAudio = async (surveyId: string, file: File) => {
    setUploadingId(surveyId); setUploadError("");
    try {
      const body = new FormData();
      body.append("audio", file);
      const response = await fetch(`/api/surveys/${surveyId}/audio`, { method: "POST", body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "העלאת ההקלטה נכשלה.");
      await loadSurveys();
    } catch (caught) { setUploadError(caught instanceof Error ? caught.message : "אירעה שגיאה בהעלאת ההקלטה."); }
    finally { setUploadingId(null); }
  };

  const createSurvey = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/surveys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, question, options, type: surveyType, status: publishNow ? "published" : "draft", channels: ["site", "phone"] }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "לא ניתן לשמור את הסקר.");
      setCreatorOpen(false); setTitle(""); setQuestion(""); setOptions(["", ""]); setPublishNow(false);
      await loadSurveys();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "אירעה שגיאה."); }
    finally { setBusy(false); }
  };

  return (
    <main className="app-shell" dir="rtl">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><span>ר</span><i /></div>
          <div><strong>ראש בראש</strong><small>מערכת סקרים</small></div>
        </div>

        <nav aria-label="ניווט ראשי">
          <a className="active" href="#dashboard"><Icon>⌂</Icon><span>לוח בקרה</span></a>
          <a href="#surveys"><Icon>◫</Icon><span>הסקרים שלי</span><b>{surveys.length}</b></a>
          <a href="#results"><Icon>⌁</Icon><span>תוצאות ונתונים</span></a>
          <a href="#channels"><Icon>◉</Icon><span>ערוצי פרסום</span></a>
          <a href="#settings"><Icon>⚙</Icon><span>הגדרות</span></a>
        </nav>

        <div className="sidebar-status">
          <span className="pulse-dot" />
          <div><strong>ימות המשיח</strong><small>מוכן לחיבור</small></div>
          <span className="chevron">‹</span>
        </div>
        <div className="profile"><div className="avatar">ש״ל</div><div><strong>שמואל ליווי</strong><small>מנהל ראשי</small></div><button aria-label="אפשרויות משתמש">⋮</button></div>
      </aside>

      <section className="workspace" id="dashboard">
        <header className="topbar">
          <div>
            <p className="eyebrow"><span /> מרכז השליטה</p>
            <h1>ערב טוב, שמואל</h1>
            <p>כל הסקרים, המצביעים והתוצאות — במקום אחד.</p>
          </div>
          <div className="top-actions">
            <button className="icon-button" aria-label="התראות">♢<span /></button>
            <button className="create-button" onClick={() => setCreatorOpen(true)}><b>＋</b> סקר חדש</button>
          </div>
        </header>

        <section className="metrics" aria-label="נתוני המערכת">
          <article><div className="metric-icon purple">◫</div><div><span>סקרים פעילים</span><strong>{surveys.filter((item) => item.status === "published").length}</strong><small className="good">מתעדכן בזמן אמת</small></div></article>
          <article><div className="metric-icon cyan">◉</div><div><span>סה״כ הצבעות</span><strong>{totalVotes.toLocaleString("he-IL")}</strong><small className="good">אתר וטלפון יחד</small></div></article>
          <article><div className="metric-icon pink">⌁</div><div><span>כל הסקרים</span><strong>{surveys.length}</strong><small>כולל טיוטות</small></div></article>
          <article><div className="metric-icon gold">◈</div><div><span>הצבעות בטלפון</span><strong>42%</strong><small>סנכרון בזמן אמת</small></div></article>
        </section>

        <section className="surveys-panel" id="surveys">
          <div className="panel-head">
            <div><h2>הסקרים האחרונים</h2><p>ניהול, עריכה ומעקב בזמן אמת</p></div>
            <button>הצג הכל <span>←</span></button>
          </div>
          <div className="survey-list">
            {surveys.length === 0 && <div className="empty-state"><b>עדיין אין סקרים</b><span>לחץ על „סקר חדש” והסקר הראשון יופיע כאן.</span></div>}
            {surveys.map((survey, index) => (
              <article className="survey-row" key={survey.title} style={{ "--delay": `${index * 70}ms` } as React.CSSProperties}>
                <div className={`survey-symbol ${["violet", "cyan", "pink"][index % 3]}`}>♫</div>
                <div className="survey-title"><strong>{survey.title}</strong><span>שאלה אחת · {survey.question}</span></div>
                <div className="channel-badges"><span>אתר</span><span>טלפון</span></div>
                <label className="audio-upload" title="העלאת הקלטה אנושית של השאלה, להשמעה בקו הטלפוני">
                  <input type="file" accept="audio/*" hidden disabled={uploadingId === survey.id}
                    onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAudio(survey.id, file); event.target.value = ""; }} />
                  {uploadingId === survey.id ? "מעלה..." : survey.audioStatus === "uploaded" ? "🎙 הקלטה קיימת · החלף" : survey.audioStatus === "error" ? "⚠ שגיאה · נסה שוב" : "🎙 העלה הקלטה"}
                </label>
                <div className="votes"><strong>{Number(survey.votesCount || 0).toLocaleString("he-IL")}</strong><span>הצבעות</span></div>
                <span className={`status ${survey.status === "published" ? "live" : "draft"}`}>{survey.status === "published" ? "פעיל" : "טיוטה"}</span>
                <button className="more" aria-label={`פעולות עבור ${survey.title}`}>•••</button>
              </article>
            ))}
          </div>
          {uploadError && <p className="form-error">{uploadError}</p>}
        </section>

        <section className="quick-strip">
          <div><span className="live-dot" /><strong>המערכת פועלת</strong><small>הצבעה חדשה התקבלה לפני 12 שניות</small></div>
          <div className="wave"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
          <button onClick={() => setCreatorOpen(true)}>יצירת סקר מהיר</button>
        </section>
      </section>

      {creatorOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setCreatorOpen(false)}>
          <section className="creator-modal" role="dialog" aria-modal="true" aria-labelledby="creator-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setCreatorOpen(false)} aria-label="סגירה">×</button>
            <p className="eyebrow"><span /> סקר חדש</p>
            <h2 id="creator-title">מה תרצה לשאול?</h2>
            <p>מתחילים בשם ובוחרים את סוג ההצבעה. תמיד אפשר לשנות אחר כך.</p>
            <label>שם הסקר<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="לדוגמה: מצעד המוזיקה השנתי" /></label>
            <label>השאלה<input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="לדוגמה: מי הוא זמר השנה?" /></label>
            <div className="type-grid">
              <button className={surveyType === "single" ? "selected" : ""} onClick={() => setSurveyType("single")}><b>◉</b><strong>בחירה אחת</strong><span>תשובה אחת מתוך הרשימה</span></button>
              <button className={surveyType === "multiple" ? "selected" : ""} onClick={() => setSurveyType("multiple")}><b>☷</b><strong>בחירה מרובה</strong><span>כמה תשובות באותה שאלה</span></button>
              <button className={surveyType === "ranking" ? "selected" : ""} onClick={() => setSurveyType("ranking")}><b>★</b><strong>דירוג</strong><span>סידור מועמדים לפי מקום</span></button>
            </div>
            <div className="options-editor">
              <strong>אפשרויות תשובה</strong>
              {options.map((option, index) => (
                <div key={index}>
                  <span>{index + 1}</span>
                  <input value={option} onChange={(event) => setOptions(options.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder={`אפשרות ${index + 1}`} />
                  {options.length > 2 && <button onClick={() => setOptions(options.filter((_, itemIndex) => itemIndex !== index))}>×</button>}
                </div>
              ))}
              <button className="add-option" onClick={() => setOptions([...options, ""])}>＋ הוסף אפשרות</button>
            </div>
            <label className="publish-toggle"><input type="checkbox" checked={publishNow} onChange={(event) => setPublishNow(event.target.checked)} /><span /><div><strong>לפרסם מיד</strong><small>הסקר יהיה פתוח להצבעה באתר ובטלפון</small></div></label>
            {error && <p className="form-error">{error}</p>}
            <div className="modal-actions"><button className="secondary" onClick={() => setCreatorOpen(false)}>ביטול</button><button className="primary" disabled={busy} onClick={createSurvey}>{busy ? "שומר..." : "שמור את הסקר"} <span>←</span></button></div>
          </section>
        </div>
      )}
    </main>
  );
}
