// OND2U 이메일 발송 함수 (6-2단계: 나에게 테스트 한 통)
// - 창고(Supabase)에서 명언(+성경 선택시 성경) 꺼내서
// - 원래 메일 폼(오늘도_메일_미리보기_v2) 디자인 그대로, Pretendard 적용해 발송
// - 비밀 키는 Vercel 환경변수에서만 읽음
//
// 호출: /api/send-test?key=<CRON_SECRET>&to=<이메일>&from_name=<이름>&to_name=<받는사람>&bible=<1이면 성경도>

import crypto from "crypto";

export const config = { maxDuration: 60 };
const sleep = ms => new Promise(res => setTimeout(res, ms));

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.ODO_SUPABASE_URL;
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;
  const SECRET = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || "";
  const isCron = !!SECRET && authHeader === "Bearer " + SECRET;   // Vercel Cron이 자동으로 붙이는 헤더
  const keyOk  = !!SECRET && (req.query.key || "") === SECRET;    // 주소창 수동 호출 ?key=

  // 관리자 로그인 세션으로도 발송 허용 (화면의 발송 버튼용)
  let isAdmin = false;
  if (!isCron && !keyOk && SB_URL && SB_SERVICE) {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token) {
      try {
        const uRes = await fetch(SB_URL + "/auth/v1/user", {
          headers: { "Authorization": "Bearer " + token, "apikey": SB_SERVICE }
        });
        const user = await uRes.json();
        const email = ((user && user.email) || "").toLowerCase();
        const admins = (process.env.ADMIN_EMAILS || "")
          .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        if (email && admins.includes(email)) isAdmin = true;
      } catch (e) {}
    }
  }
  if (!isCron && !keyOk && !isAdmin)
    return res.status(401).json({ ok: false, error: "열쇠가 맞지 않아요." });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.ODO_FROM_EMAIL || "letter@ond2u.com";

  if (!RESEND_KEY || !SB_URL || !SB_SERVICE)
    return res.status(500).json({ ok: false, error: "서버 설정(환경변수)이 아직 안 됐어요." });

  const fromName = req.query.from_name || "윤기";
  const all = isCron || req.query.all === "1";   // cron 호출이거나 all=1 이면 수신자 전체 발송

  try {
    // 콘텐츠는 한 번만 불러와 재사용 (수신자가 여러 명이어도 창고는 1~2번만 읽음)
    const normalPool = await fetchContents(SB_URL, SB_SERVICE, "normal");
    if (!normalPool.length) throw new Error("창고에 일반 콘텐츠가 없어요.");
    const biblePool = await fetchContents(SB_URL, SB_SERVICE, "bible");
    const foodPool = await fetchFoods(SB_URL, SB_SERVICE);

    const cfg = { RESEND_KEY, FROM, fromName, normalPool, biblePool, foodPool, SB_URL, SB_SERVICE, SECRET };

    if (all) {
      // ── 전체 발송: 수신자 명단 전원에게 ──
      let recipients = await fetchRecipients(SB_URL, SB_SERVICE);
      if (!recipients.length)
        return res.status(200).json({ ok: true, message: "보낼 수신자가 없어요. (odo_recipients 비어있음)", sent: 0 });

      // 발송 시각 개인화: slot=1(크론 시각별 호출)일 때만, 지금 시각(KST)에 해당하는 수신자에게만 보냄.
      //  - 관리자 '지금 발송'은 slot 없이 all=1 만 오므로 시각과 무관하게 전원 즉시 발송.
      //  - ?hour=8 처럼 특정 시각을 지정해 테스트할 수도 있음.
      const slotMode = req.query.slot === "1";
      let nowHour = new Date(Date.now() + 9 * 3600 * 1000).getUTCHours(); // KST 시(0~23)
      if (req.query.hour != null && req.query.hour !== "") { const hh = parseInt(req.query.hour, 10); if (!isNaN(hh)) nowHour = hh; }
      // 오늘(KST) 월-일 — 특별한 날(생일·기념일) 판별용. ?date=MM-DD 로 테스트 가능.
      let todayMD = (function(){ const k = new Date(Date.now() + 9 * 3600 * 1000); return String(k.getUTCMonth()+1).padStart(2,"0") + "-" + String(k.getUTCDate()).padStart(2,"0"); })();
      if (req.query.date) todayMD = req.query.date;
      let skipped = 0;
      if (slotMode) {
        const before = recipients.length;
        recipients = recipients.filter(rc => recipHours(rc).includes(nowHour));
        skipped = before - recipients.length;
        if (!recipients.length)
          return res.status(200).json({ ok: true, message: nowHour + "시에 보낼 수신자가 없어요.", sent: 0, skipped, hour: nowHour });
      }

      // 각 수신자를 등록한 사람(sender)의 '보내는 이름'을 조회해 둠
      const sendersById = await fetchSenders(SB_URL, SB_SERVICE);

      const results = [];
      let _idx = 0;
      for (const rc of recipients) {
        if (_idx++ > 0) await sleep(600);
        try {
          const su = sendersById[rc.sender_id] || {};
          const perFromName = (su.display_name && su.display_name.trim())
            || (su.email ? su.email.split("@")[0] : "")
            || cfg.fromName;
          const isSpecial = rc.special_date && rc.special_date === todayMD;
          const id = await sendOne({ ...cfg, fromName: perFromName, to: rc.email, toName: rc.name || "", wantBible: rc.kind === "bible", senderId: rc.sender_id, tone: rc.tone || "", special: isSpecial ? (rc.special_label || "특별한 날") : null });
          results.push({ email: rc.email, ok: true, id });
        } catch (e) {
          results.push({ email: rc.email, ok: false, error: String(e && e.message || e) });
        }
      }
      const okCount = results.filter(x => x.ok).length;
      return res.status(200).json({ ok: true, message: okCount + "/" + results.length + "명에게 보냈어요." + (slotMode ? " (" + nowHour + "시)" : ""), sent: okCount, total: results.length, skipped, hour: slotMode ? nowHour : null, results });
    } else {
      // ── 단일 발송: 한 명에게 (기존 테스트 방식) ──
      const to = req.query.to;
      if (!to) return res.status(400).json({ ok: false, error: "받을 이메일(to)이 없어요. (전체 발송은 주소 끝에 all=1)" });
      const toName = req.query.to_name || "";
      const wantBible = req.query.bible === "1";
      const id = await sendOne({ ...cfg, to, toName, wantBible, senderId: req.query.sender_id || "", tone: req.query.tone || "", special: req.query.special || null });
      return res.status(200).json({ ok: true, message: "보냈어요!", to, id });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}

// 수신자 한 명에게 발송 (콘텐츠 풀에서 랜덤으로 뽑아 메일 만들어 Resend로)
// tone(결)이 있으면: 그 결에 맞는 콘텐츠 + 결 없는(공통) 콘텐츠 중에서만 뽑음.
//  - 그 결에 해당하는 게 하나도 없으면 전체에서 뽑음(폴백) → 편지가 안 나가는 일은 없음.
// special(특별한 날 이름표)이 있으면: 평소 편지 대신 축하 편지를 보냄.
async function sendOne({ RESEND_KEY, FROM, fromName, normalPool, biblePool, foodPool, to, toName, wantBible, senderId, tone, special, SB_URL, SB_SERVICE, SECRET }) {
  let html, quote, subject;
  if (special) {
    html = buildSpecialEmail({ fromName, toName, label: special, recipientEmail: to, senderId, secret: SECRET });
    quote = "[축하] " + special;
    subject = fromName + "님이 보내는 축하 편지 \uD83C\uDF89";
  } else {
    let pool = normalPool;
    if (tone) {
      const matched = normalPool.filter(c => c.tone === tone || !c.tone);
      if (matched.length) pool = matched;
    }
    const pickN = pool[Math.floor(Math.random() * pool.length)];
    let pickB = null;
    if (wantBible && biblePool.length) pickB = biblePool[Math.floor(Math.random() * biblePool.length)];
    html = buildEmail({ fromName, toName, normal: pickN, bible: pickB, recipientEmail: to, senderId, secret: SECRET, foodPool });
    quote = (pickN.quote || "").replace(/\\n/g, " ").slice(0, 80);
    subject = fromName + "님이 오늘도 보냅니다";
  }
  const logBase = { sender_id: senderId || null, sender_name: fromName, recipient_email: to, recipient_name: toName || "", content_quote: quote };

  try {
    const payload = JSON.stringify({
      from: '"오늘도/OND2U" <' + FROM + ">",
      to: [to],
      subject,
      html
    });
    const doSend = () => fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: payload
    });
    let r = await doSend();
    if (r.status === 429) { await sleep(1200); r = await doSend(); }
    const data = await r.json();
    if (!r.ok) throw new Error("Resend 발송 실패: " + JSON.stringify(data));
    await logSend(SB_URL, SB_SERVICE, { ...logBase, status: "success", resend_id: data.id || "" });
    return data.id;
  } catch (e) {
    await logSend(SB_URL, SB_SERVICE, { ...logBase, status: "fail", error: String(e && e.message || e) });
    throw e;
  }
}

