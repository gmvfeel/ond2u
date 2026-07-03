// OND2U 콘텐츠 수정·삭제 함수 (콘텐츠 창고 관리)
// -------------------------------------------------------------
// 콘텐츠 창고 관리 화면에서 영상 교체·내용 수정·삭제를 하면 이 함수로 옵니다.
// 저장 함수와 똑같이, "지금 로그인한 사람이 관리자(파트너)인지" 확인한 뒤에만 동작해요.
//   - action:"update" → 넘어온 필드만 골라서 수정 (예: 영상 교체)
//   - action:"delete" → 해당 콘텐츠 삭제
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

  // 4) 요청 내용 꺼내기
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const action = body && body.action;
  const id = body && body.id;
  if (!id) return res.status(400).json({ ok: false, error: "콘텐츠 id가 없어요." });

  const base = SB_URL + "/rest/v1/odo_contents?id=eq." + encodeURIComponent(id);
  const headers = {
    "apikey": SB_SERVICE,
    "Authorization": "Bearer " + SB_SERVICE,
    "Content-Type": "application/json"
  };

  try {
    // ── 삭제 ──
    if (action === "delete") {
      const r = await fetch(base, { method: "DELETE", headers });
      if (!r.ok) return res.status(500).json({ ok: false, error: "삭제에 실패했어요.", detail: await r.text() });
      return res.status(200).json({ ok: true });
    }

    // ── 수정 ──
    if (action === "update") {
      const fields = (body && body.fields) || {};
      const allowed = {};
      ["video_id", "video_title", "quote", "quote_en", "author",
       "essay_title", "essay", "care_icon", "care_title", "care_body"].forEach(k => {
        if (fields[k] !== undefined) allowed[k] = fields[k];
      });
      if (Array.isArray(fields.mood_tags)) allowed.mood_tags = fields.mood_tags;

      if (!Object.keys(allowed).length)
        return res.status(400).json({ ok: false, error: "바꿀 내용이 없어요." });

      const r = await fetch(base, {
        method: "PATCH",
        headers: { ...headers, "Prefer": "return=representation" },
        body: JSON.stringify(allowed)
      });
      const out = await r.json();
      if (!r.ok) return res.status(500).json({ ok: false, error: "수정에 실패했어요.", detail: out });
      return res.status(200).json({ ok: true, saved: Array.isArray(out) ? out[0] : out });
    }

    return res.status(400).json({ ok: false, error: "알 수 없는 작업이에요." });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "처리 중 오류가 났어요.", detail: String(e) });
  }
}
