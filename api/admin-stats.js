// OND2U 대시보드 통계 (관리자 전용)
// - 함께하는 사람 / 콘텐츠 / 보낸 편지(전체·오늘) / 받은 반응(전체·오늘)
// - 관리자(ADMIN_EMAILS) 로그인 세션으로만 접근 가능

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.ODO_SUPABASE_URL;
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;
  if (!SB_URL || !SB_SERVICE) return res.status(500).json({ ok: false, error: "서버 설정(환경변수)이 아직 안 됐어요." });

  if (!(await isAdminReq(req, SB_URL, SB_SERVICE)))
    return res.status(401).json({ ok: false, error: "관리자만 볼 수 있어요." });

  const todayISO = kstTodayStartISO();

  try {
    const [members, contents, sends_total, sends_today, reactions_total, reactions_today, visits_total, visits_today] = await Promise.all([
      countRows(SB_URL, SB_SERVICE, "odo_users"),
      countRows(SB_URL, SB_SERVICE, "odo_contents"),
      countRows(SB_URL, SB_SERVICE, "odo_sends"),
      countRows(SB_URL, SB_SERVICE, "odo_sends", "created_at=gte." + todayISO),
      countRows(SB_URL, SB_SERVICE, "odo_reactions"),
      countRows(SB_URL, SB_SERVICE, "odo_reactions", "created_at=gte." + todayISO),
      countRows(SB_URL, SB_SERVICE, "odo_visits"),
      countRows(SB_URL, SB_SERVICE, "odo_visits", "created_at=gte." + todayISO)
    ]);
    return res.status(200).json({
      ok: true,
      stats: { members, contents, sends_total, sends_today, reactions_total, reactions_today, visits_total, visits_today }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}

// ── 관리자 여부 확인 (로그인 토큰 → 이메일 → ADMIN_EMAILS) ──
async function isAdminReq(req, SB_URL, SB_SERVICE) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  try {
    const uRes = await fetch(SB_URL + "/auth/v1/user", {
      headers: { "Authorization": "Bearer " + token, "apikey": SB_SERVICE }
    });
    const user = await uRes.json();
    const email = ((user && user.email) || "").toLowerCase();
    const admins = (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    return !!(email && admins.includes(email));
  } catch (e) { return false; }
}

// ── 특정 조건의 행 개수만 세기 (데이터는 안 가져옴) ──
async function countRows(url, key, table, filter) {
  const q = url + "/rest/v1/" + table + "?select=id" + (filter ? ("&" + filter) : "");
  const r = await fetch(q, {
    headers: { apikey: key, Authorization: "Bearer " + key, Prefer: "count=exact", Range: "0-0" }
  });
  const cr = r.headers.get("content-range") || "";  // 예: "0-0/149"
  const tot = cr.split("/")[1];
  return tot ? parseInt(tot, 10) : 0;
}

// ── 오늘(한국시각) 0시를 UTC ISO로 ──
function kstTodayStartISO() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear(), m = kst.getUTCMonth(), d = kst.getUTCDate();
  const utc = new Date(Date.UTC(y, m, d, 0, 0, 0) - 9 * 3600 * 1000);
  return utc.toISOString();
}
