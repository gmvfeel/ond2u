// OND2U 받는 사람 편지 페이지 — 반응 기록 + 한 줄 답장
// 편지 속 반응 버튼 → /api/letter?e=<반응>&r=<받는사람이메일>&s=<보낸사람id>&q=<글>
//  - GET: 반응을 기록하고(새로고침 중복 방지), 예쁜 페이지 + 답장칸을 보여줌
//  - POST {id, reply}: 그 반응에 답장을 저장 → 보낸 사람의 '받은 반응'에 표시
export const config = { maxDuration: 30 };

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export default async function handler(req, res) {
  const SB_URL = process.env.ODO_SUPABASE_URL;
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;
  const H = { "apikey": SB_SERVICE, "Authorization": "Bearer " + SB_SERVICE, "Content-Type": "application/json" };

  // ── POST: 답장 저장 ──
  if (req.method === "POST") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (!SB_URL || !SB_SERVICE) return res.status(500).json({ ok: false });
    try {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      const id = body && body.id;
      const reply = ((body && body.reply) || "").toString().slice(0, 500);
      if (!id) return res.status(400).json({ ok: false });
      const r = await fetch(SB_URL + "/rest/v1/odo_reactions?id=eq." + encodeURIComponent(id), {
        method: "PATCH",
        headers: { ...H, "Prefer": "return=minimal" },
        body: JSON.stringify({ reply })
      });
      if (!r.ok) return res.status(500).json({ ok: false });
      // 답장이 저장되면, 보낸 사람에게 '답장 도착' 알림 이메일을 보내요 (실패해도 답장 저장은 유지)
      try { await notifyReply(SB_URL, SB_SERVICE, H, id, reply); } catch (e) {}
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ ok: false }); }
  }

  // ── GET: 반응 기록 + 페이지 렌더 ──
  const emotion = (req.query.e || "").toString();
  const recipient = (req.query.r || "").toString();
  const sender = (req.query.s || "").toString();
  const quote = (req.query.q || "").toString();

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  const page = (inner) => `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>마음 전하기 · 오늘도</title>
<link rel="stylesheet" as="style" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css" />
<style>
  *{box-sizing:border-box;} body{margin:0;background:#faf9f8;color:#2b2730;
    font-family:'Pretendard','Apple SD Gothic Neo','\B9D1\C740 \ACE0\B515',sans-serif;
    display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;line-height:1.7;}
  .box{max-width:440px;width:100%;background:#fff;border:1px solid #eae7ef;border-radius:20px;
    padding:40px 30px;text-align:center;box-shadow:0 12px 34px rgba(80,60,70,.08);}
  .logo{font-size:12px;font-weight:800;letter-spacing:.06em;color:#423458;margin-bottom:26px;}
  .heart{font-size:34px;margin-bottom:14px;}
  h1{font-size:20px;font-weight:700;margin:0 0 10px;line-height:1.5;}
  .who{color:#c56179;font-weight:700;}
  .emo{display:inline-block;background:#fbeef1;color:#c56179;font-weight:700;
    border-radius:20px;padding:5px 16px;font-size:14px;margin:6px 0 4px;}
  p{font-size:14px;color:#7a7580;margin:0 0 6px;}
  .quote{font-size:13px;color:#a8a2af;background:#f7f5fb;border-radius:12px;padding:12px 15px;margin:20px 0 6px;line-height:1.6;}
  .reply-box{margin-top:26px;text-align:left;}
  .reply-box label{display:block;font-size:13px;font-weight:600;color:#46414d;margin-bottom:9px;text-align:center;}
  textarea{width:100%;font-family:inherit;font-size:14px;color:#2b2730;border:1px solid #d8d0e4;
    border-radius:12px;padding:13px 14px;resize:none;line-height:1.6;outline:none;}
  textarea:focus{border-color:#423458;}
  .send{width:100%;margin-top:12px;font-family:inherit;font-size:15px;font-weight:600;color:#fff;
    background:#423458;border:none;border-radius:26px;padding:14px;cursor:pointer;transition:background .2s;}
  .send:hover{background:#33283f;} .send:disabled{opacity:.6;cursor:default;}
  .done{display:none;margin-top:22px;font-size:15px;color:#c56179;font-weight:600;}
  .invite{margin-top:20px;padding-top:20px;border-top:1px solid #efecf4;}
  .invite-line{font-size:13px;color:#7a7580;font-weight:400;margin-bottom:15px;line-height:1.75;}
  .invite-btn{display:inline-block;font-size:14px;font-weight:600;color:#fff;background:#423458;
    border-radius:24px;padding:12px 26px;text-decoration:none;}
  .invite-btn:hover{background:#33283f;}
  .foot{margin-top:26px;font-size:12px;color:#b0aab6;}
  .foot a{color:#7a7580;text-decoration:underline;}
</style></head><body><div class="box"><div class="logo">\uC624\uB298\uB3C4 · OND2U</div>${inner}</div></body></html>`;

  if (!SB_URL || !SB_SERVICE) {
    return res.status(200).send(page(`<div class="heart">\uD83D\uDC8C</div><h1>\uC7A0\uC2DC \uBB38\uC81C\uAC00 \uC788\uC5B4\uC694</h1><p>\uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.</p>`));
  }

  // 보낸 사람 이름
  let senderName = "\uB204\uAD70\uAC00";  // 누군가
  try {
    if (sender) {
      const ur = await fetch(SB_URL + "/rest/v1/odo_users?id=eq." + encodeURIComponent(sender) + "&select=display_name", { headers: H });
      if (ur.ok) { const arr = await ur.json(); if (arr[0] && arr[0].display_name) senderName = arr[0].display_name; }
    }
  } catch (e) {}

  // 반응 기록 (같은 보낸이+받는이+반응, 오늘 것 있으면 재사용 → 새로고침 중복 방지)
  let rowId = null;
  try {
    if (sender && recipient && emotion) {
      const today = new Date().toISOString().slice(0, 10);
      const findUrl = SB_URL + "/rest/v1/odo_reactions?select=id"
        + "&sender_id=eq." + encodeURIComponent(sender)
        + "&recipient_email=eq." + encodeURIComponent(recipient)
        + "&emotion=eq." + encodeURIComponent(emotion)
        + "&created_at=gte." + today
        + "&order=created_at.desc&limit=1";
      const ex = await fetch(findUrl, { headers: H });
      if (ex.ok) { const arr = await ex.json(); if (arr[0]) rowId = arr[0].id; }
      if (!rowId) {
        const ins = await fetch(SB_URL + "/rest/v1/odo_reactions", {
          method: "POST",
          headers: { ...H, "Prefer": "return=representation" },
          body: JSON.stringify({ sender_id: sender, recipient_email: recipient, emotion: emotion, content_quote: quote })
        });
        if (ins.ok) { const arr = await ins.json(); if (arr[0]) rowId = arr[0].id; }
      }
    }
  } catch (e) {}

  const emoLine = emotion ? `<div class="emo">${esc(emotion)}</div>` : "";
  const quoteLine = quote ? `<div class="quote">"${esc(quote)}"</div>` : "";
  const replyBox = rowId ? `
    <div class="reply-box" id="replyBox">
      <label>${esc(senderName)}\uB2D8\uC5D0\uAC8C \uD55C\uB9C8\uB514 \uB0A8\uAE30\uACE0 \uC2F6\uB2E4\uBA74</label>
      <textarea id="replyText" rows="3" maxlength="500" placeholder="\uACE0\uB9C8\uC6CC\uC694. \uB355\uBD84\uC5D0 \uD798\uC774 \uB0AC\uC5B4\uC694."></textarea>
      <button class="send" id="sendReply">\uB2F5\uC7A5 \uBCF4\uB0B4\uAE30</button>
    </div>
    <div class="done" id="replyDone">마음이 전해졌어요. 고마워요 ♡
      <div class="invite">
        <div class="invite-line">당신에게도 이런 위로가 필요한 날이 있잖아요.<br>오늘도가 매일 아침, 당신에게도 한 편을 보내드릴게요.</div>
        <a class="invite-btn" href="https://www.ond2u.com/app.html">오늘도, 나도 받아보기 →</a>
      </div>
    </div>
    <script>
      (function(){
        var btn=document.getElementById('sendReply'), ta=document.getElementById('replyText');
        var box=document.getElementById('replyBox'), done=document.getElementById('replyDone');
        var rowId=${JSON.stringify(String(rowId))};
        btn.onclick=function(){
          var t=(ta.value||'').trim(); if(!t){ ta.focus(); return; }
          btn.disabled=true; btn.textContent='\uBCF4\uB0B4\uB294 \uC911\u2026';
          fetch('/api/letter',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:rowId,reply:t})})
            .then(function(r){return r.json();})
            .then(function(d){ if(d&&d.ok){ box.style.display='none'; done.style.display='block'; }
              else { btn.disabled=false; btn.textContent='\uB2F5\uC7A5 \uBCF4\uB0B4\uAE30'; alert('\uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.'); } })
            .catch(function(){ btn.disabled=false; btn.textContent='\uB2F5\uC7A5 \uBCF4\uB0B4\uAE30'; alert('\uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.'); });
        };
      })();
    </script>` : "";

  const inner = `
    <div class="heart">\uD83D\uDC8C</div>
    <h1><span class="who">${esc(senderName)}</span>\uB2D8\uC5D0\uAC8C<br>\uB9C8\uC74C\uC744 \uC804\uD588\uC5B4\uC694</h1>
    ${emoLine}
    <p>\uB2F9\uC2E0\uC758 \uD55C \uB9C8\uB514\uAC00 ${esc(senderName)}\uB2D8\uC5D0\uAC8C \uD070 \uD798\uC774 \uB3FC\uC694.</p>
    ${quoteLine}
    ${replyBox}
    <div class="foot"><a href="https://www.ond2u.com/app.html">\uC624\uB298\uB3C4\uB780? \uB098\uB3C4 \uC704\uB85C \uBC1B\uAE30 \u2192</a></div>`;

  return res.status(200).send(page(inner));
}

