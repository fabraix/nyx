const FONT_URL =
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap";

const STYLES = `
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:'JetBrains Mono',monospace;
  background:#fff;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:24px;
}
.container{width:100%;max-width:448px}
.logo{text-align:center;margin-bottom:32px;font-size:24px;font-weight:700;letter-spacing:-0.025em;color:#171717}
.card{border:1px solid #e5e5e5;padding:32px}
.header{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.prefix{color:#f97316;font-size:14px}
.title{color:#525252;font-size:14px;text-transform:uppercase;letter-spacing:0.05em}
.subtitle{font-size:14px;color:#737373;margin-bottom:24px}
.icon{display:flex;justify-content:center;margin-bottom:16px}
.body{text-align:center}
.error-box{border:1px solid #fecaca;background:#fef2f2;padding:16px}
.error-box p{font-size:14px;color:#991b1b;margin:0}
.error-box code{background:#fee2e2;padding:2px 6px}
.footer{margin-top:24px;text-align:center}
.footer p{font-size:11px;color:#a3a3a3}
.footer a{color:#a3a3a3;text-decoration:underline}
.footer a:hover{color:#525252}
code{font-family:'JetBrains Mono',monospace}
`;

const ICONS = {
  success: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>`,
  error: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>`,
};

function successBody(email?: string): string {
  return [
    `<p style="font-size:14px;color:#404040;margin:0 0 8px">Authentication successful.</p>`,
    email
      ? `<p style="font-size:13px;color:#737373;margin:0 0 8px">${email}</p>`
      : "",
    `<p style="font-size:13px;color:#737373;margin:0">You can close this tab and return to your terminal.</p>`,
  ].join("\n");
}

function errorBody(): string {
  return `<div class="error-box">
  <p>Authentication failed. Please run <code>nyx login</code> again.</p>
</div>`;
}

export function callbackPage(
  status: "success" | "error",
  email?: string,
): string {
  const isSuccess = status === "success";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Fabraix CLI Auth</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="${FONT_URL}" rel="stylesheet"/>
  <style>${STYLES}</style>
</head>
<body>
  <div class="container">
    <div class="logo">FABRAIX</div>
    <div class="card">
      <div class="header">
        <span class="prefix">${isSuccess ? "○" : "x"}</span>
        <span class="title">${isSuccess ? "CLI Authentication" : "Authentication Error"}</span>
      </div>
      <p class="subtitle">Nyx CLI authentication</p>
      <div class="icon">${ICONS[status]}</div>
      <div class="body">${isSuccess ? successBody(email) : errorBody()}</div>
    </div>
    <div class="footer">
      <p>
        <a href="https://www.fabraix.com/privacy-policy">Privacy Policy</a>
        &nbsp;&middot;&nbsp;
        <a href="https://www.fabraix.com/terms">Terms of Service</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}
