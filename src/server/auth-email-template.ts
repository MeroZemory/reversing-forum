export const AUTH_VERIFICATION_TTL_SECONDS = 3600;
export const AUTH_RESET_TTL_SECONDS = 1800;

// Inline equivalents of the tokens.css subset checked by the template tests.
const design = {
  canvas: "#f2f4f3",
  panel: "#ffffff",
  ink: "#1c292d",
  muted: "#58686e",
  border: "#d6dfdc",
  header: "#162225",
  headerText: "#eef2f7",
  accent: "#f5bc78",
  primary: "#176857",
  onPrimary: "#ffffff",
  font: '"Pretendard", "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
  small: "14px",
  base: "15px",
  title: "26px",
  leading: "1.8",
  tight: "1.3",
  bold: "700",
  gap: "16px",
  padding: "24px",
  section: "32px",
  radius: "6px",
} as const;

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

/** The caller must validate the URL origin before rendering or sending. */
export function renderAuthEmail(url: string, reset = false) {
  const title = reset ? "비밀번호 재설정" : "이메일 인증";
  const subject = `[Reversing All] ${title}`;
  const introduction = reset
    ? "비밀번호 재설정을 요청하셨습니다. 아래 버튼을 눌러 새 비밀번호를 설정해 주세요."
    : "Reversing All에 오신 것을 환영합니다. 아래 버튼을 눌러 이메일 인증을 완료해 주세요.";
  const action = reset ? "비밀번호 재설정하기" : "이메일 인증하기";
  const ttl = reset ? AUTH_RESET_TTL_SECONDS : AUTH_VERIFICATION_TTL_SECONDS;
  const expiry = `이 링크는 발송 후 ${ttl / 60}분 동안 유효합니다.`;
  const fallback = "버튼이 보이지 않으면 아래 링크를 열어 주세요.";
  const fallbackLabel = reset ? "비밀번호 재설정 링크" : "이메일 인증 링크";
  const ignore = "직접 요청하지 않으셨다면 이 메일을 무시해 주세요.";
  const safeUrl = escapeHtml(url);
  const font = escapeHtml(design.font);
  const paragraph = `margin:0 0 ${design.gap};`;

  const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${design.canvas};color:${design.ink};font-family:${font};font-size:${design.base};line-height:${design.leading};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${action} · ${ttl / 60}분 동안 유효합니다.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;table-layout:fixed;background-color:${design.canvas};font-family:${font};font-size:${design.base};line-height:${design.leading};">
    <tr><td align="center" style="padding:${design.padding} 0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;table-layout:fixed;background-color:${design.panel};border:1px solid ${design.border};border-radius:${design.radius};">
        <tr><td style="padding:${design.padding};background-color:${design.header};color:${design.headerText};border-bottom:4px solid ${design.accent};font-size:${design.base};font-weight:${design.bold};">Reversing All</td></tr>
        <tr><td style="padding:${design.section} ${design.padding};">
          <h1 style="margin:0 0 ${design.gap};font-size:${design.title};line-height:${design.tight};font-weight:${design.bold};">${title}</h1>
          <p style="${paragraph}">${introduction}</p>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 ${design.gap};">
            <tr><td bgcolor="${design.primary}" style="background-color:${design.primary};border-radius:${design.radius};text-align:center;">
              <a href="${safeUrl}" style="display:inline-block;padding:12px ${design.padding};background-color:${design.primary};color:${design.onPrimary};font-weight:${design.bold};line-height:1.5;text-decoration:none;border-radius:${design.radius};">${action}</a>
            </td></tr>
          </table>
          <p style="${paragraph}color:${design.muted};font-size:${design.small};">${expiry}</p>
          <p style="margin:0;color:${design.muted};font-size:${design.small};">${fallback}<br>
            <a href="${safeUrl}" style="color:${design.primary};text-decoration:underline;">${fallbackLabel}</a>
          </p>
        </td></tr>
        <tr><td style="padding:${design.padding};border-top:1px solid ${design.border};color:${design.muted};font-size:${design.small};">${ignore}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    "Reversing All",
    title,
    introduction,
    action,
    expiry,
    fallback,
    url,
    ignore,
  ].join("\n\n");

  return { subject, html, text };
}
