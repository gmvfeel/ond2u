// OND2U 이메일 발송 함수 (6-2단계: 나에게 테스트 한 통)
// - 창고(Supabase)에서 명언 하나를 꺼내서
// - Resend로 지정한 주소에 편지 한 통을 보냄
// - 비밀 키(Resend, Supabase service_role)는 Vercel 환경변수에서 읽음 (코드/브라우저에 노출 안 함)
//
// 호출: /api/send-test?key=<CRON_SECRET>&to=<받을이메일>&from_name=<보내는이름>&bible=<1이면 성경도>

export default async function handler(req, res) {
  // CORS (테스트 편의)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── 0. 간단한 자물쇠: 아무나 이 주소를 못 부르게 ──
  const SECRET = process.env.CRON_SECRET;
  const givenKey = req.query.key || "";
  if (!SECRET || givenKey !== SECRET) {
    return res.status(401).json({ ok: false, error: "열쇠가 맞지 않아요." });
  }

  // ── 1. 필요한 값 읽기 ──
  const RESEND_KEY = process.env.RESEND_API_KEY;        // Resend 발송 열쇠
  const SB_URL = process.env.ODO_SUPABASE_URL;          // 창고 주소
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;       // 창고 비밀키(service_role)
  const FROM = process.env.ODO_FROM_EMAIL || "onboarding@resend.dev"; // 보내는 주소(도메인 없으면 테스트주소)

  if (!RESEND_KEY || !SB_URL || !SB_SERVICE) {
    return res.status(500).json({ ok: false, error: "서버 설정(환경변수)이 아직 안 됐어요.", need: ["RESEND_API_KEY","ODO_SUPABASE_URL","ODO_SERVICE_KEY"] });
  }

  const to = req.query.to;
  if (!to) return res.status(400).json({ ok: false, error: "받을 이메일(to)이 없어요." });
  const fromName = req.query.from_name || "윤기";
  const wantBible = req.query.bible === "1";

  try {
    // ── 2. 창고에서 콘텐츠 꺼내기 ──
    // 일반 콘텐츠 하나 (랜덤)
    const normal = await fetchContents(SB_URL, SB_SERVICE, "normal");
    if (!normal.length) throw new Error("창고에 일반 콘텐츠가 없어요.");
    const pickN = normal[Math.floor(Math.random() * normal.length)];

    // 성경도 원하면 하나 더
    let pickB = null;
    if (wantBible) {
      const bible = await fetchContents(SB_URL, SB_SERVICE, "bible");
      if (bible.length) pickB = bible[Math.floor(Math.random() * bible.length)];
    }

    // ── 3. 편지 HTML 만들기 ──
    const html = buildEmail({ fromName, normal: pickN, bible: pickB });

    // ── 4. Resend로 보내기 ──
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `오늘도 <${FROM}>`,
        to: [to],
        subject: `${fromName}님이 오늘도 보냅니다`,
        html
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ ok: false, error: "Resend 발송 실패", detail: data });

    return res.status(200).json({ ok: true, message: "보냈어요!", to, id: data.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}

// 창고에서 kind별 콘텐츠 가져오기 (service_role 키로 서버에서만)
async function fetchContents(url, key, kind) {
  const r = await fetch(`${url}/rest/v1/odo_contents?kind=eq.${kind}&select=*`, {
    headers: { "apikey": key, "Authorization": "Bearer " + key }
  });
  if (!r.ok) throw new Error("창고 읽기 실패: " + r.status);
  return await r.json();
}

// 편지 HTML (플럼 톤, 흰 배경)
function buildEmail({ fromName, normal, bible }) {
  const fix = s => (s || "").replace(/\\n/g, "<br>");
  const essayHtml = (normal.essay || "").replace(/\\n\\n/g, "</p><p>").replace(/\\n/g, "<br>");
  let bibleBlock = "";
  if (bible) {
    const bEssay = (bible.essay || "").replace(/\\n\\n/g, "</p><p>").replace(/\\n/g, "<br>");
    bibleBlock = `
      <div style="margin-top:36px; padding-top:32px; border-top:1px solid #e8e3f0;">
        <div style="font-size:12px; letter-spacing:0.1em; color:#5A4A7A; font-weight:700; margin-bottom:14px;">✝ 하나님께서 오늘 주신 말씀입니다</div>
        <div style="font-size:20px; font-weight:800; line-height:1.6; color:#2b2530;">${fix(bible.quote)}</div>
        <div style="font-size:13px; color:#8b8494; margin-top:10px;">— ${bible.author || ""}</div>
        <div style="font-size:14px; line-height:1.9; color:#4a4550; margin-top:18px;"><p style="margin:0 0 14px;">${bEssay}</p></div>
      </div>`;
  }

  return `<!doctype html><html><body style="margin:0; padding:0; background:#faf9f8;">
  <div style="max-width:560px; margin:0 auto; padding:40px 28px; font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;">
    <div style="background:#ffffff; border:1px solid #e8e3f0; border-radius:22px; padding:40px 34px;">
      <div style="font-size:13px; color:#8b8494; margin-bottom:6px;">${fromName}님이 오늘도 보냅니다</div>
      <div style="font-size:17px; font-weight:700; color:#5A4A7A; margin-bottom:28px;">오늘도 당신의 최고가 될 겁니다. 힘내세요.</div>

      <div style="font-size:22px; font-weight:800; line-height:1.6; color:#2b2530;">${fix(normal.quote)}</div>
      ${normal.quote_en ? `<div style="font-size:14px; font-style:italic; color:#8b8494; margin-top:12px;">${normal.quote_en}</div>` : ""}
      <div style="font-size:13px; color:#8b8494; margin-top:10px;">— ${normal.author || ""}</div>

      <div style="font-size:14px; line-height:1.9; color:#4a4550; margin-top:24px;"><p style="margin:0 0 14px;">${essayHtml}</p></div>

      ${bibleBlock}
    </div>
    <div style="text-align:center; font-size:12px; color:#b8b4c0; margin-top:20px;">오늘도 · OND2U</div>
  </div>
  </body></html>`;
}
