"use client";

import { useEffect, useMemo, useState } from "react";

type SurveyStatus = "published" | "draft";
type SurveyType = "single" | "multiple" | "ranking";

type Survey = {
  id: string;
  title: string;
  status: SurveyStatus;
  votesCount: number;
  question: string;
  options: string[];
  channels: string[];
  type: SurveyType;
  createdAt: string;
};

const STORAGE_KEY = "rosh-berosh-surveys-v1";

function Icon({ children }: { children: React.ReactNode }) {
  return <span className="nav-icon" aria-hidden="true">{children}</span>;
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function Home() {
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [surveyType, setSurveyType] = useState<SurveyType>("single");
  const [publishNow, setPublishNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const totalVotes = useMemo(
    () => surveys.reduce((sum, survey) => sum + Number(survey.votesCount || 0), 0),
    [surveys],
  );

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as unknown;
        if (Array.isArray(parsed)) setSurveys(parsed as Survey[]);
      }
    } catch {
      // Corrupted local data should not prevent the dashboard from loading.
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(surveys));
  }, [storageReady, surveys]);

  const resetCreator = () => {
    setTitle("");
    setQuestion("");
    setOptions(["", ""]);
    setSurveyType("single");
    setPublishNow(false);
    setError("");
  };

  const closeCreator = () => {
    setCreatorOpen(false);
    resetCreator();
  };

  const createSurvey = () => {
    setBusy(true);
    setError("");

    const cleanTitle = title.trim();
    const cleanQuestion = question.trim();
    const cleanOptions = options.map((option) => option.trim()).filter(Boolean);

    if (!cleanTitle || !cleanQuestion || cleanOptions.length < 2) {
      setError("יש למלא שם, שאלה ולפחות שתי תשובות.");
      setBusy(false);
      return;
    }

    const survey: Survey = {
      id: createId(),
      title: cleanTitle,
      question: cleanQuestion,
      options: cleanOptions,
      type: surveyType,
      status: publishNow ? "published" : "draft",
      channels: ["site"],
      votesCount: 0,
      createdAt: new Date().toISOString(),
    };

    setSurveys((current) => [survey, ...current]);
    setBusy(false);
    setCreatorOpen(false);
    resetCreator();
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
          <div><strong>GitHub Pages</strong><small>פרסום ציבורי פעיל</small></div>
          <span className="chevron">‹</span>
        </div>
        <div className="profile"><div className="avatar">ש״ל</div><div><strong>שמואל ליווי</strong><small>מנהל ראשי</small></div><button aria-label="אפשרויות משתמש">⋮</button></div>
      </aside>

      <section className="workspace" id="dashboard">
        <header className="topbar">
          <div>
            <p className="eyebrow"><span /> מרכז השליטה</p>
            <h1>שלום, שמואל</h1>
            <p>כל הסקרים והתוצאות — במקום אחד.</p>
          </div>
          <div className="top-actions">
            <button className="icon-button" aria-label="התראות">♢<span /></button>
            <button className="create-button" onClick={() => setCreatorOpen(true)}><b>＋</b> סקר חדש</button>
          </div>
        </header>

        <section className="metrics" aria-label="נתוני המערכת">
          <article><div className="metric-icon purple">◫</div><div><span>סקרים פעילים</span><strong>{surveys.filter((item) => item.status === "published").length}</strong><small className="good">מתעדכן מיד</small></div></article>
          <article><div className="metric-icon cyan">◉</div><div><span>סה״כ הצבעות</span><strong>{totalVotes.toLocaleString("he-IL")}</strong><small className="good">נתוני האתר</small></div></article>
          <article><div className="metric-icon pink">⌁</div><div><span>כל הסקרים</span><strong>{surveys.length}</strong><small>כולל טיוטות</small></div></article>
          <article><div className="metric-icon gold">◈</div><div><span>שמירה מקומית</span><strong>פעילה</strong><small>נשמר בדפדפן הזה</small></div></article>
        </section>

        <section className="surveys-panel" id="surveys">
          <div className="panel-head">
            <div><h2>הסקרים האחרונים</h2><p>ניהול ועריכה מתוך הדפדפן</p></div>
            <button type="button">הצג הכל <span>←</span></button>
          </div>
          <div className="survey-list">
            {surveys.length === 0 && <div className="empty-state"><b>עדיין אין סקרים</b><span>לחץ על „סקר חדש” והסקר הראשון יופיע כאן.</span></div>}
            {surveys.map((survey, index) => (
              <article className="survey-row" key={survey.id} style={{ "--delay": `${index * 70}ms` } as React.CSSProperties}>
                <div className={`survey-symbol ${["violet", "cyan", "pink"][index % 3]}`}>♫</div>
                <div className="survey-title"><strong>{survey.title}</strong><span>שאלה אחת · {survey.question}</span></div>
                <div className="channel-badges"><span>אתר</span></div>
                <div className="votes"><strong>{Number(survey.votesCount || 0).toLocaleString("he-IL")}</strong><span>הצבעות</span></div>
                <span className={`status ${survey.status === "published" ? "live" : "draft"}`}>{survey.status === "published" ? "פעיל" : "טיוטה"}</span>
                <button className="more" aria-label={`פעולות עבור ${survey.title}`}>•••</button>
              </article>
            ))}
          </div>
        </section>

        <section className="quick-strip">
          <div><span className="live-dot" /><strong>האתר פועל</strong><small>כל שינוי נשמר אוטומטית במכשיר הזה</small></div>
          <div className="wave"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
          <button onClick={() => setCreatorOpen(true)}>יצירת סקר מהיר</button>
        </section>
      </section>

      {creatorOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeCreator}>
          <section className="creator-modal" role="dialog" aria-modal="true" aria-labelledby="creator-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={closeCreator} aria-label="סגירה">×</button>
            <p className="eyebrow"><span /> סקר חדש</p>
            <h2 id="creator-title">מה תרצה לשאול?</h2>
            <p>מתחילים בשם ובוחרים את סוג ההצבעה. תמיד אפשר ליצור סקר נוסף.</p>
            <label>שם הסקר<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="לדוגמה: מצעד המוזיקה השנתי" /></label>
            <label>השאלה<input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="לדוגמה: מי הוא זמר השנה?" /></label>
            <div className="type-grid">
              <button type="button" className={surveyType === "single" ? "selected" : ""} onClick={() => setSurveyType("single")}><b>◉</b><strong>בחירה אחת</strong><span>תשובה אחת מתוך הרשימה</span></button>
              <button type="button" className={surveyType === "multiple" ? "selected" : ""} onClick={() => setSurveyType("multiple")}><b>☷</b><strong>בחירה מרובה</strong><span>כמה תשובות באותה שאלה</span></button>
              <button type="button" className={surveyType === "ranking" ? "selected" : ""} onClick={() => setSurveyType("ranking")}><b>★</b><strong>דירוג</strong><span>סידור מועמדים לפי מקום</span></button>
            </div>
            <div className="options-editor">
              <strong>אפשרויות תשובה</strong>
              {options.map((option, index) => (
                <div key={index}>
                  <span>{index + 1}</span>
                  <input value={option} onChange={(event) => setOptions(options.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder={`אפשרות ${index + 1}`} />
                  {options.length > 2 && <button type="button" onClick={() => setOptions(options.filter((_, itemIndex) => itemIndex !== index))}>×</button>}
                </div>
              ))}
              <button type="button" className="add-option" onClick={() => setOptions([...options, ""])}>＋ הוסף אפשרות</button>
            </div>
            <label className="publish-toggle"><input type="checkbox" checked={publishNow} onChange={(event) => setPublishNow(event.target.checked)} /><span /><div><strong>להציג כפעיל</strong><small>הסקר יופיע ברשימה כסקר פעיל</small></div></label>
            {error && <p className="form-error">{error}</p>}
            <div className="modal-actions"><button className="secondary" onClick={closeCreator}>ביטול</button><button className="primary" disabled={busy} onClick={createSurvey}>{busy ? "שומר..." : "שמור את הסקר"} <span>←</span></button></div>
          </section>
        </div>
      )}
    </main>
  );
}
