// OND2U 수신거부 (편지 그만 받기)
// - 이메일 하단 "여기를 눌러주세요" 링크가 여기로 옴: /api/unsubscribe?e=<이메일>&t=<토큰>
// - 토큰(HMAC)으로 본인 확인 → 실수/스캐너 방지를 위해 "확인 → 확정" 2단계
// - 확정 시 odo_recipients에서 그 이메일로 가는 편지를 모두 중지

import crypto from "crypto";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  const SECRET = process.env.CRON_SECRET;
  const SB_URL = process.env.ODO_SUPABASE_URL;
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;

  const e = (req.query.e || "").toString();
  const t = (req.query.t || "").toString();
  const confirm = (req.query.confirm || "").toString();

  // 토큰 검증 (아무나 남의 수신거부 못 하게)
  const expect = SECRET ? crypto.createHmac("sha256", SECRET).update(e).digest("hex").slice(0, 32) : "";
  if (!e || !t || !expect || t !== expect) {
    return res.status(400).send(page(
      "링크를 확인해 주세요",
      "이 링크가 올바르지 않거나 만료되었어요.<br>편지 하단의 링크를 다시 눌러주시거나, 보내주신 분께 알려주세요.",
      null
    ));
  }

  const safeEmail = escHtml(e);

  // 원클릭 수신거부 — 메일함(지메일·네이버 등)이 자동으로 보내는 POST 요청 (RFC 8058)
  // 토큰으로 본인 확인이 끝났으므로 확인 페이지 없이 바로 중지
  if (req.method === "POST") {
    if (SB_URL && SB_SERVICE) {
      try {
        await fetch(SB_URL + "/rest/v1/odo_recipients?email=eq." + encodeURIComponent(e), {
          method: "DELETE",
          headers: { apikey: SB_SERVICE, Authorization: "Bearer " + SB_SERVICE, Prefer: "return=minimal" }
        });
      } catch (err) { /* 조용히 무시 */ }
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send("unsubscribed");
  }

  // 아직 확정 전 — 확인 페이지
  if (confirm !== "1") {
    const yesUrl = "/api/unsubscribe?e=" + encodeURIComponent(e) + "&t=" + encodeURIComponent(t) + "&confirm=1";
    return res.status(200).send(page(
      "정말 그만 받으시겠어요?",
      "<b>" + safeEmail + "</b> 주소로 가는 오늘도 편지를<br>더 이상 보내지 않도록 할게요.",
      '<a class="btn" href="' + yesUrl + '">네, 그만 받을게요</a>' +
      '<div class="sub">마음이 바뀌면 언제든 다시 받을 수 있어요.</div>'
    ));
  }

  // 확정 — 실제 수신거부 처리
  if (!SB_URL || !SB_SERVICE) {
    return res.status(500).send(page("잠시 후 다시 시도해 주세요", "지금은 처리할 수 없어요. 잠시 후 다시 눌러주세요.", null));
  }
  try {
    await fetch(SB_URL + "/rest/v1/odo_recipients?email=eq." + encodeURIComponent(e), {
      method: "DELETE",
      headers: { apikey: SB_SERVICE, Authorization: "Bearer " + SB_SERVICE, Prefer: "return=minimal" }
    });
  } catch (err) {
    return res.status(500).send(page("잠시 후 다시 시도해 주세요", "처리 중 문제가 생겼어요. 잠시 후 다시 눌러주세요.", null));
  }

  return res.status(200).send(page(
    "수신거부가 완료되었어요",
    "<b>" + safeEmail + "</b> 주소로는<br>더 이상 편지가 가지 않아요.",
    '<div class="sub">그동안 함께해 주셔서 고맙습니다.<br>언젠가 다시 만나요. 🌿</div>'
  ));
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 공통 안내 페이지 (OND2U 톤)
function page(title, body, extra) {
  const PLUM = "#7c6a94", PLUM_DEEP = "#4a3a63";
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex">'
    + '<title>오늘도 · 수신 설정</title>'
    + '<style>'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic","Apple SD Gothic Neo",sans-serif;'
    + 'background:#f5f1f4;color:#2b2730;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;word-break:keep-all}'
    + '.card{background:#fff;border:1px solid #eae3ec;border-radius:20px;max-width:420px;width:100%;padding:44px 30px;text-align:center;box-shadow:0 10px 30px rgba(80,60,70,.08)}'
    + '.ic{width:56px;height:56px;border-radius:50%;background:' + PLUM + ';margin:0 auto 22px;display:flex;align-items:center;justify-content:center}'
    + '.ic svg{width:28px;height:28px;stroke:#fff;fill:none;stroke-width:1.8}'
    + 'h1{font-size:20px;font-weight:800;color:' + PLUM_DEEP + ';letter-spacing:-.02em;margin-bottom:14px}'
    + 'p{font-size:14px;line-height:1.75;color:#6a6570}'
    + '.btn{display:inline-block;margin-top:24px;background:' + PLUM + ';color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 28px;border-radius:26px}'
    + '.sub{font-size:12.5px;color:#a8a2b0;line-height:1.7;margin-top:18px}'
    + '.brand{font-size:12px;color:#b9b2c0;margin-top:28px;letter-spacing:.04em}'
    + '</style></head><body><div class="card">'
    + '<div class="ic"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/></svg></div>'
    + '<h1>' + title + '</h1>'
    + '<p>' + body + '</p>'
    + (extra || "")
    + '<div class="brand">오늘도 · OND2U</div>'
    + '</div></body></html>';
}
