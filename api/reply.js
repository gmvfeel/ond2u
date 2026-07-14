// OND2U 답신 발송 — 사용자가 "주고받은 마음"에서 받은 답장에 답신을 보냄
// - 로그인 사용자 인증(Supabase) 후, 본인이 받은 답장(odo_reactions)에만 답신 허용
// - 답장 보낸 분(recipient_email)에게 Resend로 이메일 발송
// 호출: POST /api/reply   body: { reaction_id, message }   header: Authorization: Bearer <로그인 토큰>

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST만 지원해요." });

  const SB_URL = process.env.ODO_SUPABASE_URL;
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.ODO_FROM_EMAIL || "letter@ond2u.com";

  if (!SB_URL || !SB_SERVICE || !RESEND_KEY)
    return res.status(500).json({ ok: false, error: "서버 설정(환경변수)이 아직 안 됐어요." });

  // 1) 로그인 사용자 인증
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "로그인이 필요해요." });

  let user;
  try {
    const uRes = await fetch(SB_URL + "/auth/v1/user", {
      headers: { "Authorization": "Bearer " + token, "apikey": SB_SERVICE }
    });
    user = await uRes.json();
  } catch (e) {}
  if (!user || !user.id) return res.status(401).json({ ok: false, error: "로그인 정보를 확인할 수 없어요." });

  const admins = (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const isAdmin = !!(user.email && admins.includes(user.email.toLowerCase()));

  // 2) 입력값
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const reactionId = (body && body.reaction_id) || "";
  const message = ((body && body.message) || "").toString().trim();
  if (!reactionId) return res.status(400).json({ ok: false, error: "어떤 답장에 대한 답신인지 알 수 없어요." });
  if (!message) return res.status(400).json({ ok: false, error: "답신 내용을 입력해 주세요." });
  if (message.length > 1000) return res.status(400).json({ ok: false, error: "답신이 너무 길어요 (1000자 이내)." });

  const H = { "apikey": SB_SERVICE, "Authorization": "Bearer " + SB_SERVICE, "Content-Type": "application/json" };

  // 2-1) 하루 답신 한도 (관리자 제외)
  const DAILY_REPLY_LIMIT = 20;
  if (!isAdmin) {
    try {
      const todayISO = kstTodayStartISO();
      const cr = await fetch(
        SB_URL + "/rest/v1/odo_sends?sender_id=eq." + encodeURIComponent(user.id) +
        "&created_at=gte." + encodeURIComponent(todayISO) +
        "&content_quote=like." + encodeURIComponent("[\uB2F5\uC2E0]*") + "&select=id",
        { headers: { "apikey": SB_SERVICE, "Authorization": "Bearer " + SB_SERVICE, "Prefer": "count=exact", "Range": "0-0" } }
      );
      const used = parseInt((((cr.headers.get("content-range") || "").split("/")[1]) || "0"), 10) || 0;
      if (used >= DAILY_REPLY_LIMIT)
        return res.status(429).json({ ok: false, error: "\uC624\uB298 \uBCF4\uB0BC \uC218 \uC788\uB294 \uB2F5\uC2E0(" + DAILY_REPLY_LIMIT + "\uD1B5)\uC744 \uBAA8\uB450 \uC0AC\uC6A9\uD588\uC5B4\uC694. \uB0B4\uC77C \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694." });
    } catch (e) { /* 카운트 실패 시엔 막지 않고 진행 */ }
  }

  // 3) 해당 답장 조회 + 본인 것인지 확인
  let reaction;
  try {
    const rr = await fetch(
      SB_URL + "/rest/v1/odo_reactions?id=eq." + encodeURIComponent(reactionId) +
      "&select=id,sender_id,recipient_email,content_quote,reply",
      { headers: H }
    );
    const arr = await rr.json();
    reaction = Array.isArray(arr) ? arr[0] : null;
  } catch (e) {}
  if (!reaction) return res.status(404).json({ ok: false, error: "답장을 찾을 수 없어요." });
  if (String(reaction.sender_id) !== String(user.id))
    return res.status(403).json({ ok: false, error: "본인이 받은 답장에만 답신할 수 있어요." });

  const toEmail = reaction.recipient_email;
  if (!toEmail) return res.status(400).json({ ok: false, error: "답장 보낸 분의 이메일이 없어 답신을 보낼 수 없어요." });

  // 4) 보내는 사람 이름
  let fromName = "";
  try {
    const ur = await fetch(
      SB_URL + "/rest/v1/odo_users?id=eq." + encodeURIComponent(user.id) + "&select=display_name",
      { headers: H }
    );
    const ua = await ur.json();
    fromName = (Array.isArray(ua) && ua[0] && ua[0].display_name) || "";
  } catch (e) {}
  if (!fromName) fromName = ((user.email || "오늘도").split("@")[0]) || "오늘도";
  const fromNameSafe = String(fromName).replace(/["<>\r\n]/g, "").trim() || "오늘도";

  // 5) 이메일 본문
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const bodyHtml = esc(message).replace(/\n/g, "<br>");
  const PLUM = "#423458", PLUM_DEEP = "#2f2440", ROSE = "#d97c93", ROSE_SOFT = "#fdeef2";
  const font = "'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif";

  const html =
    '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>\uB2F5\uC2E0\uC774 \uB3C4\uCC29\uD588\uC5B4\uC694</title>' +
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">' +
    '</head>' +
    '<body style="margin:0; padding:0; background:#f3f1ef; font-family:' + font + '; word-break:keep-all;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f1ef" style="background:#f3f1ef;"><tr>' +
    '<td align="center" style="padding:36px 14px 48px; font-family:' + font + ';">' +
      '<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px; max-width:520px; background:#ffffff; border:2px solid ' + ROSE + '; border-radius:18px; overflow:hidden;">' +
        // 상단 라벨
        '<tr><td style="padding:16px 26px; border-bottom:1px solid #eae7e3;">' +
          '<div style="font-size:12px; letter-spacing:0.14em; color:' + ROSE + '; font-weight:700;">\uC624\uB298\uB3C4 \u00B7 \uB2F5\uC2E0\uC774 \uB3C4\uCC29\uD588\uC5B4\uC694</div>' +
        '</td></tr>' +
        // 헤더 (하트 + 제목)
        '<tr><td bgcolor="' + ROSE_SOFT + '" style="background:' + ROSE_SOFT + '; padding:40px 28px 32px; text-align:center;">' +
          '<div style="font-size:44px; line-height:1; margin-bottom:14px;">\u2661</div>' +
          '<div style="font-size:23px; font-weight:800; color:' + PLUM_DEEP + '; letter-spacing:-0.02em;">' + esc(fromNameSafe) + '\uB2D8\uC758 \uB2F5\uC2E0</div>' +
        '</td></tr>' +
        // 본문 메시지
        '<tr><td style="padding:34px 30px 6px;">' +
          '<div style="font-size:16px; line-height:1.95; color:#3a3540;">' + bodyHtml + '</div>' +
        '</td></tr>' +
        // 답신을 부른 마음 (인용)
        (reaction.content_quote ?
          '<tr><td style="padding:10px 30px 6px;">' +
            '<div style="background:#faf7fb; border-left:3px solid ' + ROSE + '; border-radius:0 12px 12px 0; padding:14px 16px;">' +
              '<div style="font-size:11px; letter-spacing:0.08em; color:' + ROSE + '; font-weight:700; margin-bottom:6px;">\uB2F5\uC2E0\uC744 \uBD80\uB978 \uB9C8\uC74C</div>' +
              '<div style="font-size:13.5px; line-height:1.7; color:#8a8194;">&ldquo;' + esc(reaction.content_quote) + '&rdquo;</div>' +
            '</div>' +
          '</td></tr>' : '') +
        // 맺음
        '<tr><td style="padding:22px 30px 30px; text-align:center;">' +
          '<div style="font-size:13px; color:' + ROSE + '; font-weight:600;">\u2014 \uC624\uB298\uB3C4\uAC00 \uB300\uC2E0 \uC804\uD574\uB4DC\uB824\uC694</div>' +
        '</td></tr>' +
        // 푸터
        '<tr><td bgcolor="#f3f1ef" style="background:#f3f1ef; padding:20px 28px; border-top:1px solid #eae7e3; text-align:center;">' +
          '<div style="font-size:11px; color:#b0aab6;">\uC624\uB298\uB3C4 \u00B7 ond2u.com</div>' +
        '</td></tr>' +
      '</table>' +
    '</td></tr></table>' +
    '</body></html>';

  // 6) Resend 발송
  try {
    const payload = {
      from: fromNameSafe + " <" + FROM + ">",
      to: toEmail,
      subject: fromNameSafe + "님의 답신이 도착했어요",
      html: html
    };
    if (user.email) payload.reply_to = user.email;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ ok: false, error: "발송 실패: " + (data && (data.message || JSON.stringify(data))) });

    // 발송 기록 남기기 (타임라인 표시 + 발송량 집계 포함). 실패해도 답신 자체엔 영향 없음.
    try {
      await fetch(SB_URL + "/rest/v1/odo_sends", {
        method: "POST",
        headers: { "apikey": SB_SERVICE, "Authorization": "Bearer " + SB_SERVICE, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({
          sender_id: user.id,
          sender_name: fromNameSafe,
          recipient_email: toEmail,
          recipient_name: "",
          content_quote: "[\uB2F5\uC2E0] " + message,
          status: "success"
        })
      });
    } catch (e) { /* 기록 실패는 조용히 무시 */ }

    return res.status(200).json({ ok: true, id: data.id || "" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "발송 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요." });
  }
}

// 오늘(한국시각) 0시를 UTC ISO로
function kstTodayStartISO() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear(), m = kst.getUTCMonth(), d = kst.getUTCDate();
  const utc = new Date(Date.UTC(y, m, d, 0, 0, 0) - 9 * 3600 * 1000);
  return utc.toISOString();
}