// 발송 기록을 창고(odo_sends)에 남김 — 실패해도 발송 자체엔 영향 없음
async function logSend(url, key, row) {
  try {
    await fetch(url + "/rest/v1/odo_sends", {
      method: "POST",
      headers: { "apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify(row)
    });
  } catch (e) { /* 로그 실패는 조용히 무시 */ }
}

// 수신자 명단 전체 읽기
async function fetchRecipients(url, key) {
  const r = await fetch(url + "/rest/v1/odo_recipients?select=*", {
    headers: { "apikey": key, "Authorization": "Bearer " + key }
  });
  if (!r.ok) throw new Error("수신자 명단 읽기 실패: " + r.status);
  return await r.json();
}

// 발송 시각 라벨 → KST 시(hour) 매핑 (app.html 시각 칩과 반드시 일치)
const TIME_HOURS = { "아침 8시": 8, "점심 12시": 12, "저녁 6시": 18, "밤 10시": 22 };
function recipHours(rc) {
  let ts = rc && rc.send_times;
  if (!Array.isArray(ts) || !ts.length) ts = ["아침 8시"];
  const hs = ts.map(t => TIME_HOURS[t]).filter(h => h != null);
  return hs.length ? hs : [8];
}

// 등록한 사람(sender)들의 '보내는 이름'을 id로 찾을 수 있게 맵으로 만들어 둠
async function fetchSenders(url, key) {
  try {
    const r = await fetch(url + "/rest/v1/odo_users?select=id,display_name,email", {
      headers: { "apikey": key, "Authorization": "Bearer " + key }
    });
    if (!r.ok) return {};
    const rows = await r.json();
    const map = {};
    (rows || []).forEach(u => { map[u.id] = { display_name: u.display_name, email: u.email }; });
    return map;
  } catch (e) { return {}; }
}

// 이름 뒤 조사(가/이) 자동 처리
function josaGaI(name) {
  if (!name) return "";
  const c = name.charCodeAt(name.length - 1);
  if (c < 0xAC00 || c > 0xD7A3) return name + "가";
  return name + (((c - 0xAC00) % 28 !== 0) ? "이" : "가");
}

async function fetchFoods(url, key) {
  try {
    const r = await fetch(url + "/rest/v1/odo_foods?active=eq.true&select=*", {
      headers: { "apikey": key, "Authorization": "Bearer " + key }
    });
    if (!r.ok) return [];
    return await r.json();
  } catch (e) { return []; }
}

async function fetchContents(url, key, kind) {
  const r = await fetch(url + "/rest/v1/odo_contents?kind=eq." + kind + "&select=*", {
    headers: { "apikey": key, "Authorization": "Bearer " + key }
  });
  if (!r.ok) throw new Error("창고 읽기 실패: " + r.status);
  return await r.json();
}

const CARE_EMOJI = {
  tea: "\u2615",       // ☕
  breath: "\uD83E\uDECB", // 🫋 (숨) → 대체 아래에서
  sun: "\u2600\uFE0F",  // ☀️
  walk: "\uD83D\uDEB6", // 🚶
  stretch: "\uD83E\uDD38" // 🤸
};
function careEmoji(k){
  const map = { tea:"\u2615", breath:"\uD83C\uDF2C\uFE0F", sun:"\u2600\uFE0F", walk:"\uD83D\uDEB6", stretch:"\uD83E\uDD38" };
  return map[k] || "\uD83C\uDF43"; // 기본 🍃
}

// 특별한 날(생일·기념일) 축하 편지 HTML
function buildSpecialEmail({ fromName, toName, label, recipientEmail, senderId, secret }) {
  const PLUM = "#423458", PLUM_DEEP = "#2f2440", ROSE = "#d97c93", ROSE_SOFT = "#fdeef2";
  const font = "'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif";
  const spacer = h => '<div style="height:' + h + 'px; line-height:' + h + 'px; font-size:0;">&nbsp;</div>';
  const rParam = encodeURIComponent(recipientEmail || "");
  const unsubTok = secret ? crypto.createHmac("sha256", secret).update(recipientEmail || "").digest("hex").slice(0, 32) : "";
  const unsubUrl = "https://www.ond2u.com/api/unsubscribe?e=" + rParam + "&t=" + unsubTok;

  const who = toName || "\uB2F9\uC2E0";
  const isBirthday = /\uC0DD\uC77C|\uC0DD\uC2E0|birthday/i.test(label || "");
  const emoji = isBirthday ? "\uD83C\uDF82" : "\uD83C\uDF89";
  const head = isBirthday ? (who + "\uB2D8, \uC0DD\uC77C \uCD95\uD558\uD574\uC694") : (who + "\uB2D8, " + (label || "\uD2B9\uBCC4\uD55C \uB0A0") + " \uCD95\uD558\uD574\uC694");

  const bday = [
    who + "\uB2D8\uC774 \uD0DC\uC5B4\uB09C \uC624\uB298\uC774, \uC800\uC5D0\uAC8C\uB3C4 \uCC38 \uACE0\uB9C8\uC6B4 \uB0A0\uC774\uC5D0\uC694. \uC62C \uD55C \uD574\uB3C4 \uC6C3\uC744 \uC77C\uC774 \uAC00\uB4DD\uD558\uAE38, \uAC74\uAC15\uD558\uACE0 \uD3C9\uC548\uD558\uAE38 \uC9C4\uC2EC\uC73C\uB85C \uBC14\uB77C\uC694.",
    "\uC138\uC0C1\uC5D0 " + who + "\uB2D8\uC774 \uC788\uC5B4\uC11C \uC5BC\uB9C8\uB098 \uB2E4\uD589\uC778\uC9C0 \uBAB0\uB77C\uC694. \uC624\uB298 \uD558\uB8E8\uB9CC\uD07C\uC740 \uC628\uC804\uD788 " + who + "\uB2D8\uC744 \uC704\uD55C \uB0A0\uC774 \uB418\uAE38 \uBC14\uB77C\uC694.",
    "\uC77C \uB144 \uC911 \uAC00\uC7A5 \uBE5B\uB098\uB294 \uC624\uB298, " + who + "\uB2D8\uC758 \uD558\uB8E8\uAC00 \uC88B\uC544\uD558\uB294 \uAC83\uB4E4\uB85C \uAC00\uB4DD \uCC44\uC6CC\uC9C0\uAE38 \uBC14\uB77C\uC694. \uD0DC\uC5B4\uB098 \uC918\uC11C \uACE0\uB9C8\uC6CC\uC694."
  ];
  const aniv = [
    "\uC624\uB298\uC740 " + who + "\uB2D8\uC5D0\uAC8C \uD2B9\uBCC4\uD55C \uB0A0\uC774\uC8E0. " + (label || "") + ", \uC9C4\uC2EC\uC73C\uB85C \uCD95\uD558\uD574\uC694. \uC774 \uC88B\uC740 \uAE30\uC5B5\uC774 \uC624\uB798\uC624\uB798 \uB9C8\uC74C\uC5D0 \uB0A8\uAE30\uB97C \uBC14\uB77C\uC694.",
    who + "\uB2D8\uC758 " + (label || "\uD2B9\uBCC4\uD55C \uB0A0") + "\uC744 \uD568\uAED8 \uAE30\uC5B5\uD558\uACE0 \uC2F6\uC5C8\uC5B4\uC694. \uC624\uB298 \uD558\uB8E8, \uB530\uD558\uACE0 \uD589\uBCF5\uD55C \uC2DC\uAC04 \uBCF4\uB0B4\uAE38 \uBC14\uB77C\uC694.",
    "\uD2B9\uBCC4\uD55C \uC624\uB298\uC744 \uCD95\uD558\uD574\uC694, " + who + "\uB2D8. \uC88B\uC740 \uC0AC\uB78C\uB4E4\uACFC \uC88B\uC740 \uC21C\uAC04\uC744 \uB098\uB204\uB294 \uD558\uB8E8\uAC00 \uB418\uAE38 \uBC14\uB77C\uC694."
  ];
  const pool = isBirthday ? bday : aniv;
  const msg = pool[Math.floor(Math.random() * pool.length)];

  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">' +
'<!--[if mso]><style type="text/css">body,table,td,div,p,span,a,b,h1,h2,h3 { font-family:\'Gulim\',\'\uAD74\uB9BC\',sans-serif !important; letter-spacing:0 !important; }</style><![endif]-->' +
'</head><body style="margin:0; padding:0; background:#f3f1ef; font-family:' + font + ';">' +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f1ef" style="background:#f3f1ef;"><tr>' +
'<td align="center" style="padding:36px 12px 56px; font-family:' + font + '; word-break:keep-all;">' +
  '<table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="width:680px; max-width:680px; background:#ffffff; border:2px solid ' + ROSE + '; border-radius:16px; overflow:hidden;">' +
    '<tr><td bgcolor="#ffffff" style="padding:18px 24px; border-bottom:1px solid #eae7e3;">' +
      '<div style="font-size:13px; color:#b0aab6;">' + fromName + '\uB2D8\uC774 ' + (toName ? toName + '\uB2D8\uC744 ' : '') + '\uC0DD\uAC01\uD558\uBA70 \uBCF4\uB0B4\uB294 \uD2B9\uBCC4\uD55C \uD3B8\uC9C0</div>' +
    '</td></tr>' +
    '<tr><td bgcolor="' + ROSE_SOFT + '" style="background:' + ROSE_SOFT + '; padding:42px 28px 34px; text-align:center;">' +
      '<div style="font-size:46px; line-height:1; margin-bottom:14px;">' + emoji + '</div>' +
      '<div style="font-size:26px; font-weight:800; color:' + PLUM_DEEP + '; letter-spacing:-0.03em; word-break:keep-all;">' + head + '</div>' +
    '</td></tr>' +
    '<tr><td bgcolor="#ffffff" style="padding:34px 30px 30px;">' +
      '<div style="font-size:16px; line-height:1.95; color:#3a3540; text-align:center; word-break:keep-all;">' + msg + '</div>' +
      spacer(24) +
      '<div style="text-align:center; font-size:15px; font-weight:600; color:' + ROSE + ';">' + fromName + '\uC758 \uB9C8\uC74C\uC744 \uB2F4\uC544.</div>' +
      spacer(28) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">' +
        '<a href="https://ond2u.com/app.html" style="display:inline-block; font-size:14px; font-weight:600; color:#ffffff; background:' + PLUM + '; text-decoration:none; padding:13px 28px; border-radius:30px;">\uC624\uB298\uB3C4\uC5D0\uC11C \uB354 \uBCF4\uAE30 \u2192</a>' +
      '</td></tr></table>' +
    '</td></tr>' +
    '<tr><td bgcolor="#f3f1ef" style="padding:22px 28px; border-top:1px solid #eae7e3; text-align:center;">' +
      '<div style="font-size:11px; color:#b0aab6;">\uC774\uC81C \uADF8\uB9CC \uBC1B\uACE0 \uC2F6\uC73C\uC2DC\uBA74 <a href="' + unsubUrl + '" style="color:#b0aab6;">\uC5EC\uAE30</a>\uB97C \uB20C\uB7EC\uC8FC\uC138\uC694.</div>' +
    '</td></tr>' +
  '</table>' +
  spacer(20) +
  '<div style="text-align:center; font-size:12px; color:#b0aab6;">\uC624\uB298\uB3C4 \u00B7 OND2U</div>' +
'</td></tr></table></body></html>';
}

function buildEmail({ fromName, toName, normal, bible, recipientEmail, senderId, secret, foodPool }) {
  const nl = s => (s || "").replace(/\\n/g, "\n");
  const rParam = encodeURIComponent(recipientEmail || "");
  const unsubTok = secret ? crypto.createHmac("sha256", secret).update(recipientEmail || "").digest("hex").slice(0, 32) : "";
  const unsubUrl = "https://www.ond2u.com/api/unsubscribe?e=" + rParam + "&t=" + unsubTok;
  const sParam = encodeURIComponent(senderId || "");
  const qParam = encodeURIComponent(nl(normal.quote).replace(/\n/g, " ").slice(0, 60));
  const reactUrl = em => "https://www.ond2u.com/api/letter?e=" + encodeURIComponent(em) + "&r=" + rParam + "&s=" + sParam + "&q=" + qParam;
  const brQuote = nl(normal.quote).replace(/\n/g, "<br>");
  const essayParas = nl(normal.essay).split("\n\n").filter(Boolean)
    .map(p => '<p style="font-size:14px; line-height:1.9; color:#e9e5f0; margin:0 0 13px;">' + p.replace(/\n/g, "<br>") + '</p>').join("");
  const careIc = careEmoji(normal.care_icon);
  // 오늘 이 음식 (절기 우선 → 없으면 랜덤), 한국 날짜(KST) 기준
  const spacer = h => '<div style="height:' + h + 'px; line-height:' + h + 'px; font-size:0;">&nbsp;</div>';
  const _kst = new Date(Date.now() + 9*3600*1000);
  const _md = String(_kst.getUTCMonth()+1).padStart(2,"0") + "-" + String(_kst.getUTCDate()).padStart(2,"0");
  const _inR = (a,b)=> (a&&b) ? ((a<=b) ? (_md>=a&&_md<=b) : (_md>=a||_md<=b)) : false;
  let _fc = (foodPool||[]).filter(f=>f.kind==="season" && _inR(f.start_md,f.end_md));
  if(!_fc.length) _fc = (foodPool||[]).filter(f=>f.kind==="mood");
  if(!_fc.length) _fc = (foodPool||[]).slice();
  const food = _fc.length ? _fc[Math.floor(Math.random()*_fc.length)] : null;
  const foodBlock = food ? (
      spacer(16) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fcf2ea" style="background:#fcf2ea; border:1px solid #f0ddcb; border-radius:14px;"><tr><td style="padding:20px 22px;">' +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
          '<td width="48" style="vertical-align:middle;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="36" height="36" bgcolor="#ffffff" align="center" style="background:#ffffff; border-radius:10px; font-size:19px; line-height:36px;">' + (food.emoji || "\uD83C\uDF7D") + '</td></tr></table></td>' +
          '<td style="vertical-align:middle;"><div style="font-size:10px; letter-spacing:0.1em; color:#c58a5a;">\uC624\uB298 \uC774 \uC74C\uC2DD \uC5B4\uB54C\uC694?</div><div style="font-size:15px; font-weight:700; color:#8a5236; margin-top:2px;">' + (food.name || "") + '</div></td>' +
        '</tr></table>' +
        (food.descr ? '<div style="font-size:13px; line-height:1.8; color:#46414d; margin-top:11px;">' + food.descr + '</div>' : "") +
      '</td></tr></table>'
    ) : "";
  const badge = fromName.charAt(0);
  const font = "'Pretendard','Gulim','\uAD74\uB9BC',sans-serif";
  // 반응 버튼 (아웃룩 호환: 각 버튼을 개별 table 셀로 만들어 margin 없이도 간격 확보)
  const reactBtn = (url, label, textColor, borderColor) =>
    '<td bgcolor="#ffffff" style="background:#ffffff; border:1px solid ' + borderColor + '; border-radius:30px;">' +
      '<a href="' + url + '" style="display:block; font-size:13px; color:' + textColor + '; text-decoration:none; padding:9px 15px; white-space:nowrap;">' + label + '</a>' +
    '</td>';

  // 색상 (앱과 통일)
  const PLUM = "#423458", PLUM_DEEP = "#33283f", PLUM_SOFT = "#efecf4", ROSE = "#d97c93";

  let bibleBlock = "";
  if (bible) {
    const bQuote = nl(bible.quote).replace(/\n/g, "<br>");
    const bParas = nl(bible.essay).split("\n\n").filter(Boolean)
      .map(p => '<p style="font-size:14px; line-height:1.9; color:#46414d; margin:0 0 13px;">' + p.replace(/\n/g, "<br>") + '</p>').join("");
    bibleBlock =
      spacer(30) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-top:28px; border-top:1px solid #eae7e3;">' +
        '<div style="font-size:11px; letter-spacing:0.08em; color:' + PLUM + '; font-weight:700; text-align:center; margin-bottom:16px;">\u271D \uD558\uB098\uB2D8\uAED8\uC11C \uC624\uB298 \uC8FC\uC2E0 \uB9D0\uC500\uC785\uB2C8\uB2E4</div>' +
        '<div style="font-size:22px; line-height:1.5; font-weight:800; text-align:center; color:#2b2730; letter-spacing:-0.035em; word-break:keep-all;">' + bQuote + '</div>' +
        (bible.quote_en ? '<div style="font-size:14px; font-style:italic; color:#7a7580; text-align:center; margin-top:12px;">' + bible.quote_en + '</div>' : "") +
        '<div style="font-size:13px; color:#7a7580; text-align:center; margin-top:14px;">\u2014 ' + (bible.author || "") + '</div>' +
        '<div style="margin-top:20px;">' + bParas + '</div>' +
      '</td></tr></table>';
  }

  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">' +
'<!--[if mso]><style type="text/css">body,table,td,div,p,span,a,b,h1,h2,h3 { font-family:\'Gulim\',\'\uAD74\uB9BC\',sans-serif !important; letter-spacing:0 !important; }</style><![endif]-->' +
'</head>' +
'<body style="margin:0; padding:0; background:#f3f1ef; font-family:' + font + ';">' +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f1ef" style="background:#f3f1ef;"><tr>' +
'<td align="center" style="padding:36px 12px 56px; font-family:' + font + '; word-break:keep-all;">' +

  '<table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="width:680px; max-width:680px; background:#ffffff; border:2px solid #d97c93; border-radius:16px; overflow:hidden;">' +

    // 헤더
    '<tr><td bgcolor="#ffffff" style="padding:18px 24px; border-bottom:1px solid #eae7e3;">' +
      '<div style="font-size:16px; font-weight:700; color:#2b2730; margin-bottom:12px;">\uC624\uB298\uB3C4 \u00B7 \uB2F9\uC2E0\uC744 \uC704\uD55C \uD55C \uD3B8</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
        '<td width="44" style="vertical-align:middle;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="38" height="38" bgcolor="' + PLUM + '" align="center" style="background:' + PLUM + '; border-radius:50%; color:#ffffff; font-weight:700; font-size:15px; line-height:38px;">' + badge + '</td></tr></table></td>' +
        '<td style="vertical-align:middle;"><div style="font-size:13px; font-weight:600; color:#2b2730;">' + fromName + ' <span style="color:#b0aab6; font-weight:400;">\uB2D8\uC774 \uBCF4\uB0C8\uC5B4\uC694. \uC624\uB298\uB3C4 \uCD5C\uACE0\uC758 \uD558\uB8E8\uAC00 \uB418\uAE38</span></div><div style="font-size:12px; color:#b0aab6;">\uC624\uB298\uB3C4 &lt;OND2U&gt;</div></td>' +
        '<td style="vertical-align:middle; text-align:right; font-size:12px; color:#b0aab6; line-height:1.5;">' + (toName ? "\uBC1B\uB294 \uC0AC\uB78C<br>" + toName : "\uBC1B\uB294 \uC0AC\uB78C") + '</td>' +
      '</tr></table>' +
    '</td></tr>' +

    // 본문
    '<tr><td bgcolor="#ffffff" style="padding:36px 28px 30px;">' +
      '<div style="text-align:center; font-size:20px; font-weight:800; letter-spacing:-0.04em; color:#2b2730; margin-bottom:22px;">\uC624\uB298\uB3C4 <span style="font-size:11px; font-weight:600; color:' + PLUM + '; letter-spacing:0.08em;">OND2U</span></div>' +
      '<div style="text-align:center; font-size:13px; color:#7a7580; margin:0 0 12px;"><b style="color:#2b2730;">' + fromName + '</b>\uB2D8\uC774 \uC624\uB298\uB3C4 \uBCF4\uB0C5\uB2C8\uB2E4</div>' +
      '<div style="text-align:center; font-size:14px; font-weight:600; color:' + PLUM + '; margin-bottom:14px;">\uC624\uB298\uB3C4 \uB2F9\uC2E0\uC758 \uCD5C\uACE0\uAC00 \uB420 \uAC81\uB2C8\uB2E4. \uD798\uB0B4\uC138\uC694.</div>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr><td width="30" height="3" bgcolor="' + PLUM + '" style="background:' + PLUM + '; font-size:0; line-height:3px; border-radius:3px;">&nbsp;</td></tr></table>' +
      spacer(24) +

      '<div style="font-size:10px; letter-spacing:0.18em; color:#b0aab6; text-align:center; margin-bottom:16px;">\uC624\uB298\uC758 \uD55C \uC904</div>' +
      '<div style="font-size:25px; line-height:1.5; font-weight:800; text-align:center; color:#2b2730; letter-spacing:-0.035em; word-break:keep-all;">' + brQuote + '</div>' +
      (normal.quote_en ? '<div style="font-size:14px; font-style:italic; color:#7a7580; text-align:center; margin-top:12px; line-height:1.5;">' + normal.quote_en + '</div>' : "") +
      '<div style="font-size:13px; color:#7a7580; text-align:center; margin-top:16px;">\u2014 ' + (normal.author || "") + '</div>' +

      // 에세이 카드 (보라 배경)
      spacer(30) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + PLUM + '" style="background:' + PLUM + '; border-radius:14px;"><tr><td style="padding:26px 24px;">' +
        (normal.essay_title ? '<div style="font-size:16px; font-weight:700; color:#ffffff; margin-bottom:14px;">' + normal.essay_title + '</div>' : "") +
        essayParas +
        '<div style="margin-top:20px; text-align:right; font-size:14px; font-weight:500; color:#ffffff;">' + josaGaI(fromName) + ' \uB4DC\uB824\uC694. \uC624\uB298\uB3C4 \uC88B\uC740 \uD558\uB8E8 \uB418\uC138\uC694 ^^</div>' +
      '</td></tr></table>' +

      // 처방 카드 (연보라)
      (normal.care_title ?
      spacer(30) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + PLUM_SOFT + '" style="background:' + PLUM_SOFT + '; border-radius:14px;"><tr><td style="padding:20px 22px;">' +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
          '<td width="48" style="vertical-align:middle;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="36" height="36" bgcolor="#ffffff" align="center" style="background:#ffffff; border-radius:10px; font-size:19px; line-height:36px;">' + careIc + '</td></tr></table></td>' +
          '<td style="vertical-align:middle;"><div style="font-size:10px; letter-spacing:0.1em; color:' + PLUM + ';">\uC624\uB298\uC758 \uC791\uC740 \uCC98\uBC29</div><div style="font-size:15px; font-weight:700; color:' + PLUM_DEEP + '; margin-top:2px;">' + normal.care_title + '</div></td>' +
        '</tr></table>' +
        '<div style="font-size:13px; line-height:1.8; color:#46414d; margin-top:11px;">' + (normal.care_body || "") + '</div>' +
      '</td></tr></table>' : "") +

      foodBlock +

      // 영상
      (normal.video_id ?
      spacer(32) +
      '<div style="font-size:10px; letter-spacing:0.16em; color:#b0aab6; margin-bottom:12px;">\uC624\uB298\uC758 \uC601\uC0C1</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #eae7e3; border-radius:12px; overflow:hidden;">' +
        '<tr><td style="padding:0; font-size:0; line-height:0;">' +
          '<a href="https://www.youtube.com/watch?v=' + normal.video_id + '" style="display:block; text-decoration:none;">' +
            '<img src="https://img.youtube.com/vi/' + normal.video_id + '/hqdefault.jpg" width="624" style="display:block; width:100%; max-width:100%; height:auto; border:0;" alt="">' +
          '</a>' +
        '</td></tr>' +
        '<tr><td bgcolor="#ffffff" style="background:#ffffff; padding:13px 16px;">' +
          '<a href="https://www.youtube.com/watch?v=' + normal.video_id + '" style="text-decoration:none;">' +
            '<div style="font-size:14px; font-weight:600; color:#2b2730;">' + (normal.video_title || "\uC624\uB298\uC758 \uC601\uC0C1") + '</div>' +
            '<div style="font-size:12px; color:#b0aab6; margin-top:3px;">\uB20C\uB7EC\uC11C \uC7AC\uC0DD</div>' +
          '</a>' +
        '</td></tr>' +
      '</table>' : "") +

      bibleBlock +

      // 반응 (로즈 포인트) — 아웃룩 호환: 버튼을 table 셀로 분리해 간격 확보
      spacer(32) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + PLUM_SOFT + '" style="background:' + PLUM_SOFT + '; border-radius:14px;"><tr><td align="center" style="padding:22px;">' +
        '<div style="font-size:13px; color:' + PLUM_DEEP + '; margin-bottom:16px;">\uC774 \uD3B8\uC9C0, ' + (toName ? toName + " \uB9C8\uC74C" : "\uB2F9\uC2E0 \uB9C8\uC74C") + '\uC5D4 \uC5B4\uB5A0\uC168\uC5B4\uC694?</div>' +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr>' +
          reactBtn(reactUrl("\uC704\uB85C\uB410\uC5B4\uC694"), "\uC704\uB85C\uB410\uC5B4\uC694 \u2661", PLUM_DEEP, ROSE) +
          '<td width="7" style="font-size:0; line-height:0;">&nbsp;</td>' +
          reactBtn(reactUrl("\uD798\uC774 \uB098\uC694"), "\uD798\uC774 \uB098\uC694", PLUM_DEEP, ROSE) +
          '<td width="7" style="font-size:0; line-height:0;">&nbsp;</td>' +
          reactBtn(reactUrl("\uACE0\uB9C8\uC6CC\uC694"), "\uACE0\uB9C8\uC6CC\uC694", PLUM_DEEP, ROSE) +
        '</tr></table>' +
      '</td></tr></table>' +

      // CTA
      spacer(30) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">' +
        '<a href="https://ond2u.com/app.html" style="display:inline-block; font-size:14px; font-weight:600; color:#ffffff; background:#2b2730; text-decoration:none; padding:13px 28px; border-radius:30px;">\uC624\uB298\uB3C4\uC5D0\uC11C \uB354 \uBCF4\uAE30 \u2192</a>' +
      '</td></tr></table>' +
    '</td></tr>' +

    // 푸터
    '<tr><td bgcolor="#f3f1ef" style="padding:22px 28px; border-top:1px solid #eae7e3; text-align:center;">' +
      '<div style="font-size:12px; color:#7a7580; line-height:1.7;"><b style="color:' + PLUM_DEEP + ';">' + fromName + '</b>\uB2D8\uC774 ' + (toName ? toName + "\uB97C" : "\uB2F9\uC2E0\uC744") + ' \uC0DD\uAC01\uD558\uBA70 \uBCF4\uB0B4\uB294 \uD3B8\uC9C0\uC608\uC694.</div>' +
      '<div style="font-size:11px; color:#b0aab6; margin-top:10px;">\uC774\uC81C \uADF8\uB9CC \uBC1B\uACE0 \uC2F6\uC73C\uC2DC\uBA74 <a href="' + unsubUrl + '" style="color:#b0aab6;">\uC5EC\uAE30</a>\uB97C \uB20C\uB7EC\uC8FC\uC138\uC694. \uC5B8\uC81C\uB4E0 \uAD1C\uCC2E\uC544\uC694.</div>' +
    '</td></tr>' +

  '</table>' +

  spacer(20) +
  '<div style="text-align:center; font-size:12px; color:#b0aab6;">\uC624\uB298\uB3C4 \u00B7 OND2U</div>' +

'</td></tr></table>' +
'</body></html>';
}
