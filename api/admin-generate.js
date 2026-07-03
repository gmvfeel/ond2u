// OND2U 콘텐츠 생성 함수 (콘텐츠 공장 → AI 호출)
// -------------------------------------------------------------
// 콘텐츠 공장에서 "콘텐츠 만들어줘"를 누르면 이 함수가 실행돼요.
// 웹페이지가 AI(Gemini)를 직접 부르면 CORS로 막히기 때문에,
// 이렇게 서버를 한 번 거쳐서 AI를 부릅니다. (서버끼리는 CORS 제한이 없어요.)
//
// 저장 함수와 똑같이, "지금 로그인한 사람이 관리자(파트너)인지" 확인한 뒤에만 작동해요.
// AI 키는 Vercel 환경변수 GEMINI_API_KEY 에서만 읽습니다.
// -------------------------------------------------------------

export const config = { maxDuration: 60 };

// 사용할 Gemini 모델 (필요하면 이 한 줄만 바꾸면 돼요)
const GEMINI_MODEL = "gemini-2.5-flash";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST 방식만 돼요." });

  const SB_URL = process.env.ODO_SUPABASE_URL;
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  if (!SB_URL || !SB_SERVICE)
    return res.status(500).json({ ok: false, error: "서버 설정(환경변수)이 아직 안 됐어요." });
  if (!GEMINI_KEY)
    return res.status(500).json({ ok: false, error: "AI 키(GEMINI_API_KEY)가 설정되지 않았어요." });
  if (!ADMIN_EMAILS.length)
    return res.status(500).json({ ok: false, error: "관리자 이메일(ADMIN_EMAILS)이 설정되지 않았어요." });

  // 1) 로그인 토큰 확인
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token)
    return res.status(401).json({ ok: false, error: "로그인이 필요해요." });

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

  // 4) 프롬프트 꺼내기
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const prompt = (body && body.prompt) || "";
  if (!prompt)
    return res.status(400).json({ ok: false, error: "만들 내용(프롬프트)이 없어요." });

  // 5) Gemini 호출
  //    (파트너님 노하우대로 responseMimeType은 안 쓰고, 최대 토큰을 넉넉히 잡음)
  try {
    const gRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + GEMINI_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.9, maxOutputTokens: 8000 }
        })
      }
    );
    const data = await gRes.json();
    if (!gRes.ok)
      return res.status(500).json({ ok: false, error: "AI 생성에 실패했어요.", detail: data });

    const cand = (data.candidates || [])[0] || {};
    const parts = (cand.content && cand.content.parts) || [];
    const text = parts.map(p => p.text || "").join("").trim();
    if (!text)
      return res.status(500).json({ ok: false, error: "AI 응답이 비어 있어요. 다시 시도해 주세요.", detail: data });

    return res.status(200).json({ ok: true, text });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "AI 생성 중 오류가 났어요.", detail: String(e) });
  }
}