// ===== 답장 도착 알림 이메일 =====
async function notifyReply(SB_URL, SB_SERVICE, H, id, reply) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.ODO_FROM_EMAIL || "letter@ond2u.com";
  if (!RESEND_KEY) return;

  // 답장이 달린 반응 정보 조회
  const rr = await fetch(SB_URL + "/rest/v1/odo_reactions?id=eq." + encodeURIComponent(id) + "&select=sender_id,recipient_email,emotion,content_quote", { headers: H });
  if (!rr.ok) return;
  const rows = await rr.json();
  const row = rows[0];
  if (!row || !row.sender_id) return;

  // 보낸 사람(=알림 받을 사람) 이메일·이름
  const ur = await fetch(SB_URL + "/rest/v1/odo_users?id=eq." + encodeURIComponent(row.sender_id) + "&select=email,display_name", { headers: H });
  if (!ur.ok) return;
  const us = await ur.json();
  const u = us[0];
  if (!u || !u.email) return;
  const senderName = ((u.display_name || "").trim()) || "당신";

  // 답장한 사람(받는 사람) 이름 조회
  let replierName = "";
  try {
    const rc = await fetch(SB_URL + "/rest/v1/odo_recipients?sender_id=eq." + encodeURIComponent(row.sender_id) + "&email=eq." + encodeURIComponent(row.recipient_email) + "&select=name&limit=1", { headers: H });
    if (rc.ok) { const rcs = await rc.json(); if (rcs[0] && rcs[0].name) replierName = rcs[0].name; }
  } catch (e) {}
  const who = replierName || "편지를 받은 분";

  const html = buildReplyNotifyEmail({ senderName, who, emotion: row.emotion || "", reply: reply || "", quote: row.content_quote || "" });
  const subject = who + "님이 답장을 남겼어요 \uD83D\uDC8C";
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "오늘도 <" + FROM + ">", to: [u.email], subject, html })
  });
}

