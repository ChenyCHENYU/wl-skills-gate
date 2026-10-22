// Human-readable notification times. Machine evidence retains its original ISO timestamps.
const shanghai = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function formatNotificationTime(value) {
  // A timestamp without a zone must not depend on the notification host's timezone.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return "未提供有效时间";
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return "未提供有效时间";
  const parts = Object.fromEntries(shanghai.formatToParts(instant).map(({ type, value }) => [type, value]));
  return `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}:${parts.second}`;
}
