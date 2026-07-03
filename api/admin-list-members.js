// OND2U 회원 목록 조회 함수 (회원 관리)
// -------------------------------------------------------------
// 회원 정보(이메일 등)는 민감하므로, "지금 로그인한 사람이 관리자(파트너)인지"
// 확인한 뒤에만 전체 회원 목록을 돌려줍니다.
//   - odo_users: 가입한 회원들
//   - odo_recipients: 각 회원이 편지를 보내는 사람(명단) 수를 세어 함께 내려줌
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

  const headers = {
    "apikey": SB_SERVICE,
    "Authorization": "Bearer " + SB_SERVICE
  };

  try {
    // 4) 회원 목록 (최근 방문 순)
    const uRes = await fetch(
      SB_URL + "/rest/v1/odo_users?select=*&order=last_visit.desc.nullslast",
      { headers }
    );
    const users = await uRes.json();
    if (!uRes.ok) return res.status(500).json({ ok: false, error: "회원 목록을 불러오지 못했어요.", detail: users });

    // 5) 각 회원이 보내는 사람(명단) 수 세기
    let counts = {};
    try {
      const rRes = await fetch(SB_URL + "/rest/v1/odo_recipients?select=sender_id", { headers });
      const recs = await rRes.json();
      if (Array.isArray(recs)) {
        recs.forEach(r => {
          const sid = r.sender_id;
          if (sid) counts[sid] = (counts[sid] || 0) + 1;
        });
      }
    } catch (e) { /* 명단 집계 실패해도 회원 목록은 내려줌 */ }

    const members = (Array.isArray(users) ? users : []).map(u => ({
      id: u.id,
      display_name: u.display_name || "",
      email: u.email || "",
      last_visit: u.last_visit || null,
      streak: u.streak || 0,
      provider: u.provider || "",
      created_at: u.created_at || null,
      recipient_count: counts[u.id] || 0
    }));

    return res.status(200).json({ ok: true, members, total: members.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "처리 중 오류가 났어요.", detail: String(e) });
  }
}