function buildReplyNotifyEmail({ senderName, who, emotion, reply, quote }) {
  const PLUM = "#423458", PLUM_DEEP = "#2f2440", ROSE = "#d97c93";
  const font = "'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif";
  const spacer = h => '<div style="height:' + h + 'px; line-height:' + h + 'px; font-size:0;">&nbsp;</div>';
  const emoLine = emotion
    ? '<div style="display:inline-block; background:#fdeef2; color:' + ROSE + '; font-weight:700; border-radius:20px; padding:5px 15px; font-size:13px;">' + esc(emotion) + '</div>'
    : "";
  const quoteLine = quote
    ? spacer(18) + '<div style="font-size:13px; color:#a8a2af; background:#f7f5fb; border-radius:12px; padding:13px 16px; line-height:1.65; text-align:left;">"' + esc(quote) + '"</div>'
    : "";
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"></head>' +
'<body style="margin:0; padding:0; background:#f3f1ef; font-family:' + font + ';">' +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f1ef" style="background:#f3f1ef;"><tr>' +
'<td align="center" style="padding:36px 12px 56px; font-family:' + font + '; word-break:keep-all;">' +
  '<table role="presentation" width="620" cellpadding="0" cellspacing="0" border="0" style="width:620px; max-width:620px; background:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #eee;">' +
    '<tr><td bgcolor="' + PLUM + '" style="background:' + PLUM + '; padding:32px 28px; text-align:center;">' +
      '<div style="font-size:34px; line-height:1; margin-bottom:12px;">\uD83D\uDC8C</div>' +
      '<div style="font-size:22px; font-weight:800; color:#ffffff; letter-spacing:-0.02em;">답장이 도착했어요</div>' +
    '</td></tr>' +
    '<tr><td bgcolor="#ffffff" style="padding:32px 30px 10px; text-align:center;">' +
      '<div style="font-size:15px; color:#3a3540;"><b>' + esc(senderName) + '</b>님, <b style="color:' + ROSE + ';">' + esc(who) + '</b>님이 마음을 돌려보냈어요.</div>' +
      spacer(16) + emoLine +
      spacer(20) +
      '<div style="background:#fdeef2; border-radius:14px; padding:20px 22px; text-align:left;">' +
        '<div style="font-size:11px; letter-spacing:0.08em; color:' + ROSE + '; margin-bottom:9px;">' + esc(who) + '님의 답장</div>' +
        '<div style="font-size:16px; line-height:1.75; color:#3a3540;">' + esc(reply).replace(/\r?\n/g, "<br>") + '</div>' +
      '</div>' +
      quoteLine +
      spacer(26) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">' +
        '<a href="https://www.ond2u.com/app.html" style="display:inline-block; font-size:14px; font-weight:600; color:#ffffff; background:' + PLUM + '; text-decoration:none; padding:13px 30px; border-radius:30px;">오늘도에서 모두 보기 →</a>' +
      '</td></tr></table>' +
      spacer(18) +
    '</td></tr>' +
    '<tr><td bgcolor="#f3f1ef" style="padding:18px 28px; border-top:1px solid #eae7e3; text-align:center;">' +
      '<div style="font-size:12px; color:#b0aab6;">오늘도 · OND2U</div>' +
    '</td></tr>' +
  '</table>' +
'</td></tr></table></body></html>';
}
