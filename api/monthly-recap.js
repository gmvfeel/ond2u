// OND2U 월말 회고 편지 — 지난달의 마음을 편지로 보내드려요
// -------------------------------------------------------------
// 매월 1일(KST) cron이 호출해요. 지난 한 달 동안 남긴 마음·담은 글·
// 받은 반응을 회원별로 모아, "지난달의 당신"을 한 통의 편지로 보냅니다.
// 지난달에 아무 기록이 없는 회원은 건너뛰어요.
//
// 호출: /api/monthly-recap?key=<CRON_SECRET>
//   테스트: &month=YYYY-MM 으로 특정 달 지정, &only=<이메일> 로 한 명만
// -------------------------------------------------------------

export const config = { maxDuration: 60 };

const GROUP = {
  "지침":"heavy","번아웃":"heavy","슬픔":"heavy","외로움":"heavy",
  "불안":"anx","초조":"anx","막막":"anx","화남":"anx","미룸":"anx",
  "의욕":"bright","설렘":"bright","평온":"bright","감사":"bright","시작":"bright"
};

export default async function handler(req, res) {
  const SB_URL = process.env.ODO_SUPABASE_URL;
  const SB_SERVICE = process.env.ODO_SERVICE_KEY;
  const SECRET = process.env.CRON_SECRET;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.ODO_FROM_EMAIL || "letter@ond2u.com";

  // 인증
  const key = req.query.key || (req.headers["x-cron-secret"] || "");
  if (!SECRET || key !== SECRET) return res.status(401).json({ ok:false, error:"인증에 실패했어요." });
  if (!SB_URL || !SB_SERVICE || !RESEND_KEY) return res.status(500).json({ ok:false, error:"서버 설정(환경변수)이 아직 안 됐어요." });

  const H = { "apikey":SB_SERVICE, "Authorization":"Bearer "+SB_SERVICE, "Content-Type":"application/json" };

  // 지난달 범위 (KST 기준) → UTC로 변환해 조회
  const nowKst = new Date(Date.now() + 9*3600*1000);
  let y = nowKst.getUTCFullYear(), m = nowKst.getUTCMonth(); // 이번 달(0~11)
  if (req.query.month) { // YYYY-MM 지정 시 그 "다음 달 1일에 실행"한 셈으로 계산
    const mm = String(req.query.month).split("-");
    y = parseInt(mm[0],10); m = parseInt(mm[1],10); // m은 지정월(1~12) → 다음 달 인덱스로 쓰려고 그대로
  }
  // 지난달 = (y, m-1)
  const prevFirstKstMs = Date.UTC(y, m-1, 1, 0,0,0);
  const thisFirstKstMs = Date.UTC(y, m, 1, 0,0,0);
  const startUtc = new Date(prevFirstKstMs - 9*3600*1000).toISOString();
  const endUtc = new Date(thisFirstKstMs - 9*3600*1000).toISOString();
  const prevMonthNum = ((m-1)+12)%12 + 1;
  const label = prevMonthNum + "월";

  const onlyEmail = (req.query.only || "").trim().toLowerCase();

  async function getAll(path){
    try { const r = await fetch(SB_URL + "/rest/v1/" + path, { headers:H }); return await r.json(); }
    catch(e){ return []; }
  }

  // 회원 + 지난달 데이터 한 번에 모으기
  const [users, moods, saved, reactions] = await Promise.all([
    getAll("odo_users?select=id,email,display_name"),
    getAll("odo_moods?select=user_id,mood,created_at&created_at=gte."+encodeURIComponent(startUtc)+"&created_at=lt."+encodeURIComponent(endUtc)),
    getAll("odo_saved?select=user_id,saved_at&saved_at=gte."+encodeURIComponent(startUtc)+"&saved_at=lt."+encodeURIComponent(endUtc)),
    getAll("odo_reactions?select=sender_id,created_at&created_at=gte."+encodeURIComponent(startUtc)+"&created_at=lt."+encodeURIComponent(endUtc))
  ]);
  if (!Array.isArray(users)) return res.status(500).json({ ok:false, error:"회원을 불러오지 못했어요." });

  // 회원별 집계
  const stat = {}; // id → { gc, moodCount, savedN, reactCount }
  const ensure = id => (stat[id] = stat[id] || { gc:{heavy:0,anx:0,bright:0}, moodCount:0, savedN:0, reactCount:0 });
  (Array.isArray(moods)?moods:[]).forEach(r=>{ const s=ensure(r.user_id); s.moodCount++; const g=GROUP[r.mood]; if(g) s.gc[g]++; });
  (Array.isArray(saved)?saved:[]).forEach(r=>{ ensure(r.user_id).savedN++; });
  (Array.isArray(reactions)?reactions:[]).forEach(r=>{ ensure(r.sender_id).reactCount++; });

  let sent = 0, skipped = 0, failed = 0;
  const results = [];

  for (const u of users) {
    if (!u.email) { skipped++; continue; }
    if (onlyEmail && String(u.email).toLowerCase() !== onlyEmail) continue;
    const s = stat[u.id];
    if (!s || (s.moodCount===0 && s.savedN===0 && s.reactCount===0)) { skipped++; continue; }
    const name = (u.display_name && u.display_name.trim()) || "당신";
    const narr = buildNarr(label, s);
    const html = buildRecapEmail({ name, label, narr, s, email:u.email, secret:SECRET });
    const subject = label + ", 당신의 마음을 담았어요";
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method:"POST",
        headers:{ "Authorization":"Bearer "+RESEND_KEY, "Content-Type":"application/json" },
        body: JSON.stringify({ from: "오늘도 <"+FROM+">", to:[u.email], subject, html })
      });
      if (r.ok) { sent++; results.push({ email:u.email, ok:true }); }
      else { failed++; const t = await r.text().catch(()=> ""); results.push({ email:u.email, ok:false, error:t.slice(0,120) }); }
    } catch(e){ failed++; results.push({ email:u.email, ok:false, error:String(e&&e.message||e) }); }
  }

  return res.status(200).json({ ok:true, month:label, sent, skipped, failed, results });
}

