// OND2U 대시보드 통계 함수
// -------------------------------------------------------------
// 관리자에게만, 서비스 현황 숫자를 한 번에 모아 돌려줍니다.
//   - 총 회원 수
//   - 총 발송 / 오늘 발송(성공)
//   - 총 반응 / 오늘 반응
//   - 총 콘텐츠 수
// 오늘 기준은 한국시간(KST) 자정부터입니다.
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

  // 로그인/관리자 확인
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "로그인이 필요해요." });
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
  if (!email || !ADMIN_EMAILS.includes(email))
    return res.status(403).json({ ok: false, error: "권한이 없는 계정이에요.", email });

  const headers = { "apikey": SB_SERVICE, "Authorization": "Bearer " + SB_SERVICE };

  // 개수만 세는 헬퍼 (Content-Range 헤더로 총 개수 파악)
  async function countOf(pathWithQuery) {
    try {
      const sep = pathWithQuery.includes("?") ? "&" : "?";
      const r = await fetch(SB_URL + "/rest/v1/" + pathWithQuery + sep + "select=id", {
        headers: { ...headers, "Prefer": "count=exact", "Range": "0-0" }
      });
      const cr = r.headers.get("content-range"); // 예: "0-0/42"
      if (!cr) return 0;
      const total = cr.split("/")[1];
      return parseInt(total) || 0;
    } catch (e) { return 0; }
  }

  // 오늘(KST) 자정을 UTC ISO로
  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  const y = kstNow.getUTCFullYear(), m = kstNow.getUTCMonth(), d = kstNow.getUTCDate();
  const todayStartUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) - 9 * 3600 * 1000).toISOString();
  const gte = "created_at=gte." + encodeURIComponent(todayStartUtc);

  try {
    const [members, contents, sendsTotal, sendsToday, reactionsTotal, reactionsToday] = await Promise.all([
      countOf("odo_users"),
      countOf("odo_contents"),
      countOf("odo_sends"),
      countOf("odo_sends?" + gte + "&status=eq.success"),
      countOf("odo_reactions"),
      countOf("odo_reactions?" + gte)
    ]);

    return res.status(200).json({
      ok: true,
      stats: {
        members,
        contents,
        sends_total: sendsTotal,
        sends_today: sendsToday,
        reactions_total: reactionsTotal,
        reactions_today: reactionsToday
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "통계를 불러오지 못했어요.", detail: String(e) });
  }
}
