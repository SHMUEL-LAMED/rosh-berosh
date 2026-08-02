// שירות טלפוני נפרד לימות המשיח, שמדבר עם ה-API של אתר הסקרים (rosh-berosh).
//
// חשוב: קובץ זה חייב לרוץ כתהליך Node.js רגיל שנשאר "חי" (למשל VPS, Render,
// Railway) - הוא לא יכול לרוץ על Cloudflare Workers, כי הספרייה yemot-router2
// שומרת את מצב השיחה בזיכרון בין הקשה להקשה, וזה דורש תהליך מתמשך.

const express = require("express");
const { YemotRouter } = require("yemot-router2");

const SITE_API_BASE_URL = process.env.SITE_API_BASE_URL;
const PORT = process.env.PORT || 3000;
const MAX_MENU_ITEMS = 9;

if (!SITE_API_BASE_URL) {
  console.error("חסר משתנה סביבה SITE_API_BASE_URL - כתובת אתר הסקרים.");
  process.exit(1);
}

async function fetchPhoneSurveys() {
  const response = await fetch(`${SITE_API_BASE_URL}/api/surveys?published=1`);
  if (!response.ok) throw new Error("survey list request failed");
  const { surveys } = await response.json();
  return (surveys || [])
    .filter((survey) => Array.isArray(survey.channels) && survey.channels.includes("phone"))
    .slice(0, MAX_MENU_ITEMS);
}

async function submitVote({ surveyId, voterKey, answer }) {
  const response = await fetch(`${SITE_API_BASE_URL}/api/votes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surveyId, voterKey, answers: [answer], channel: "phone" }),
  });
  if (response.status === 409) return { ok: false, alreadyVoted: true };
  if (!response.ok) return { ok: false, alreadyVoted: false };
  return { ok: true };
}

function callerPhone(call) {
  return call.phone || call.ApiPhone || call.values?.ApiPhone || call.values?.Phone || call.callId || "unknown";
}

const router = YemotRouter({
  printLog: true,
  defaults: {
    removeInvalidChars: true,
    read: { removeInvalidChars: true },
    id_list_message: { removeInvalidChars: true },
  },
  uncaughtErrorHandler: async (error, call) => {
    console.error("IVR uncaught error:", error);
    try {
      call.id_list_message([{ type: "text", data: "אירעה שגיאה במערכת, נא לנסות שוב מאוחר יותר" }]);
    } catch {}
  },
});

router.get("/", async (call) => {
  let surveys;
  try {
    surveys = await fetchPhoneSurveys();
  } catch {
    return call.id_list_message([{ type: "text", data: "אירעה שגיאה בטעינת הסקרים, נא לנסות שוב מאוחר יותר." }]);
  }

  if (surveys.length === 0) {
    return call.id_list_message([{ type: "text", data: "אין כרגע סקרים פעילים להצבעה טלפונית. נא לנסות שוב בהמשך." }]);
  }

  const menuMessages = [{ type: "text", data: "ברוכים הבאים למערכת הסקרים. " }];
  surveys.forEach((survey, index) => {
    menuMessages.push({ type: "text", data: `להצבעה בסקר ${survey.title}, הקישו ${index + 1}. ` });
  });

  const choiceDigits = await call.read(menuMessages, "tap", {
    max_digits: 1,
    min_digits: 1,
    digits_allowed: surveys.map((_, index) => index + 1),
  });

  const chosenSurvey = surveys[Number(choiceDigits) - 1];
  if (!chosenSurvey) {
    return call.id_list_message([{ type: "text", data: "בחירה לא תקינה. נא להתקשר שוב." }]);
  }

  const questionMessages = chosenSurvey.audioPath
    ? [{ type: "file", data: chosenSurvey.audioPath }]
    : [{ type: "text", data: chosenSurvey.question }];

  chosenSurvey.options.forEach((option, index) => {
    questionMessages.push({ type: "text", data: `לתשובה ${option} הקישו ${index + 1} ` });
  });

  const answerDigits = await call.read(questionMessages, "tap", {
    max_digits: 1,
    min_digits: 1,
    digits_allowed: chosenSurvey.options.map((_, index) => index + 1),
  });

  const selectedOption = chosenSurvey.options[Number(answerDigits) - 1];
  if (!selectedOption) {
    return call.id_list_message([{ type: "text", data: "בחירה לא תקינה. נא להתקשר שוב." }]);
  }

  const result = await submitVote({
    surveyId: chosenSurvey.id,
    voterKey: callerPhone(call),
    answer: selectedOption,
  });

  if (result.alreadyVoted) {
    return call.id_list_message([{ type: "text", data: "כבר הצבעתם בסקר הזה ממספר טלפון זה. תודה!" }]);
  }
  if (!result.ok) {
    return call.id_list_message([{ type: "text", data: "אירעה שגיאה בשמירת ההצבעה, נא לנסות שוב מאוחר יותר." }]);
  }

  return call.id_list_message([{ type: "text", data: "תודה, הצבעתכם נקלטה בהצלחה." }]);
});

const app = express();
app.use(router);
app.get("/healthz", (_request, response) => response.send("ok"));

app.listen(PORT, () => {
  console.log(`ivr service listening on port ${PORT}, forwarding to ${SITE_API_BASE_URL}`);
});