function buildNarr(label, s){
  const parts = [];
  if (s.moodCount>0) parts.push(label+", 당신은 <b>"+s.moodCount+"</b>번 마음을 남겼어요.");
  let dom=null, max=0;
  for (const k of ["heavy","anx","bright"]) { if (s.gc[k]>max){ max=s.gc[k]; dom=k; } }
  if (dom==="heavy") parts.push("무거운 마음의 날이 많았지만, 그래도 매번 자신을 들여다본 당신이에요.");
  else if (dom==="anx") parts.push("마음이 분주한 날이 많았던 한 달이었어요. 그 속에서도 잠깐 멈춰 자신을 살핀 당신이 대견해요.");
  else if (dom==="bright") parts.push("밝은 마음이 자주 머문 한 달이었네요.");
  let sr="";
  if (s.savedN>0 && s.reactCount>0) sr="<b>"+s.savedN+"</b>편의 글을 마음에 담았고, <b>"+s.reactCount+"</b>번의 따뜻한 반응이 오갔어요.";
  else if (s.savedN>0) sr="<b>"+s.savedN+"</b>편의 글을 마음에 담았어요.";
  else if (s.reactCount>0) sr="<b>"+s.reactCount+"</b>번의 따뜻한 반응이 오갔어요.";
  if (sr) parts.push(sr);
  if (dom==="heavy") parts.push("그 발걸음 하나하나가, 이미 잘 버텨온 증거예요.");
  else if (dom==="bright") parts.push("그 온기가 다음 달까지 이어지길 바라요.");
  else if (dom==="anx") parts.push("조급하지 않아도 괜찮아요. 당신은 충분히 잘 하고 있어요.");
  else parts.push("이 모든 결이, 다 당신이었어요.");
  return parts.join(" ");
}

