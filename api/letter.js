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
    <div class="done" id="replyDone">\uB9C8\uC74C\uC774 \uC804\uD574\uC84C\uC5B4\uC694. \uACE0\uB9C8\uC6CC\uC694 \u2661<br><span style="display:block; margin-top:8px; font-size:12px; color:#b0aab6; font-weight:400;">\uC774\uC81C \uCC3D\uC744 \uB2EB\uC73C\uC154\uB3C4 \uC88B\uC544\uC694.</span></div>
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
