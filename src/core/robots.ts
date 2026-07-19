// robots.txt builder. Pure: no I/O.
//
// Points crawlers at the sitemap and declares Content Signals
// (contentsignals.org): `search` and `ai-input` are always `yes` — staying
// discoverable to search and agent-input crawlers is this project's entire
// purpose — while `ai-train` is opt-in via SPHERE_ALLOW_AI_TRAINING, off by
// default so a publisher must actively choose to permit training use.

export interface RobotsConfig {
  allowAiTraining: boolean;
}

export function renderRobotsTxt(config: RobotsConfig, origin: string): string {
  const base = origin.replace(/\/+$/, "");
  const aiTrain = config.allowAiTraining ? "yes" : "no";
  return [
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${base}/sitemap.xml`,
    "",
    `Content-Signal: search=yes, ai-input=yes, ai-train=${aiTrain}`,
    "",
  ].join("\n");
}