function buildRecapEmail({ name, label, narr, s, email, secret }) {
  const PLUM = "#423458", PLUM_DEEP = "#2f2440", ROSE = "#d97c93";
  const font = "'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif";
  const spacer = h => '<div style="height:'+h+'px; line-height:'+h+'px; font-size:0;">&nbsp;</div>';
  const crypto = require("crypto");
  const rParam = encodeURIComponent(email || "");
  const tok = secret ? crypto.createHmac("sha256", secret).update(email || "").digest("hex").slice(0,32) : "";
  const unsubUrl = "https://www.ond2u.com/api/unsubscribe?e=" + rParam + "&t=" + tok;
  const box = (n, lbl) => '<td align="center" style="padding:0 6px;"><div style="background:#f7f4f6; border-radius:12px; padding:16px 8px;"><div style="font-size:24px; font-weight:800; color:'+PLUM_DEEP+';">'+n+'</div><div style="font-size:12px; color:#7a7580; margin-top:4px;">'+lbl+'</div></div></td>';

  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"></head>' +
'<body style="margin:0; padding:0; background:#f3f1ef; font-family:'+font+';">' +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f1ef" style="background:#f3f1ef;"><tr>' +
'<td align="center" style="padding:36px 12px 56px; font-family:'+font+'; word-break:keep-all;">' +
  '<table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="width:680px; max-width:680px; background:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #eee;">' +
    '<tr><td bgcolor="'+PLUM+'" style="background:'+PLUM+'; padding:34px 28px; text-align:center;">' +
      '<div style="font-size:11px; letter-spacing:0.18em; color:rgba(255,255,255,.72); margin-bottom:10px;">지난달의 오늘도</div>' +
      '<div style="font-size:26px; font-weight:800; color:#ffffff; letter-spacing:-0.03em;">'+label+', 당신의 마음</div>' +
    '</td></tr>' +
    '<tr><td bgcolor="#ffffff" style="padding:34px 30px 8px;">' +
      '<div style="font-size:15px; color:#3a3540; margin-bottom:18px;"><b>'+name+'</b>님, 지난 한 달을 함께 돌아볼게요.</div>' +
      '<div style="font-size:16px; line-height:1.95; color:#3a3540;">'+narr+'</div>' +
      spacer(26) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
        box(s.savedN, "담은 글") + box(s.moodCount, "남긴 마음") + box(s.reactCount, "받은 반응") +
      '</tr></table>' +
      spacer(28) +
      '<div style="background:#fdeef2; border-radius:14px; padding:22px 24px; text-align:center;">' +
        '<div style="font-size:14px; line-height:1.8; color:'+PLUM_DEEP+';">이렇게 쌓인 하루하루가,<br>언젠가 세상에 단 하나뿐인 위로 책이 되기를 꿈꿔요.</div>' +
      '</div>' +
      spacer(24) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">' +
        '<a href="https://ond2u.com/app.html" style="display:inline-block; font-size:14px; font-weight:600; color:#ffffff; background:'+PLUM+'; text-decoration:none; padding:13px 28px; border-radius:30px;">오늘도에서 돌아보기 →</a>' +
      '</td></tr></table>' +
      spacer(20) +
    '</td></tr>' +
    '<tr><td bgcolor="#f3f1ef" style="padding:20px 28px; border-top:1px solid #eae7e3; text-align:center;">' +
      '<div style="font-size:11px; color:#b0aab6;">회고 편지를 그만 받고 싶으시면 <a href="'+unsubUrl+'" style="color:#b0aab6;">여기</a>를 눌러주세요.</div>' +
    '</td></tr>' +
  '</table>' +
  spacer(18) +
  '<div style="text-align:center; font-size:12px; color:#b0aab6;">오늘도 · OND2U</div>' +
'</td></tr></table></body></html>';
}
