// OND2U 발송 현황 조회 함수 (발송 현황)
// -------------------------------------------------------------
// 발송 기록(odo_sends)을 관리자에게만 최근순으로 돌려줍니다.
// 오늘(한국시간) 성공/실패 건수도 함께 계산해 내려줍니다.
// -------------------------------------------------------------

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.ODO_SUPABASE_URL;
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;
  const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

  if (!SB_URL || !SB_SERVICE)
    return res.status(500).json({ ok: false, error: "서버 설정(환경변수)이 아직 안 됐어요." });
  if (!ADMIN_EMAILS.length)
    return res.status(500).json({ ok: false, error: "관리자 이메일(ADMIN_EMAILS)이 설정되지 않았어요." });

  // 1) 로그인 토큰 확인
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "로그인이 필요해요." });

  // 2) 누가 로그인했는지 확인
  let email = "";
  try {
    const uRes = await fetch(SB_URL + "/auth/v1/user", {
      headers: { "Authorization": "Bearer " + token, "apikey": SB_SERVICE }
    });
    const user = await uRes.json();
    email = ((user && user.email) || "").toLowerCase();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "로그인 확인에 실패했어요." });
  }

  // 3) 관리자 이메일인지 확인
  if (!email || !ADMIN_EMAILS.includes(email))
    return res.status(403).json({ ok: false, error: "권한이 없는 계정이에요.", email });

  const headers = { "apikey": SB_SERVICE, "Authorization": "Bearer " + SB_SERVICE };

  try {
    // 4) 발송 기록 (최근순, 최대 200개)
    const sRes = await fetch(
      SB_URL + "/rest/v1/odo_sends?select=*&order=created_at.desc&limit=200",
      { headers }
    );
    const sends = await sRes.json();
    if (!sRes.ok) return res.status(500).json({ ok: false, error: "발송 기록을 불러오지 못했어요.", detail: sends });

    // 5) 오늘(한국시간) 성공/실패 세기
    const todayKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    let todaySuccess = 0, todayFail = 0;
    (Array.isArray(sends) ? sends : []).forEach(s => {
      if (!s.created_at) return;
      const d = new Date(new Date(s.created_at).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      if (d === todayKST) {
        if (s.status === "success") todaySuccess++;
        else todayFail++;
      }
    });

    return res.status(200).json({
      ok: true,
      sends: Array.isArray(sends) ? sends : [],
      total: Array.isArray(sends) ? sends.length : 0,
      today_success: todaySuccess,
      today_fail: todayFail
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "처리 중 오류가 났어요.", detail: String(e) });
  }
}
