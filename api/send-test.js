// OND2U 이메일 발송 함수 (6-2단계: 나에게 테스트 한 통)
// - 창고(Supabase)에서 명언(+성경 선택시 성경) 꺼내서
// - 원래 메일 폼(오늘도_메일_미리보기_v2) 디자인 그대로, Pretendard 적용해 발송
// - 비밀 키는 Vercel 환경변수에서만 읽음
//
// 호출: /api/send-test?key=<CRON_SECRET>&to=<이메일>&from_name=<이름>&to_name=<받는사람>&bible=<1이면 성경도>

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SECRET = process.env.CRON_SECRET;
  if (!SECRET || (req.query.key || "") !== SECRET)
    return res.status(401).json({ ok: false, error: "열쇠가 맞지 않아요." });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  const SB_URL = process.env.ODO_SUPABASE_URL;
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;
  const FROM = process.env.ODO_FROM_EMAIL || "onboarding@resend.dev";

  if (!RESEND_KEY || !SB_URL || !SB_SERVICE)
    return res.status(500).json({ ok: false, error: "서버 설정(환경변수)이 아직 안 됐어요." });

  const to = req.query.to;
  if (!to) return res.status(400).json({ ok: false, error: "받을 이메일(to)이 없어요." });
  const fromName = req.query.from_name || "윤기";
  const toName = req.query.to_name || "";
  const wantBible = req.query.bible === "1";

  try {
    const normal = await fetchContents(SB_URL, SB_SERVICE, "normal");
    if (!normal.length) throw new Error("창고에 일반 콘텐츠가 없어요.");
    const pickN = normal[Math.floor(Math.random() * normal.length)];

    let pickB = null;
    if (wantBible) {
      const bible = await fetchContents(SB_URL, SB_SERVICE, "bible");
      if (bible.length) pickB = bible[Math.floor(Math.random() * bible.length)];
    }

    const html = buildEmail({ fromName, toName, normal: pickN, bible: pickB });

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "오늘도 <" + FROM + ">",
        to: [to],
        subject: fromName + "님이 오늘도 보냅니다",
        html
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ ok: false, error: "Resend 발송 실패", detail: data });
    return res.status(200).json({ ok: true, message: "보냈어요!", to, id: data.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}

async function fetchContents(url, key, kind) {
  const r = await fetch(url + "/rest/v1/odo_contents?kind=eq." + kind + "&select=*", {
    headers: { "apikey": key, "Authorization": "Bearer " + key }
  });
  if (!r.ok) throw new Error("창고 읽기 실패: " + r.status);
  return await r.json();
}

const CARE_ICONS = {
  tea: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="#5a4a7a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h11v5a4 4 0 01-4 4H9a4 4 0 01-4-4z"/><path d="M16 9h2a2 2 0 010 4h-2"/><path d="M8 3c-.5 1 .5 1 0 2M11 3c-.5 1 .5 1 0 2"/></svg>',
  breath: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="#5a4a7a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="#5a4a7a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M6 6l1.5 1.5M16.5 16.5L18 18M18 6l-1.5 1.5M7.5 16.5L6 18"/></svg>',
  walk: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="#5a4a7a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="1.5"/><path d="M11 8l3 2 2 3M11 8l-1 5-2 4M14 10l-1 4 2 4"/></svg>',
  stretch: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="#5a4a7a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="1.5"/><path d="M12 7v7M12 9l-4-2M12 9l4-2M12 14l-3 5M12 14l3 5"/></svg>'
};

function buildEmail({ fromName, toName, normal, bible }) {
  const nl = s => (s || "").replace(/\\n/g, "\n");
  const brQuote = nl(normal.quote).replace(/\n/g, "<br>");
  const essayParas = nl(normal.essay).split("\n\n").filter(Boolean)
    .map(p => '<p style="font-size:14px; line-height:1.95; color:#46414d; margin:0 0 13px;">' + p.replace(/\n/g,"<br>") + '</p>').join("");
  const careIcon = CARE_ICONS[normal.care_icon] || CARE_ICONS.tea;
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
        '<div style="font-size:22px; line-height:1.5; font-weight:800; text-align:center; color:#2b2730; letter-spacing:-0.035em;">' + bQuote + '</div>' +
        (bible.quote_en ? '<div style="font-size:14px; font-style:italic; color:#7a7580; text-align:center; margin-top:12px;">' + bible.quote_en + '</div>' : "") +
        '<div style="font-size:13px; color:#7a7580; text-align:center; margin-top:14px;">— ' + (bible.author || "") + '</div>' +
        '<div style="margin-top:20px;">' + bParas + '</div>' +
      '</div>';
  }

  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">' +
'</head>' +
'<body style="margin:0; padding:0; background:#f3f1ef; font-family:' + font + '; -webkit-font-smoothing:antialiased;">' +
'<div style="max-width:560px; margin:0 auto; padding:40px 20px 60px; font-family:' + font + ';">' +

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
      '<div style="font-size:26px; line-height:1.5; font-weight:800; text-align:center; color:#2b2730; letter-spacing:-0.035em;">' + brQuote + '</div>' +
      (normal.quote_en ? '<div style="font-size:14px; font-style:italic; color:#7a7580; text-align:center; margin-top:12px; line-height:1.5;">' + normal.quote_en + '</div>' : "") +
      '<div style="font-size:13px; color:#7a7580; text-align:center; margin-top:16px;">— ' + (normal.author || "") + '</div>' +

      '<div style="margin-top:34px; padding-top:28px; border-top:1px solid #eae7e3;">' +
        (normal.essay_title ? '<div style="font-size:16px; font-weight:700; color:#2b2730; margin-bottom:14px;">' + normal.essay_title + '</div>' : "") +
        essayParas +
      '</div>' +

      (normal.care_title ?
      '<div style="margin-top:30px; background:#efecf4; border-radius:14px; padding:20px 22px;">' +
        '<table cellpadding="0" cellspacing="0"><tr>' +
          '<td style="width:48px; vertical-align:middle;"><div style="width:36px; height:36px; border-radius:10px; background:#fff; text-align:center; line-height:40px;">' + careIcon + '</div></td>' +
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
