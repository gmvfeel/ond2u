// OND2U 발송 현황 목록 (관리자 전용)
// - 최근 발송 기록 200건 + 오늘(KST) 성공/실패 집계
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
  const H = { apikey: SB_SERVICE, Authorization: "Bearer " + SB_SERVICE };

  try {
    // 최근 발송 200건
    const listUrl = SB_URL + "/rest/v1/odo_sends"
      + "?select=id,sender_name,recipient_email,recipient_name,content_quote,status,error,created_at"
      + "&order=created_at.desc&limit=200";
    const r = await fetch(listUrl, { headers: H });
    const sends = await r.json().catch(() => []);

    // 오늘(KST) 성공/실패 정확 집계 (200건 제한과 무관하게)
    const today_success = await countRows(SB_URL, SB_SERVICE, "odo_sends", "status=eq.success&created_at=gte." + todayISO);
    const today_fail = await countRows(SB_URL, SB_SERVICE, "odo_sends", "status=neq.success&created_at=gte." + todayISO);

    // 오늘 성공분의 열람율 (Resend에 편지별로 물어봄) — open tracking 켜져 있어야 값이 잡힘
    const openStat = await todayOpenStats(SB_URL, SB_SERVICE, process.env.RESEND_API_KEY, todayISO);

    return res.status(200).json({
      ok: true,
      sends: Array.isArray(sends) ? sends : [],
      today_success,
      today_fail,
      today_open: openStat.open,
      today_open_checked: openStat.checked,
      today_open_capped: openStat.capped,
      total: Array.isArray(sends) ? sends.length : 0
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

// ── 오늘(KST) 성공 발송분의 열람율 (Resend에 편지별로 물어봄) ──
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function todayOpenStats(SB_URL, SB_SERVICE, RESEND_KEY, todayISO) {
  if (!RESEND_KEY) return { open: null, checked: 0, capped: false };
  const H = { apikey: SB_SERVICE, Authorization: "Bearer " + SB_SERVICE };
  const CAP = 120;
  let ids = [];
  try {
    const q = SB_URL + "/rest/v1/odo_sends?select=resend_id&status=eq.success&created_at=gte."
      + todayISO + "&order=created_at.desc&limit=" + CAP;
    const r = await fetch(q, { headers: H });
    const rows = await r.json().catch(() => []);
    ids = (Array.isArray(rows) ? rows : []).map(x => x && x.resend_id).filter(Boolean);
  } catch (e) { return { open: null, checked: 0, capped: false }; }
  if (!ids.length) return { open: 0, checked: 0, capped: false };

  let opened = 0, checked = 0;
  const RH = { Authorization: "Bearer " + RESEND_KEY };
  for (let i = 0; i < ids.length; i += 5) {
    const batch = ids.slice(i, i + 5);
    const evs = await Promise.all(batch.map(async id => {
      try {
        const er = await fetch("https://api.resend.com/emails/" + encodeURIComponent(id), { headers: RH });
        if (!er.ok) return null;
        const ed = await er.json();
        return (ed && ed.last_event) ? String(ed.last_event) : null;
      } catch (e) { return null; }
    }));
    for (const ev of evs) {
      if (ev == null) continue;
      checked++;
      if (ev === "opened" || ev === "clicked") opened++;
    }
    await sleep(200);
  }
  return { open: opened, checked, capped: ids.length >= CAP };
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
