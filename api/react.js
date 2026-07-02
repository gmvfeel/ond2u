// OND2U 반응 기록 함수
// 이메일의 반응 버튼(위로됐어요 / 힘이 나요 / 고마워요)을 누르면 이 함수로 이동해요.
// → 창고(odo_reactions)에 기록하고, 누른 사람에게 "마음이 전해졌어요" 감사 화면을 보여줍니다.
// 호출: /api/react?e=<반응>&r=<받은사람 이메일>&s=<보낸이 id>&q=<편지 명언 일부>

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const SB_URL = process.env.ODO_SUPABASE_URL;
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;

  const e = (req.query.e || "").toString();  // emotion (반응 종류)
  const r = (req.query.r || "").toString();  // recipient_email (반응한 사람)
  const s = (req.query.s || "").toString();  // sender_id (보낸이)
  const q = (req.query.q || "").toString();  // content_quote (편지 명언 일부)

  // 창고에 기록 (혹시 실패해도 감사 화면은 보여줌)
  if (SB_URL && SB_SERVICE && e) {
    try {
      const rec = { emotion: e };
      if (r) rec.recipient_email = r;
      if (s) rec.sender_id = s;
      if (q) rec.content_quote = q;
      await fetch(SB_URL + "/rest/v1/odo_reactions", {
        method: "POST",
        headers: {
          "apikey": SB_SERVICE,
          "Authorization": "Bearer " + SB_SERVICE,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        body: JSON.stringify(rec)
      });
    } catch (err) { /* 기록 실패는 조용히 넘어가고 감사 화면 표시 */ }
  }

  const font = "'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif";
  const html =
'<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>마음이 전해졌어요</title>' +
'<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">' +
'</head>' +
'<body style="margin:0; background:#faf9f8; font-family:' + font + '; display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px;">' +
  '<div style="max-width:400px; width:100%; background:#5a4a7a; border-radius:24px; padding:48px 32px; text-align:center; box-shadow:0 20px 50px rgba(80,60,70,.18);">' +
    '<div style="font-size:44px; line-height:1; margin-bottom:20px;">\u2661</div>' +
    '<div style="font-size:20px; font-weight:800; color:#ffffff; margin-bottom:14px; letter-spacing:-0.02em;">마음이 전해졌어요</div>' +
    '<div style="font-size:15px; line-height:1.75; color:#e9e5f0;">' +
      (e ? '&ldquo;' + escapeHtml(e) + '&rdquo;라는 마음이<br>' : "") +
      '보낸 분에게 잘 전달됐어요.<br>오늘도 좋은 하루 되세요.' +
    '</div>' +
    '<a href="https://ond2u.vercel.app/app.html" style="display:inline-block; margin-top:28px; font-size:14px; font-weight:600; color:#5a4a7a; background:#ffffff; text-decoration:none; padding:12px 26px; border-radius:30px;">오늘도 보러 가기 \u2192</a>' +
  '</div>' +
'</body></html>';

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
