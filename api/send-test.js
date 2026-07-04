// OND2U 이메일 발송 함수 (6-2단계: 나에게 테스트 한 통)
// - 창고(Supabase)에서 명언(+성경 선택시 성경) 꺼내서
// - 원래 메일 폼(오늘도_메일_미리보기_v2) 디자인 그대로, Pretendard 적용해 발송
// - 비밀 키는 Vercel 환경변수에서만 읽음
//
// 호출: /api/send-test?key=<CRON_SECRET>&to=<이메일>&from_name=<이름>&to_name=<받는사람>&bible=<1이면 성경도>

export const config = { maxDuration: 60 };

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

    const cfg = { RESEND_KEY, FROM, fromName, normalPool, biblePool, SB_URL, SB_SERVICE };

    if (all) {
      // ── 전체 발송: 수신자 명단 전원에게 ──
      const recipients = await fetchRecipients(SB_URL, SB_SERVICE);
      if (!recipients.length)
        return res.status(200).json({ ok: true, message: "보낼 수신자가 없어요. (odo_recipients 비어있음)", sent: 0 });

      const results = [];
      for (const rc of recipients) {
        try {
          const id = await sendOne({ ...cfg, to: rc.email, toName: rc.name || "", wantBible: rc.kind === "bible", senderId: rc.sender_id });
          results.push({ email: rc.email, ok: true, id });
        } catch (e) {
          results.push({ email: rc.email, ok: false, error: String(e && e.message || e) });
        }
      }
      const okCount = results.filter(x => x.ok).length;
      return res.status(200).json({ ok: true, message: okCount + "/" + results.length + "명에게 보냈어요.", sent: okCount, total: results.length, results });
    } else {
      // ── 단일 발송: 한 명에게 (기존 테스트 방식) ──
      const to = req.query.to;
      if (!to) return res.status(400).json({ ok: false, error: "받을 이메일(to)이 없어요. (전체 발송은 주소 끝에 all=1)" });
      const toName = req.query.to_name || "";
      const wantBible = req.query.bible === "1";
      const id = await sendOne({ ...cfg, to, toName, wantBible, senderId: req.query.sender_id || "" });
      return res.status(200).json({ ok: true, message: "보냈어요!", to, id });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}

// 수신자 한 명에게 발송 (콘텐츠 풀에서 랜덤으로 뽑아 메일 만들어 Resend로)
async function sendOne({ RESEND_KEY, FROM, fromName, normalPool, biblePool, to, toName, wantBible, senderId, SB_URL, SB_SERVICE }) {
  const pickN = normalPool[Math.floor(Math.random() * normalPool.length)];
  let pickB = null;
  if (wantBible && biblePool.length) pickB = biblePool[Math.floor(Math.random() * biblePool.length)];

  const html = buildEmail({ fromName, toName, normal: pickN, bible: pickB, recipientEmail: to, senderId });
  const quote = (pickN.quote || "").replace(/\\n/g, " ").slice(0, 80);
  const logBase = { sender_id: senderId || null, sender_name: fromName, recipient_email: to, recipient_name: toName || "", content_quote: quote };

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: '"오늘도/OND2U" <' + FROM + ">",
        to: [to],
        subject: fromName + "님이 오늘도 보냅니다",
        html
      })
    });
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

