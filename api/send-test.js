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
  // ── 환영 편지 (welcome=1) ── 가입 직후 첫 편지 1회. welcomed 플래그로 중복 방지(secret 불필요, 가입자 본인에게만 1회).
  if (req.query.welcome === "1") {
    return await runWelcome(req, res, { SB_URL, SB_SERVICE });
  }

  if (!isCron && !keyOk && !isAdmin)
    return res.status(401).json({ ok: false, error: "열쇠가 맞지 않아요." });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.ODO_FROM_EMAIL || "letter@ond2u.com";

  if (!RESEND_KEY || !SB_URL || !SB_SERVICE)
    return res.status(500).json({ ok: false, error: "서버 설정(환경변수)이 아직 안 됐어요." });

  // ── 월말 회고 편지 (recap=1) ── 지난달의 마음을 편지로 보내드려요
  if (req.query.recap === "1") {
    return await runMonthlyRecap(req, res, { SB_URL, SB_SERVICE, RESEND_KEY, FROM, SECRET });
  }

  const fromName = req.query.from_name || "윤기";
  const all = isCron || req.query.all === "1";   // cron 호출이거나 all=1 이면 수신자 전체 발송

  try {
    // 콘텐츠는 한 번만 불러와 재사용 (수신자가 여러 명이어도 창고는 1~2번만 읽음)
    const normalPool = await fetchContents(SB_URL, SB_SERVICE, "normal");
    if (!normalPool.length) throw new Error("창고에 일반 콘텐츠가 없어요.");
    const biblePool = await fetchContents(SB_URL, SB_SERVICE, "bible");
    const foodPool = await fetchFoods(SB_URL, SB_SERVICE);

    const cfg = { RESEND_KEY, FROM, fromName, normalPool, biblePool, foodPool, SB_URL, SB_SERVICE, SECRET };

    // ── 미리보기: 발송하지 않고 편지 HTML만 반환 ──
    if (req.query.preview === "1") {
      const pv = await sendOne({ ...cfg, preview: true, to: req.query.to || "preview@ond2u.com", toName: req.query.to_name || "", wantBible: req.query.bible === "1", senderId: req.query.sender_id || "", tone: req.query.tone || "", special: req.query.special || null, personalNote: req.query.note || "" });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(pv.html);
    }

    if (all) {
      // ── 전체 발송: 수신자 명단 전원에게 ──
      let recipients = await fetchRecipients(SB_URL, SB_SERVICE);
      recipients = recipients.filter(rc => !rc.paused);   // 쉬어가기(일시정지) 중인 사람은 발송 제외
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
          const id = await sendOne({ ...cfg, fromName: perFromName, to: rc.email, toName: rc.name || "", wantBible: rc.kind === "bible", senderId: rc.sender_id, tone: rc.tone || "", special: isSpecial ? (rc.special_label || "특별한 날") : null, personalNote: rc.personal_note || "" });
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
      const id = await sendOne({ ...cfg, to, toName, wantBible, senderId: req.query.sender_id || "", tone: req.query.tone || "", special: req.query.special || null, personalNote: req.query.note || "" });
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
async function sendOne({ RESEND_KEY, FROM, fromName, normalPool, biblePool, foodPool, to, toName, wantBible, senderId, tone, special, personalNote, welcome, preview, SB_URL, SB_SERVICE, SECRET }) {
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
    html = buildEmail({ fromName, toName, normal: pickN, bible: pickB, recipientEmail: to, senderId, secret: SECRET, foodPool, personalNote, welcome });
    quote = (pickN.quote || "").replace(/\\n/g, " ").slice(0, 80);
    const rcpName = (toName && toName !== "나에게") ? toName : "";
    if (welcome) {
      subject = rcpName ? (rcpName + "님, 오늘도에 오신 걸 환영해요 \uD83D\uDC8C") : "오늘도에 오신 걸 환영해요 \uD83D\uDC8C";
    } else {
    const subjPool = rcpName ? [
      rcpName + "님, 오늘의 편지가 도착했어요",
      rcpName + "님, 오늘 하루 어땠나요?",
      rcpName + "님을 위한 오늘의 한 줄",
      rcpName + "님, 잠깐 쉬어가요",
      rcpName + "님, 오늘의 마음을 전해요"
    ] : [
      "오늘의 편지가 도착했어요",
      "오늘 하루 어땠나요?",
      "오늘을 위한 한 줄",
      "잠깐 쉬어가요",
      "오늘의 마음을 전해요"
    ];
    subject = subjPool[Math.floor(Math.random() * subjPool.length)];
    }
  }
  if (preview) return { preview: true, html, subject };
  const logBase = { sender_id: senderId || null, sender_name: fromName, recipient_email: to, recipient_name: toName || "", content_quote: quote };

  try {
    const fromDisplay = (String(fromName || "오늘도").replace(/["<>\r\n]/g, "").trim() || "오늘도") + "님이 보냅니다.(오늘도)";
    const payload = JSON.stringify({
      from: '"' + fromDisplay + '" <' + FROM + ">",
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

  const isSelf = (toName === "\uB098\uC5D0\uAC8C");
  const who = toName || "\uB2F9\uC2E0";
  const isBirthday = /\uC0DD\uC77C|\uC0DD\uC2E0|birthday/i.test(label || "");
  const emoji = isBirthday ? "\uD83C\uDF82" : "\uD83C\uDF89";

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
  const bdaySelf = [
    "\uC624\uB298\uC740 \uB2F9\uC2E0\uC774 \uD0DC\uC5B4\uB09C \uB0A0\uC774\uC5D0\uC694. \uC2A4\uC2A4\uB85C\uC5D0\uAC8C \uCD95\uD558\uB97C \uAC74\uB124\uB3C4 \uC88B\uC740 \uB0A0\uC774\uC8E0. \uC62C \uD55C \uD574\uB3C4 \uC6C3\uC744 \uC77C\uC774 \uAC00\uB4DD\uD558\uAE38, \uAC74\uAC15\uD558\uACE0 \uD3C9\uC548\uD558\uAE38 \uBC14\uB77C\uC694.",
    "\uC77C \uB144 \uC911 \uAC00\uC7A5 \uBE5B\uB098\uB294 \uC624\uB298, \uB098\uB97C \uC704\uD55C \uC2DC\uAC04\uC744 \uC870\uAE08 \uB0B4\uC5B4\uBCF4\uC138\uC694. \uB2F9\uC2E0\uC740 \uCDA9\uBD84\uD788 \uCD95\uD558\uBC1B\uC544 \uB9C8\uB584\uD55C \uC0AC\uB78C\uC774\uC5D0\uC694.",
    "\uC0DD\uC77C \uCD95\uD558\uD574\uC694. \uADF8\uB3D9\uC548 \uC560\uC368 \uC628 \uB098\uC5D0\uAC8C, \uC624\uB298 \uD558\uB8E8\uB9CC\uD07C\uC740 \uB2E4\uC815\uD55C \uC2DC\uAC04\uC744 \uC120\uBB3C\uD574 \uC8FC\uC138\uC694."
  ];
  const anivSelf = [
    "\uC624\uB298\uC740 \uB2F9\uC2E0\uC5D0\uAC8C \uD2B9\uBCC4\uD55C \uB0A0\uC774\uC5D0\uC694. \uC2A4\uC2A4\uB85C \uCD95\uD558\uB97C \uAC74\uB124\uB3C4 \uC88B\uC544\uC694. \uC774 \uC88B\uC740 \uAE30\uC5B5\uC774 \uC624\uB798\uC624\uB798 \uB9C8\uC74C\uC5D0 \uB0A8\uAE30\uB97C \uBC14\uB77C\uC694.",
    "\uC78A\uC9C0 \uC54A\uACE0 \uCC59\uAE30\uACE0 \uC2F6\uC5C8\uB358 \uB0A0\uC774\uC5D0\uC694. \uC624\uB298 \uD558\uB8E8, \uB530\uD558\uACE0 \uD589\uBCF5\uD55C \uC2DC\uAC04 \uBCF4\uB0B4\uAE38 \uBC14\uB77C\uC694.",
    "\uD2B9\uBCC4\uD55C \uC624\uB298\uC744 \uCD95\uD558\uD574\uC694. \uC88B\uC740 \uC21C\uAC04\uC744 \uC2A4\uC2A4\uB85C\uC5D0\uAC8C \uC120\uBB3C\uD558\uB294 \uD558\uB8E8\uAC00 \uB418\uAE38 \uBC14\uB77C\uC694."
  ];
  const head = isSelf
    ? (isBirthday ? "\uC0DD\uC77C \uCD95\uD558\uD574\uC694" : ((label || "\uD2B9\uBCC4\uD55C \uB0A0") + " \uCD95\uD558\uD574\uC694"))
    : (isBirthday ? (who + "\uB2D8, \uC0DD\uC77C \uCD95\uD558\uD574\uC694") : (who + "\uB2D8, " + (label || "\uD2B9\uBCC4\uD55C \uB0A0") + " \uCD95\uD558\uD574\uC694"));
  const pool = isSelf ? (isBirthday ? bdaySelf : anivSelf) : (isBirthday ? bday : aniv);
  const msg = pool[Math.floor(Math.random() * pool.length)];

  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">' +
'<!--[if mso]><style type="text/css">body,table,td,div,p,span,a,b,h1,h2,h3 { font-family:\'Gulim\',\'\uAD74\uB9BC\',sans-serif !important; letter-spacing:0 !important; }</style><![endif]-->' +
'</head><body style="margin:0; padding:0; background:#f3f1ef; font-family:' + font + ';">' +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f1ef" style="background:#f3f1ef;"><tr>' +
'<td align="center" style="padding:36px 12px 56px; font-family:' + font + '; word-break:keep-all;">' +
  '<table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="width:680px; max-width:680px; background:#ffffff; border:2px solid ' + ROSE + '; border-radius:16px; overflow:hidden;">' +
    '<tr><td bgcolor="#ffffff" style="padding:18px 24px; border-bottom:1px solid #eae7e3;">' +
      '<div style="font-size:13px; color:#b0aab6;">' + (isSelf ? '\uC624\uB298, \uC2A4\uC2A4\uB85C\uC5D0\uAC8C \uAC74\uB124\uB294 \uD2B9\uBCC4\uD55C \uD3B8\uC9C0' : (fromName + '\uB2D8\uC774 ' + (toName ? toName + '\uB2D8\uC744 ' : '') + '\uC0DD\uAC01\uD558\uBA70 \uBCF4\uB0B4\uB294 \uD2B9\uBCC4\uD55C \uD3B8\uC9C0')) + '</div>' +
    '</td></tr>' +
    '<tr><td bgcolor="' + ROSE_SOFT + '" style="background:' + ROSE_SOFT + '; padding:42px 28px 34px; text-align:center;">' +
      '<div style="font-size:46px; line-height:1; margin-bottom:14px;">' + emoji + '</div>' +
      '<div style="font-size:26px; font-weight:800; color:' + PLUM_DEEP + '; letter-spacing:-0.03em; word-break:keep-all;">' + head + '</div>' +
    '</td></tr>' +
    '<tr><td bgcolor="#ffffff" style="padding:34px 30px 30px;">' +
      '<div style="font-size:16px; line-height:1.95; color:#3a3540; text-align:center; word-break:keep-all;">' + msg + '</div>' +
      spacer(24) +
      '<div style="text-align:center; font-size:15px; font-weight:600; color:' + ROSE + ';">' + (isSelf ? '\uC624\uB298\uB3C4\uAC00, \uB2F9\uC2E0\uC758 \uD558\uB8E8\uC5D0.' : (fromName + '\uC758 \uB9C8\uC74C\uC744 \uB2F4\uC544.')) + '</div>' +
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

// ===== 오늘의 한 줄 질문 (매일 하나씩 잔잔하게) =====
const DAILY_QUESTIONS = [
  "\uC624\uB298 \uB098\uC5D0\uAC8C \uAC00\uC7A5 \uACE0\uB9C8\uC6E0\uB358 \uC21C\uAC04\uC740 \uC5B8\uC81C\uC600\uB098\uC694?",
  "\uC9C0\uAE08 \uB0B4 \uB9C8\uC74C\uC740 \uC5B4\uB5A4 \uC0C9\uC5D0 \uAC00\uAE4C\uC6B4\uAC00\uC694?",
  "\uC624\uB298 \uD558\uB8E8, \uB098\uB97C \uC6C3\uAC8C \uD55C \uC791\uC740 \uAC83\uC740 \uBB34\uC5C7\uC774\uC5C8\uB098\uC694?",
  "\uC694\uC998 \uAC00\uC7A5 \uB9C8\uC74C\uC774 \uB180\uC774\uB294 \uC2DC\uAC04\uC740 \uC5B8\uC81C\uC778\uAC00\uC694?",
  "\uC624\uB298 \uB0B4\uAC00 \uB098\uC5D0\uAC8C \uD574\uC8FC\uACE0 \uC2F6\uC740 \uB9D0\uC740 \uBB34\uC5C7\uC778\uAC00\uC694?",
  "\uCD5C\uADFC\uC5D0 '\uCC38 \uB2E4\uD589\uC774\uB2E4' \uC2F6\uC5C8\uB358 \uC21C\uAC04\uC774 \uC788\uC5C8\uB098\uC694?",
  "\uC9C0\uAE08 \uC774 \uC21C\uAC04, \uB0B4 \uBAB8\uC740 \uC5B4\uB5A4 \uC26C\uD568\uC744 \uBC14\uB77C\uACE0 \uC788\uB098\uC694?",
  "\uC624\uB298 \uC2A4\uCCD0 \uC9C0\uB098\uAC14\uC9C0\uB9CC \uC608\uBABB\uD588\uB358 \uC7A5\uBA74\uC774 \uC788\uC5C8\uB098\uC694?",
  "\uC694\uC998 \uB098\uB97C \uAC00\uC7A5 \uD798\uB098\uAC8C \uD558\uB294 \uC0AC\uB78C\uC740 \uB204\uAD6C\uC778\uAC00\uC694?",
  "\uC624\uB298 \uD558\uB8E8 \uC911 \uB2E4\uC2DC \uC0B4\uACE0 \uC2F6\uC740 1\uBD84\uC774 \uC788\uB2E4\uBA74 \uC5B8\uC81C\uC778\uAC00\uC694?",
  "\uC9C0\uAE08 \uB0B4\uB824\uB193\uC544\uB3C4 \uAD1C\uCC2E\uC740 \uAC71\uC815\uC740 \uBB34\uC5C7\uC77C\uAE4C\uC694?",
  "\uC624\uB298 \uB098\uB294 \uBB34\uC5C7\uC5D0 \uAC00\uC7A5 \uB9C8\uC74C\uC744 \uB9CE\uC774 \uC37C\uB098\uC694?",
  "\uCD5C\uADFC\uC5D0 \uB9C8\uC74C\uC774 \uB530\uB73B\uD574\uC84C\uB358 \uB9D0 \uD55C\uB9C8\uB514\uAC00 \uC788\uC5C8\uB098\uC694?",
  "\uC624\uB298, \uB098\uC5D0\uAC8C \uC791\uC740 \uC120\uBB3C\uC744 \uC900\uB2E4\uBA74 \uBB34\uC5C7\uC744 \uC8FC\uACE0 \uC2F6\uB098\uC694?",
  "\uC694\uC998 \uB0B4\uAC00 \uC870\uAE08\uC529 \uB098\uC544\uC9C0\uACE0 \uC788\uB294 \uBD80\uBD84\uC740 \uBB34\uC5C7\uC778\uAC00\uC694?",
  "\uC624\uB298 \uD558\uB8E8\uB97C \uC0C9 \uD558\uB098\uB85C \uD45C\uD604\uD558\uBA74 \uC5B4\uB5A4 \uC0C9\uC77C\uAE4C\uC694?",
  "\uC624\uB298 \uB0B4\uAC00 \uC798 \uACAC\uB38C\uB0B8 \uC21C\uAC04\uC740 \uC5B8\uC81C\uC600\uB098\uC694?",
  "\uC694\uC998 \uB098\uB97C \uC124\uB808\uAC8C \uD558\uB294 \uC791\uC740 \uAE30\uB300\uAC00 \uC788\uB098\uC694?",
  "\uCD5C\uADFC\uC5D0 \uB098\uB3C4 \uBAA8\uB974\uAC8C \uBBF8\uC18C \uC9C0\uC5C8\uB358 \uC21C\uAC04\uC774 \uC788\uC5C8\uB098\uC694?",
  "\uC624\uB298, \uC870\uAE08 \uCC9C\uCC9C\uD788 \uD574\uB3C4 \uAD1C\uCC2E\uC740 \uC77C\uC740 \uBB34\uC5C7\uC77C\uAE4C\uC694?",
  "\uC694\uC998 \uB0B4\uAC00 \uAC00\uC7A5 \uB4E3\uACE0 \uC2F6\uC740 \uB9D0\uC740 \uBB34\uC5C7\uC778\uAC00\uC694?",
  "\uC9C0\uAE08 \uB0B4 \uACC1\uC5D0\uC11C \uB098\uB97C \uC9C0\uCF1C\uC8FC\uB294 \uAC83\uC740 \uBB34\uC5C7\uC778\uAC00\uC694?"
];
function pickDailyQuestion() {
  const k = new Date(Date.now() + 9 * 3600 * 1000); // KST
  const doy = Math.floor((Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - Date.UTC(k.getUTCFullYear(), 0, 0)) / 86400000);
  return DAILY_QUESTIONS[((doy % DAILY_QUESTIONS.length) + DAILY_QUESTIONS.length) % DAILY_QUESTIONS.length];
}

// ===== 요일별 인사 (요일마다 살짝 다른 결) =====
const WEEKDAY_GREETINGS = [
  "\uC624\uB298\uC740 \uC544\uBB34\uAC83\uB3C4 \uC548 \uD574\uB3C4 \uAD1C\uCC2E\uC740 \uB0A0\uC774\uC5D0\uC694.",
  "\uC0C8\uB85C\uC6B4 \uD55C \uC8FC, \uCC9C\uCC9C\uD788 \uC2DC\uC791\uD574\uB3C4 \uB3FC\uC694.",
  "\uC624\uB298\uB3C4 \uB2F9\uC2E0\uC758 \uC18D\uB3C4\uB85C \uAC78\uC5B4\uAC00\uC694.",
  "\uD55C \uC8FC\uC758 \uD55C\uAC00\uC6B4\uB370, \uC7A0\uAE50 \uC228 \uACE0\uB974\uBA70 \uAC00\uC694.",
  "\uC870\uAE08\uB9CC \uB354, \uC798 \uD574\uC624\uACE0 \uC788\uC5B4\uC694.",
  "\uD55C \uC8FC \uC560\uC4F4 \uB2F9\uC2E0, \uC815\uB9D0 \uACE0\uC0DD \uB9CE\uC558\uC5B4\uC694.",
  "\uC624\uB298\uC740 \uB2F9\uC2E0\uC744 \uC704\uD55C \uC5EC\uC720\uB97C \uCC59\uACA8\uBCF4\uC138\uC694."
];
function pickWeekdayGreeting() {
  const k = new Date(Date.now() + 9 * 3600 * 1000); // KST
  return WEEKDAY_GREETINGS[k.getUTCDay()];
}

function buildEmail({ fromName, toName, normal, bible, recipientEmail, senderId, secret, foodPool, personalNote, welcome }) {
  const nl = s => (s || "").replace(/\\n/g, "\n");
  const escHtml = s => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  // 한마디가 여러 줄이면 날마다 번갈아 하나만 실어요
  const _notes = String(personalNote || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let _pickedNote = "";
  if (_notes.length) {
    const _now = new Date();
    const _start = new Date(_now.getFullYear(), 0, 0);
    const _doy = Math.floor((_now - _start) / 86400000);
    _pickedNote = _notes[_doy % _notes.length];
  }
  const noteHtml = _pickedNote ? escHtml(_pickedNote) : "";
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
  const todayQuestion = pickDailyQuestion();
  const weekdayGreeting = pickWeekdayGreeting();
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
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;"><tr>' +
        '<td style="vertical-align:middle; font-size:16px; font-weight:700; color:#2b2730;">\uC624\uB298\uB3C4 \u00B7 \uB2F9\uC2E0\uC744 \uC704\uD55C \uD55C \uD3B8</td>' +
        '<td style="vertical-align:middle; text-align:right;"><a href="https://ond2u.com/app.html" style="display:inline-block; font-size:12px; font-weight:600; color:' + PLUM + '; background:#f4eef7; text-decoration:none; padding:8px 14px; border-radius:20px; white-space:nowrap;">\uC624\uB298\uB3C4\uC5D0\uC11C \uBCF4\uAE30 \u2192</a></td>' +
      '</tr></table>' +
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
      '<div style="text-align:center; font-size:14px; font-weight:600; color:' + PLUM + '; margin-bottom:6px;">' + weekdayGreeting + '</div>' +
      '<div style="text-align:center; font-size:14px; font-weight:600; color:' + PLUM + '; margin-bottom:14px;">\uC624\uB298\uB3C4 \uB2F9\uC2E0\uC758 \uCD5C\uACE0\uAC00 \uB420 \uAC81\uB2C8\uB2E4. \uD798\uB0B4\uC138\uC694.</div>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr><td width="30" height="3" bgcolor="' + PLUM + '" style="background:' + PLUM + '; font-size:0; line-height:3px; border-radius:3px;">&nbsp;</td></tr></table>' +
      spacer(24) +

      (welcome ?
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#efecf4" style="background:#efecf4; border-radius:14px; border:1px solid #d8d0e4;"><tr><td style="padding:22px; text-align:center;">' +
          '<div style="font-size:28px; margin-bottom:8px;">\uD83D\uDC8C</div>' +
          '<div style="font-size:16px; font-weight:800; color:#33283f; margin-bottom:8px;">\uC624\uB298\uB3C4\uC5D0 \uC624\uC2E0 \uAC78 \uD658\uC601\uD574\uC694</div>' +
          '<div style="font-size:13px; line-height:1.75; color:#5a5560;">\uC624\uB298\uBD80\uD130 \uB9E4\uC77C, \uD55C \uD3B8\uC758 \uC704\uB85C\uAC00 \uB2F9\uC2E0\uC5D0\uAC8C \uB2FF\uC744 \uAC70\uC608\uC694. \uCCAB \uD3B8\uC9C0\uB97C \uC804\uD574\uC694.</div>' +
        '</td></tr></table>' + spacer(24)
      : "") +

      (noteHtml ?
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fdeef2" style="background:#fdeef2; border-radius:14px; border:1px solid #f3c9d5;"><tr><td style="padding:20px 22px;">' +
          '<div style="font-size:11px; letter-spacing:0.1em; color:' + ROSE + '; margin-bottom:9px;">' + escHtml(fromName) + '\uB2D8\uC758 \uD55C\uB9C8\uB514</div>' +
          '<div style="font-size:15px; line-height:1.75; color:#4a3540; word-break:keep-all;">' + noteHtml + '</div>' +
        '</td></tr></table>' + spacer(26)
      : "") +

      '<div style="font-size:10px; letter-spacing:0.18em; color:#b0aab6; text-align:center; margin-bottom:16px;">\uC624\uB298\uC758 \uD55C \uC904</div>' +
      '<div style="font-size:25px; line-height:1.5; font-weight:800; text-align:center; color:#2b2730; letter-spacing:-0.035em; word-break:keep-all;">' + brQuote + '</div>' +
      (normal.quote_en ? '<div style="font-size:14px; font-style:italic; color:#7a7580; text-align:center; margin-top:12px; line-height:1.5;">' + normal.quote_en + '</div>' : "") +
      '<div style="font-size:13px; color:#7a7580; text-align:center; margin-top:16px;">\u2014 ' + (normal.author || "") + '</div>' +

      // 에세이 카드 (보라 배경)
      spacer(30) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + PLUM + '" style="background:' + PLUM + '; border-radius:14px;"><tr><td style="padding:26px 24px;">' +
        (normal.essay_title ? '<div style="font-size:16px; font-weight:700; color:#ffffff; margin-bottom:14px;">' + normal.essay_title + '</div>' : "") +
        essayParas +
        '<div style="margin-top:20px; text-align:right; font-size:14px; font-weight:500; color:#ffffff;">' + fromName + '\uB2D8\uC774 \uB4DC\uB824\uC694. \uC624\uB298\uB3C4 \uC88B\uC740 \uD558\uB8E8 \uB418\uC138\uC694 ^^</div>' +
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

      // 오늘의 한 줄 질문
      spacer(30) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px dashed ' + ROSE + '; border-radius:14px;"><tr><td style="padding:20px 22px; text-align:center;">' +
        '<div style="font-size:11px; letter-spacing:0.02em; color:' + ROSE + '; margin-bottom:10px;">\uC624\uB298, \uC2A4\uC2A4\uB85C\uC5D0\uAC8C \uAC00\uBCCD\uAC8C \uD55C\uBC88 \uBB3C\uC5B4\uBCF4\uC138\uC694.</div>' +
        '<div style="font-size:15px; font-weight:600; line-height:1.7; color:' + PLUM_DEEP + ';">' + todayQuestion + '</div>' +
      '</td></tr></table>' +

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

// ===== 월말 회고 편지 =====
const RECAP_GROUP = {
  "지침":"heavy","번아웃":"heavy","슬픔":"heavy","외로움":"heavy",
  "불안":"anx","초조":"anx","막막":"anx","화남":"anx","미룸":"anx",
  "의욕":"bright","설렘":"bright","평온":"bright","감사":"bright","시작":"bright"
};

async function runMonthlyRecap(req, res, env) {
  const { SB_URL, SB_SERVICE, RESEND_KEY, FROM, SECRET } = env;
  const H = { "apikey":SB_SERVICE, "Authorization":"Bearer "+SB_SERVICE, "Content-Type":"application/json" };

  // 지난달 범위 (KST) → UTC 변환
  const nowKst = new Date(Date.now() + 9*3600*1000);
  let y = nowKst.getUTCFullYear(), m = nowKst.getUTCMonth(); // 이번 달(0~11)
  if (req.query.month) { const mm = String(req.query.month).split("-"); y = parseInt(mm[0],10); m = parseInt(mm[1],10) - 1; }
  const prevFirstKstMs = Date.UTC(y, m-1, 1, 0,0,0);
  const thisFirstKstMs = Date.UTC(y, m, 1, 0,0,0);
  const startUtc = new Date(prevFirstKstMs - 9*3600*1000).toISOString();
  const endUtc = new Date(thisFirstKstMs - 9*3600*1000).toISOString();
  const label = (((m-1)+12)%12 + 1) + "월";
  const onlyEmail = (req.query.only || "").trim().toLowerCase();

  async function getAll(path){
    try { const r = await fetch(SB_URL + "/rest/v1/" + path, { headers:H }); return await r.json(); }
    catch(e){ return []; }
  }
  const [users, moods, saved, reactions] = await Promise.all([
    getAll("odo_users?select=id,email,display_name"),
    getAll("odo_moods?select=user_id,mood,created_at&created_at=gte."+encodeURIComponent(startUtc)+"&created_at=lt."+encodeURIComponent(endUtc)),
    getAll("odo_saved?select=user_id,saved_at&saved_at=gte."+encodeURIComponent(startUtc)+"&saved_at=lt."+encodeURIComponent(endUtc)),
    getAll("odo_reactions?select=sender_id,created_at&created_at=gte."+encodeURIComponent(startUtc)+"&created_at=lt."+encodeURIComponent(endUtc))
  ]);
  if (!Array.isArray(users)) return res.status(500).json({ ok:false, error:"회원을 불러오지 못했어요." });

  const stat = {};
  const ensure = id => (stat[id] = stat[id] || { gc:{heavy:0,anx:0,bright:0}, moodCount:0, savedN:0, reactCount:0 });
  (Array.isArray(moods)?moods:[]).forEach(r=>{ const s=ensure(r.user_id); s.moodCount++; const g=RECAP_GROUP[r.mood]; if(g) s.gc[g]++; });
  (Array.isArray(saved)?saved:[]).forEach(r=>{ ensure(r.user_id).savedN++; });
  (Array.isArray(reactions)?reactions:[]).forEach(r=>{ ensure(r.sender_id).reactCount++; });

  let sent = 0, skipped = 0, failed = 0;
  const results = [];
  for (const u of users) {
    if (!u.email) { skipped++; continue; }
    if (onlyEmail && String(u.email).toLowerCase() !== onlyEmail) continue;
    const s = stat[u.id];
    if (!s || (s.moodCount===0 && s.savedN===0 && s.reactCount===0)) { skipped++; continue; }
    const name = (u.display_name && u.display_name.trim()) || "당신";
    const narr = buildRecapNarr(label, s);
    const html = buildRecapEmail({ name, label, narr, s, email:u.email, secret:SECRET });
    const subject = label + ", 당신의 마음을 담았어요";
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method:"POST",
        headers:{ "Authorization":"Bearer "+RESEND_KEY, "Content-Type":"application/json" },
        body: JSON.stringify({ from: "오늘도 <"+FROM+">", to:[u.email], subject, html })
      });
      if (r.ok) { sent++; results.push({ email:u.email, ok:true }); }
      else { failed++; const t = await r.text().catch(()=> ""); results.push({ email:u.email, ok:false, error:t.slice(0,120) }); }
    } catch(e){ failed++; results.push({ email:u.email, ok:false, error:String(e&&e.message||e) }); }
  }
  return res.status(200).json({ ok:true, month:label, sent, skipped, failed, results });
}

function buildRecapNarr(label, s){
  const parts = [];
  if (s.moodCount>0) parts.push(label+", 당신은 <b>"+s.moodCount+"</b>번 마음을 남겼어요.");
  let dom=null, max=0;
  for (const k of ["heavy","anx","bright"]) { if (s.gc[k]>max){ max=s.gc[k]; dom=k; } }
  if (dom==="heavy") parts.push("무거운 마음의 날이 많았지만, 그래도 매번 자신을 들여다본 당신이에요.");
  else if (dom==="anx") parts.push("마음이 분주한 날이 많았던 한 달이었어요. 그 속에서도 잠깐 멈춰 자신을 살핀 당신이 대견해요.");
  else if (dom==="bright") parts.push("밝은 마음이 자주 머문 한 달이었네요.");
  let sr="";
  if (s.savedN>0 && s.reactCount>0) sr="<b>"+s.savedN+"</b>편의 글을 마음에 담았고, <b>"+s.reactCount+"</b>번의 따뜻한 반응이 오갔어요.";
  else if (s.savedN>0) sr="<b>"+s.savedN+"</b>편의 글을 마음에 담았어요.";
  else if (s.reactCount>0) sr="<b>"+s.reactCount+"</b>번의 따뜻한 반응이 오갔어요.";
  if (sr) parts.push(sr);
  if (dom==="heavy") parts.push("그 발걸음 하나하나가, 이미 잘 버텨온 증거예요.");
  else if (dom==="bright") parts.push("그 온기가 다음 달까지 이어지길 바라요.");
  else if (dom==="anx") parts.push("조급하지 않아도 괜찮아요. 당신은 충분히 잘 하고 있어요.");
  else parts.push("이 모든 결이, 다 당신이었어요.");
  return parts.join(" ");
}

function buildRecapEmail({ name, label, narr, s, email, secret }) {
  const PLUM = "#423458", PLUM_DEEP = "#2f2440";
  const font = "'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif";
  const spacer = h => '<div style="height:'+h+'px; line-height:'+h+'px; font-size:0;">&nbsp;</div>';
  const rParam = encodeURIComponent(email || "");
  const tok = secret ? crypto.createHmac("sha256", secret).update(email || "").digest("hex").slice(0,32) : "";
  const unsubUrl = "https://www.ond2u.com/api/unsubscribe?e=" + rParam + "&t=" + tok;
  const box = (n, lbl) => '<td align="center" style="padding:0 6px;"><div style="background:#f7f4f6; border-radius:12px; padding:16px 8px;"><div style="font-size:24px; font-weight:800; color:'+PLUM_DEEP+';">'+n+'</div><div style="font-size:12px; color:#7a7580; margin-top:4px;">'+lbl+'</div></div></td>';
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"></head>' +
'<body style="margin:0; padding:0; background:#f3f1ef; font-family:'+font+';">' +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f1ef" style="background:#f3f1ef;"><tr>' +
'<td align="center" style="padding:36px 12px 56px; font-family:'+font+'; word-break:keep-all;">' +
  '<table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="width:680px; max-width:680px; background:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #eee;">' +
    '<tr><td bgcolor="'+PLUM+'" style="background:'+PLUM+'; padding:34px 28px; text-align:center;">' +
      '<div style="font-size:11px; letter-spacing:0.18em; color:rgba(255,255,255,.72); margin-bottom:10px;">지난달의 오늘도</div>' +
      '<div style="font-size:26px; font-weight:800; color:#ffffff; letter-spacing:-0.03em;">'+label+', 당신의 마음</div>' +
    '</td></tr>' +
    '<tr><td bgcolor="#ffffff" style="padding:34px 30px 8px;">' +
      '<div style="font-size:15px; color:#3a3540; margin-bottom:18px;"><b>'+name+'</b>님, 지난 한 달을 함께 돌아볼게요.</div>' +
      '<div style="font-size:16px; line-height:1.95; color:#3a3540;">'+narr+'</div>' +
      spacer(26) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
        box(s.savedN, "담은 글") + box(s.moodCount, "남긴 마음") + box(s.reactCount, "받은 반응") +
      '</tr></table>' +
      spacer(28) +
      '<div style="background:#fdeef2; border-radius:14px; padding:22px 24px; text-align:center;">' +
        '<div style="font-size:14px; line-height:1.8; color:'+PLUM_DEEP+';">이렇게 쌓인 하루하루가,<br>언젠가 세상에 단 하나뿐인 위로 책이 되기를 꿈꿔요.</div>' +
      '</div>' +
      spacer(24) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">' +
        '<a href="https://ond2u.com/app.html" style="display:inline-block; font-size:14px; font-weight:600; color:#ffffff; background:'+PLUM+'; text-decoration:none; padding:13px 28px; border-radius:30px;">오늘도에서 돌아보기 →</a>' +
      '</td></tr></table>' +
      spacer(20) +
    '</td></tr>' +
    '<tr><td bgcolor="#f3f1ef" style="padding:20px 28px; border-top:1px solid #eae7e3; text-align:center;">' +
      '<div style="font-size:11px; color:#b0aab6;">회고 편지를 그만 받고 싶으시면 <a href="'+unsubUrl+'" style="color:#b0aab6;">여기</a>를 눌러주세요.</div>' +
    '</td></tr>' +
  '</table>' +
  spacer(18) +
  '<div style="text-align:center; font-size:12px; color:#b0aab6;">오늘도 · OND2U</div>' +
'</td></tr></table></body></html>';
}

// ===== 환영 편지 (가입 직후 1회) =====
async function runWelcome(req, res, { SB_URL, SB_SERVICE }) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.ODO_FROM_EMAIL || "letter@ond2u.com";
  const SECRET = process.env.CRON_SECRET;
  const to = (req.query.to || "").toString().trim();
  if (!to || !RESEND_KEY || !SB_URL || !SB_SERVICE) return res.status(200).json({ ok: false });
  const H = { apikey: SB_SERVICE, Authorization: "Bearer " + SB_SERVICE, "Content-Type": "application/json" };
  try {
    // 가입자 조회 (welcomed 플래그로 1회 제한)
    const ur = await fetch(SB_URL + "/rest/v1/odo_users?email=eq." + encodeURIComponent(to) + "&select=id,display_name,welcomed", { headers: H });
    if (!ur.ok) return res.status(200).json({ ok: false });
    const rows = await ur.json();
    const u = rows[0];
    if (!u) return res.status(200).json({ ok: false, reason: "not_member" });
    if (u.welcomed) return res.status(200).json({ ok: true, already: true });

    const name = ((u.display_name || "").trim());
    const normalPool = await fetchContents(SB_URL, SB_SERVICE, "normal");
    if (!normalPool.length) return res.status(200).json({ ok: false, reason: "no_content" });
    const foodPool = await fetchFoods(SB_URL, SB_SERVICE);

    await sendOne({
      RESEND_KEY, FROM, fromName: "오늘도", normalPool, biblePool: [], foodPool,
      to, toName: name || "", wantBible: false, senderId: u.id || "", tone: "",
      special: null, personalNote: "", welcome: true, SB_URL, SB_SERVICE, SECRET
    });

    // 다시 안 보내도록 표시
    await fetch(SB_URL + "/rest/v1/odo_users?id=eq." + encodeURIComponent(u.id), {
      method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify({ welcomed: true })
    });
    return res.status(200).json({ ok: true, sent: true });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
