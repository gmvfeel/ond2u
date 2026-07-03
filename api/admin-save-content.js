// OND2U 콘텐츠 저장 함수 (콘텐츠 공장 → 창고)
// -------------------------------------------------------------
// 콘텐츠 공장에서 "통과"를 누르면 콘텐츠 한 세트가 이 함수로 넘어와요.
// 이 함수는 "지금 로그인한 사람이 관리자(파트너)인지"를 먼저 확인하고,
// 관리자일 때만 창고(odo_contents)에 저장합니다.
// 관리자가 아니면 저장을 거부해요(403). → 아무나 콘텐츠를 밀어넣지 못해요.
//
// 관리자 이메일 목록은 Vercel 환경변수 ADMIN_EMAILS 에 넣어요 (쉼표로 구분).
// -------------------------------------------------------------

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  // 브라우저 사전 요청(OPTIONS) 허용
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST 방식만 돼요." });

  const SB_URL = process.env.ODO_SUPABASE_URL;
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;
  const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  if (!SB_URL || !SB_SERVICE)
    return res.status(500).json({ ok: false, error: "서버 설정(환경변수)이 아직 안 됐어요." });
  if (!ADMIN_EMAILS.length)
    return res.status(500).json({ ok: false, error: "관리자 이메일(ADMIN_EMAILS)이 설정되지 않았어요." });

  // 1) 로그인 토큰 꺼내기
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token)
    return res.status(401).json({ ok: false, error: "로그인이 필요해요." });

  // 2) 토큰으로 "누가 로그인했는지" 확인
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
    return res.status(403).json({ ok: false, error: "저장 권한이 없는 계정이에요.", email });

  // 4) 넘어온 콘텐츠 꺼내기 (Vercel이 JSON을 자동으로 객체로 만들어 주지만, 문자열일 때도 대비)
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const s = (body && body.set) || {};

  if (!s.quote || !s.essayTitle || !s.essay)
    return res.status(400).json({ ok: false, error: "명언·에세이 제목·에세이 본문은 꼭 있어야 해요." });

  // 5) 창고에 넣을 한 줄로 정리
  //    영상은 비워둡니다. videoSuggestion(검색어)만 제목 자리에 남겨둬요.
  //    → 저장 후 "콘텐츠 관리"에서 검사하면 자동으로 채울 대상으로 잡혀
  //       정상 영상으로 자동 채우기 하면 됩니다. (임베드 안 되는 영상이 박히는 일이 없어요.)
  const DEFAULT_VIDEO = ""; // 기본 영상 없음
  const ALLOWED_ICONS = ["tea", "breath", "sun", "walk", "stretch"];
  const icon = ALLOWED_ICONS.includes(s.careIcon) ? s.careIcon : "tea";

  const row = {
    kind: "normal",
    quote: s.quote,
    quote_en: s.quoteEn || "",
    author: s.author || "",
    mood_tags: Array.isArray(s.moodTags) ? s.moodTags : [],
    essay_title: s.essayTitle,
    essay: s.essay,               // 문단 사이 줄바꿈 그대로 저장
    video_id: DEFAULT_VIDEO,
    video_title: s.videoSuggestion || "",
    care_icon: icon,
    care_title: s.careTitle || "",
    care_body: s.careBody || ""
  };

  // 6) 창고에 저장
  try {
    const iRes = await fetch(SB_URL + "/rest/v1/odo_contents", {
      method: "POST",
      headers: {
        "apikey": SB_SERVICE,
        "Authorization": "Bearer " + SB_SERVICE,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify(row)
    });
    const saved = await iRes.json();
    if (!iRes.ok)
      return res.status(500).json({ ok: false, error: "창고 저장에 실패했어요.", detail: saved });
    return res.status(200).json({ ok: true, saved: Array.isArray(saved) ? saved[0] : saved });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "창고 저장 중 오류가 났어요.", detail: String(e) });
  }
}
