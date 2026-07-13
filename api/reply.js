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

  // 2) 입력값
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const reactionId = (body && body.reaction_id) || "";
  const message = ((body && body.message) || "").toString().trim();
  if (!reactionId) return res.status(400).json({ ok: false, error: "어떤 답장에 대한 답신인지 알 수 없어요." });
  if (!message) return res.status(400).json({ ok: false, error: "답신 내용을 입력해 주세요." });
  if (message.length > 1000) return res.status(400).json({ ok: false, error: "답신이 너무 길어요 (1000자 이내)." });

  const H = { "apikey": SB_SERVICE, "Authorization": "Bearer " + SB_SERVICE, "Content-Type": "application/json" };

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
  const PLUM = "#423458";

  const html =
    '<div style="max-width:520px; margin:0 auto; font-family:-apple-system,BlinkMacSystemFont,\'Apple SD Gothic Neo\',\'Malgun Gothic\',sans-serif; background:#f6f2f9; padding:24px;">' +
      '<div style="background:#ffffff; border-radius:18px; padding:30px 26px;">' +
        '<div style="font-size:13px; color:#8a8194; margin-bottom:6px;">오늘도</div>' +
        '<div style="font-size:17px; font-weight:700; color:' + PLUM + '; margin-bottom:18px;">' + esc(fromNameSafe) + '님이 답신을 보냈어요</div>' +
        '<div style="font-size:15px; line-height:1.9; color:#3a3540; word-break:keep-all;">' + bodyHtml + '</div>' +
        (reaction.content_quote ? '<div style="margin-top:18px; padding-top:14px; border-top:1px solid #eee; font-size:13px; color:#8a8194;">"' + esc(reaction.content_quote) + '"</div>' : '') +
      '</div>' +
      '<div style="text-align:center; font-size:11px; color:#b0aab6; margin-top:16px;">오늘도 · ond2u.com</div>' +
    '</div>';

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
    return res.status(200).json({ ok: true, id: data.id || "" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "발송 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요." });
  }
}
