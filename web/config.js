// Optional live services. Neither is running, so both are off: the page joins
// the shared run (data/live) and shows the chrome://dino hall of fame
// (data/real-chrome). To enable again, set a URL here or per visit:
//   live server (server/main.ts):                   window.DINO_API / ?api=<url>
//   chrome://dino stream (scripts/real-chrome-live.mjs): window.DINO_REAL_CHROME / ?realchrome=<url>
window.DINO_API = "";
window.DINO_REAL_CHROME = "";
