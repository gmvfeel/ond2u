// OND2U 회원 삭제 함수 (관리자 전용)
// -------------------------------------------------------------
// 관리자(파트너)만 호출할 수 있어요. 넘어온 이메일의 회원을
// 창고 데이터(담은 글·기분·수신자·반응·발송기록·프로필)까지 모두 지우고,
// 마지막으로 로그인 계정(auth)까지 삭제합니다. 되돌릴 수 없어요.
//
// 안전장치:
//  - 로그인한 사람이 관리자(ADMIN_EMAILS)인지 확인
//  - 본인 계정은 삭제 거부 (실수 방지)
// -------------------------------------------------------------

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST 방식만 돼요." });

  const SB_URL = process.env.ODO_SUPABASE_URL;
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;
  const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

  if (!SB_URL || !SB_SERVICE)
    return res.status(500).json({ ok: false, error: "서버 설정(환경변수)이 아직 안 됐어요." });
  if (!ADMIN_EMAILS.length)
    return res.status(500).json({ ok: false, error: "관리자 이메일(ADMIN_EMAILS)이 설정되지 않았어요." });

  // 1) 로그인 토큰 → 누가 요청했는지
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "로그인이 필요해요." });

  let myEmail = "";
  try {
    const uRes = await fetch(SB_URL + "/auth/v1/user", {
      headers: { "Authorization": "Bearer " + token, "apikey": SB_SERVICE }
    });
    const user = await uRes.json();
    myEmail = ((user && user.email) || "").toLowerCase();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "로그인 확인에 실패했어요." });
  }
  if (!myEmail || !ADMIN_EMAILS.includes(myEmail))
    return res.status(403).json({ ok: false, error: "삭제 권한이 없는 계정이에요." });

  // 2) 삭제 대상 이메일
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const targetEmail = ((body && body.email) || "").trim().toLowerCase();
  if (!targetEmail)
    return res.status(400).json({ ok: false, error: "삭제할 회원 이메일이 없어요." });
  if (targetEmail === myEmail)
    return res.status(400).json({ ok: false, error: "본인 계정은 여기서 삭제할 수 없어요." });

  const H = { "apikey": SB_SERVICE, "Authorization": "Bearer " + SB_SERVICE, "Content-Type": "application/json" };

  // 3) 이메일 → 회원 id (odo_users)
  let userId = "";
  try {
    const r = await fetch(SB_URL + "/rest/v1/odo_users?email=eq." + encodeURIComponent(targetEmail) + "&select=id", { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length) userId = rows[0].id;
  } catch (e) {}
  if (!userId)
    return res.status(404).json({ ok: false, error: "해당 이메일의 회원을 찾지 못했어요." });

  // 4) 이 회원의 창고 데이터 삭제
  const deleted = {};
  async function del(table, col) {
    try {
      const r = await fetch(SB_URL + "/rest/v1/" + table + "?" + col + "=eq." + encodeURIComponent(userId), {
        method: "DELETE", headers: { ...H, "Prefer": "return=minimal" }
      });
      deleted[table] = r.ok;
    } catch (e) { deleted[table] = false; }
  }
  await del("odo_saved", "user_id");
  await del("odo_moods", "user_id");
  await del("odo_recipients", "sender_id");
  await del("odo_reactions", "sender_id");
  await del("odo_sends", "sender_id");
  await del("odo_users", "id");

  // 5) 로그인 계정(auth) 삭제
  let authDeleted = false;
  try {
    const r = await fetch(SB_URL + "/auth/v1/admin/users/" + userId, {
      method: "DELETE",
      headers: { "apikey": SB_SERVICE, "Authorization": "Bearer " + SB_SERVICE }
    });
    authDeleted = r.ok;
  } catch (e) {}

  return res.status(200).json({ ok: true, email: targetEmail, deleted, authDeleted });
}
