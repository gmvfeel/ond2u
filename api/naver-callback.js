// 네이버 로그인 콜백 처리
// 네이버에서 받은 code로 사용자 정보를 가져와 Supabase 계정/세션을 만들고,
// 편지 화면(app.html)으로 일회용 토큰을 붙여 돌려보낸다.
export default async function handler(req, res) {
  const { code, state } = req.query;
  const base = process.env.ODO_SUPABASE_URL;   // 창고 주소
  const svc  = process.env.ODO_SERVICE_KEY;    // 창고 관리자 키(service_role)
  const cid  = process.env.NAVER_CLIENT_ID;
  const csec = process.env.NAVER_CLIENT_SECRET;

  const fail = (why) => res.redirect(302, "/app.html#naver_error=" + why);

  if (!code) return fail("nocode");

  try {
    // 1) 네이버: code → access_token
    const tokenUrl =
      "https://nid.naver.com/oauth2.0/token?grant_type=authorization_code" +
      "&client_id=" + encodeURIComponent(cid) +
      "&client_secret=" + encodeURIComponent(csec) +
      "&code=" + encodeURIComponent(code) +
      "&state=" + encodeURIComponent(state || "");
    const tr = await fetch(tokenUrl);
    const td = await tr.json();
    const accessToken = td.access_token;
    if (!accessToken) return fail("token");

    // 2) 네이버: 사용자 프로필(이메일·닉네임)
    const mr = await fetch("https://openapi.naver.com/v1/nid/me", {
      headers: { Authorization: "Bearer " + accessToken },
    });
    const md = await mr.json();
    const email = md.response && md.response.email;
    const nickname =
      (md.response && (md.response.nickname || md.response.name)) || "네이버친구";
    if (!email) return fail("noemail");

    // 3) 창고에 사용자 생성 (이미 있으면 그냥 지나감)
    await fetch(base + "/auth/v1/admin/users", {
      method: "POST",
      headers: {
        apikey: svc,
        Authorization: "Bearer " + svc,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: email,
        email_confirm: true,
        user_metadata: { name: nickname, provider: "naver" },
      }),
    });

    // 4) 로그인용 일회성 토큰 발급 (magiclink)
    const gl = await fetch(base + "/auth/v1/admin/generate_link", {
      method: "POST",
      headers: {
        apikey: svc,
        Authorization: "Bearer " + svc,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "magiclink", email: email }),
    });
    const gld = await gl.json();
    const tokenHash =
      (gld.properties && gld.properties.hashed_token) || gld.hashed_token;
    if (!tokenHash) return fail("link");

    // 5) 편지 화면으로 돌려보내며 일회성 토큰 전달
    return res.redirect(
      302,
      "/app.html#naver_token=" + tokenHash + "&naver_email=" + encodeURIComponent(email)
    );
  } catch (e) {
    console.log("naver-callback 오류:", e);
    return fail("server");
  }
}
