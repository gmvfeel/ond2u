// OND2U 수신거부(그만 받기) 처리 함수
// 편지 하단 '여기' 링크 → /api/unsubscribe?e=<이메일>&t=<토큰>
// 토큰은 send-test.js가 CRON_SECRET으로 만든 HMAC (남이 위조 못 함)
import crypto from "crypto";

export default async function handler(req, res) {
  const SECRET = process.env.CRON_SECRET;
  const SB_URL = process.env.ODO_SUPABASE_URL;
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;

  const email = (req.query.e || "").toString();
  const token = (req.query.t || "").toString();

  const page = (title, body) => `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · 오늘도</title><style>
    body{margin:0;font-family:'Pretendard','Apple SD Gothic Neo','맑은 고딕',sans-serif;background:#faf9f8;color:#2b2730;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;}
    .box{max-width:420px;width:100%;background:#fff;border:1px solid #eae7e3;border-radius:18px;padding:40px 32px;text-align:center;box-shadow:0 10px 30px rgba(80,60,70,.08);}
    .logo{font-size:13px;font-weight:800;letter-spacing:.06em;color:#423458;margin-bottom:22px;}
    h1{font-size:19px;margin:0 0 12px;font-weight:700;}
    p{font-size:14px;line-height:1.75;color:#7a7580;margin:0;}
  </style></head><body><div class="box"><div class="logo">오늘도 · OND2U</div>${body}</div></body></html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!SECRET || !SB_URL || !SB_SERVICE) {
    return res.status(500).send(page("오류", "<h1>잠시 문제가 있어요</h1><p>잠시 후 다시 시도해 주세요.</p>"));
  }
  if (!email || !token) {
    return res.status(400).send(page("링크 오류", "<h1>링크가 올바르지 않아요</h1><p>편지 맨 아래의 링크를 다시 눌러주세요.</p>"));
  }

  // 토큰 검증 (send-test.js와 동일한 방식)
  const expected = crypto.createHmac("sha256", SECRET).update(email).digest("hex").slice(0, 32);
  if (token !== expected) {
    return res.status(400).send(page("링크 오류", "<h1>링크가 올바르지 않아요</h1><p>편지 맨 아래의 링크를 다시 눌러주세요.</p>"));
  }

  // 이 이메일로 가는 편지 모두 중단 (수신자 명단에서 제거)
  try {
    const r = await fetch(SB_URL + "/rest/v1/odo_recipients?email=eq." + encodeURIComponent(email), {
      method: "DELETE",
      headers: {
        "apikey": SB_SERVICE,
        "Authorization": "Bearer " + SB_SERVICE,
        "Prefer": "return=minimal"
      }
    });
    if (!r.ok) throw new Error("삭제 실패 " + r.status);
  } catch (e) {
    return res.status(500).send(page("오류", "<h1>잠시 문제가 있어요</h1><p>잠시 후 다시 시도해 주세요.</p>"));
  }

  return res.status(200).send(page("구독 해지",
    "<h1>구독을 해지했어요</h1><p>이제 이 편지를 더 보내지 않아요.<br>그동안 함께해 주셔서 고마웠어요.<br>언제든 다시 오시면 반갑게 맞이할게요.</p>"));
}