// 이름 뒤 조사(가/이) 자동 처리
function josaGaI(name) {
  if (!name) return "";
  const c = name.charCodeAt(name.length - 1);
  if (c < 0xAC00 || c > 0xD7A3) return name + "가";
  return name + (((c - 0xAC00) % 28 !== 0) ? "이" : "가");
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

function buildEmail({ fromName, toName, normal, bible, recipientEmail, senderId }) {
  const nl = s => (s || "").replace(/\\n/g, "\n");
  // 반응 버튼이 눌리면 이 주소로 이동 → api/react 가 창고에 기록
  const rParam = encodeURIComponent(recipientEmail || "");
  const sParam = encodeURIComponent(senderId || "");
  const qParam = encodeURIComponent(nl(normal.quote).replace(/\n/g, " ").slice(0, 60));
  const reactUrl = em => "https://ond2u.vercel.app/api/react?e=" + encodeURIComponent(em) + "&r=" + rParam + "&s=" + sParam + "&q=" + qParam;
  const brQuote = nl(normal.quote).replace(/\n/g, "<br>");
  const essayParas = nl(normal.essay).split("\n\n").filter(Boolean)
    .map(p => '<p style="font-size:14px; line-height:1.95; color:#e9e5f0; margin:0 0 13px;">' + p.replace(/\n/g,"<br>") + '</p>').join("");
  const careIc = careEmoji(normal.care_icon);
  const badge = fromName.charAt(0);
  const toLine = toName ? ("받는 사람<br>" + toName) : "받는 사람";
  const font = "'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif";

  let bibleBlock = "";
  if (bible) {
    const bQuote = nl(bible.quote).replace(/\n/g, "<br>");
    const bParas = nl(bible.essay).split("\n\n").filter(Boolean)
      .map(p => '<p style="font-size:14px; line-height:1.95; color:#46414d; margin:0 0 13px;">' + p.replace(/\n/g,"<br>") + '</p>').join("");
    bibleBlock =
      '<div style="margin-top:34px; padding-top:28px; border-top:1px solid #eae7e3;">' +
        '<div style="font-size:11px; letter-spacing:0.08em; color:#5a4a7a; font-weight:700; text-align:center; margin-bottom:16px;">✝ 하나님께서 오늘 주신 말씀입니다</div>' +
        '<div style="font-size:22px; line-height:1.5; font-weight:800; text-align:center; color:#2b2730; letter-spacing:-0.035em; word-break:keep-all;">' + bQuote + '</div>' +
        (bible.quote_en ? '<div style="font-size:14px; font-style:italic; color:#7a7580; text-align:center; margin-top:12px;">' + bible.quote_en + '</div>' : "") +
        '<div style="font-size:13px; color:#7a7580; text-align:center; margin-top:14px;">— ' + (bible.author || "") + '</div>' +
        '<div style="margin-top:20px;">' + bParas + '</div>' +
      '</div>';
  }

  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">' +
'</head>' +
'<body style="margin:0; padding:0; background:#f3f1ef; font-family:' + font + '; -webkit-font-smoothing:antialiased;">' +
'<div style="max-width:560px; margin:0 auto; padding:40px 20px 60px; word-break:keep-all; font-family:' + font + ';">' +

  '<div style="background:#ffffff; border:1px solid #ddd8d3; border-radius:16px; overflow:hidden; box-shadow:0 10px 40px rgba(70,50,70,.08);">' +

    '<div style="padding:18px 24px; border-bottom:1px solid #eae7e3;">' +
      '<div style="font-size:16px; font-weight:700; color:#2b2730; margin-bottom:12px;">오늘도 · 당신을 위한 한 편</div>' +
      '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
        '<td style="width:44px; vertical-align:middle;"><div style="width:38px; height:38px; border-radius:50%; background:#5a4a7a; color:#fff; text-align:center; line-height:38px; font-weight:700; font-size:15px;">' + badge + '</div></td>' +
        '<td style="vertical-align:middle;"><div style="font-size:13px; font-weight:600; color:#2b2730;">' + fromName + ' <span style="color:#b0aab6; font-weight:400;">님이 보냄</span></div><div style="font-size:12px; color:#b0aab6;">오늘도 &lt;OND2U&gt;</div></td>' +
        '<td style="vertical-align:middle; text-align:right; font-size:12px; color:#b0aab6; line-height:1.5;">' + toLine + '</td>' +
      '</tr></table>' +
    '</div>' +

    '<div style="padding:36px 32px 30px;">' +
      '<div style="text-align:center; font-size:20px; font-weight:800; letter-spacing:-0.04em; color:#2b2730; margin-bottom:22px;">오늘도 <span style="font-size:11px; font-weight:600; color:#5a4a7a; letter-spacing:0.08em;">OND2U</span></div>' +

      '<div style="text-align:center; font-size:13px; color:#7a7580; margin:0 0 12px;"><span style="display:inline-block; width:22px; height:22px; border-radius:50%; background:#5a4a7a; color:#fff; line-height:22px; font-size:11px; font-weight:700; vertical-align:middle;">' + badge + '</span> <b style="color:#2b2730;">' + fromName + '</b>님이 오늘도 보냅니다</div>' +

      '<div style="text-align:center; font-size:14px; font-weight:600; color:#5a4a7a; margin-bottom:14px;">오늘도 당신의 최고가 될 겁니다. 힘내세요.</div>' +
      '<div style="width:30px; height:3px; background:#5a4a7a; opacity:.5; margin:0 auto 32px; border-radius:3px;"></div>' +

      '<div style="font-size:10px; letter-spacing:0.18em; text-transform:uppercase; color:#b0aab6; text-align:center; margin-bottom:16px;">오늘의 한 줄</div>' +
      '<div style="font-size:26px; line-height:1.5; font-weight:800; text-align:center; color:#2b2730; letter-spacing:-0.035em; word-break:keep-all;">' + brQuote + '</div>' +
      (normal.quote_en ? '<div style="font-size:14px; font-style:italic; color:#7a7580; text-align:center; margin-top:12px; line-height:1.5;">' + normal.quote_en + '</div>' : "") +
      '<div style="font-size:13px; color:#7a7580; text-align:center; margin-top:16px;">— ' + (normal.author || "") + '</div>' +

      '<div style="margin-top:30px; background:#5a4a7a; border-radius:14px; padding:26px 24px;">' +
        (normal.essay_title ? '<div style="font-size:16px; font-weight:700; color:#ffffff; margin-bottom:14px;">' + normal.essay_title + '</div>' : "") +
        essayParas +
        '<div style="margin-top:20px; text-align:right; font-size:14px; font-weight:500; color:#ffffff;">' + josaGaI(fromName) + ' 드려요. 오늘도 좋은 하루 되세요 ^^</div>' +
      '</div>' +

      (normal.care_title ?
      '<div style="margin-top:30px; background:#efecf4; border-radius:14px; padding:20px 22px;">' +
        '<table cellpadding="0" cellspacing="0"><tr>' +
          '<td style="width:48px; vertical-align:middle;"><div style="width:36px; height:36px; border-radius:10px; background:#fff; text-align:center; line-height:36px; font-size:19px;">' + careIc + '</div></td>' +
          '<td style="vertical-align:middle;"><div style="font-size:10px; letter-spacing:0.1em; color:#5a4a7a;">오늘의 작은 처방</div><div style="font-size:15px; font-weight:700; color:#453961; margin-top:2px;">' + normal.care_title + '</div></td>' +
        '</tr></table>' +
        '<div style="font-size:13px; line-height:1.8; color:#46414d; margin-top:11px;">' + (normal.care_body || "") + '</div>' +
      '</div>' : "") +

      (normal.video_id ?
      '<div style="margin-top:32px;">' +
        '<div style="font-size:10px; letter-spacing:0.16em; text-transform:uppercase; color:#b0aab6; margin-bottom:12px;">오늘의 영상</div>' +
        '<a href="https://www.youtube.com/watch?v=' + normal.video_id + '" style="display:block; text-decoration:none; border:1px solid #eae7e3; border-radius:12px; overflow:hidden;">' +
          '<img src="https://img.youtube.com/vi/' + normal.video_id + '/hqdefault.jpg" width="100%" style="display:block; width:100%;" alt="">' +
          '<div style="padding:13px 16px;"><div style="font-size:14px; font-weight:600; color:#2b2730;">' + (normal.video_title || "오늘의 영상") + '</div><div style="font-size:12px; color:#b0aab6; margin-top:3px;">눌러서 재생</div></div>' +
        '</a>' +
      '</div>' : "") +

      bibleBlock +

      '<div style="margin-top:32px; padding:22px; background:#efecf4; border-radius:14px; text-align:center;">' +
        '<div style="font-size:13px; color:#453961; margin-bottom:14px;">이 편지, ' + (toName ? toName + " 마음" : "당신 마음") + '엔 어떠셨어요?</div>' +
        '<div>' +
          '<a href="' + reactUrl("위로됐어요") + '" style="display:inline-block; font-size:13px; color:#453961; background:#fff; border:1px solid #5a4a7a; border-radius:30px; padding:8px 14px; text-decoration:none; margin:3px;">위로됐어요 \u2661</a>' +
          '<a href="' + reactUrl("힘이 나요") + '" style="display:inline-block; font-size:13px; color:#453961; background:#fff; border:1px solid #5a4a7a; border-radius:30px; padding:8px 14px; text-decoration:none; margin:3px;">힘이 나요</a>' +
          '<a href="' + reactUrl("고마워요") + '" style="display:inline-block; font-size:13px; color:#453961; background:#fff; border:1px solid #5a4a7a; border-radius:30px; padding:8px 14px; text-decoration:none; margin:3px;">고마워요</a>' +
        '</div>' +
      '</div>' +

      '<div style="margin-top:30px; text-align:center;">' +
        '<a href="https://ond2u.vercel.app/app.html" style="display:inline-block; font-size:14px; font-weight:600; color:#fff; background:#2b2730; text-decoration:none; padding:13px 28px; border-radius:30px;">오늘도에서 더 보기 \u2192</a>' +
      '</div>' +
    '</div>' +

    '<div style="padding:22px 32px; border-top:1px solid #eae7e3; background:#f3f1ef; text-align:center;">' +
      '<div style="font-size:12px; color:#7a7580; line-height:1.7;"><b style="color:#453961;">' + fromName + '</b>님이 ' + (toName ? toName + "를" : "당신을") + ' 생각하며 보내는 편지예요.</div>' +
      '<div style="font-size:11px; color:#b0aab6; margin-top:10px;">이제 그만 받고 싶으시면 <a href="#" style="color:#b0aab6;">여기</a>를 눌러주세요. 언제든 괜찮아요.</div>' +
    '</div>' +
  '</div>' +

  '<div style="text-align:center; font-size:12px; color:#b0aab6; margin-top:20px;">오늘도 · OND2U</div>' +
'</div>' +
'</body></html>';
}
