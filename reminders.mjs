// Reminder job: runs hourly, reads homeroom.json from your gist, and sends a summary to ntfy
// at the hour and days set in the dashboard's Customize tab.
const { GIST_ID, GIST_TOKEN, NTFY_TOPIC } = process.env;
if (!GIST_ID || !GIST_TOKEN || !NTFY_TOPIC) throw new Error("Missing GIST_ID, GIST_TOKEN or NTFY_TOPIC");

const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
  headers: { Authorization: `Bearer ${GIST_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "school-reminders" },
});
if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
const gist = await r.json();
const f = gist.files && gist.files["homeroom.json"];
if (!f) throw new Error("homeroom.json not found in the gist");
let txt = f.content;
if (f.truncated) txt = await (await fetch(f.raw_url)).text();
const d = JSON.parse(txt);

// Dates in Romania's time zone
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (s, n) => { const [y, m, dd] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const weekday = (s) => { const [y, m, dd] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); };
const days = [["Today", ymd], ["Tomorrow", addDays(ymd, 1)]];

// Scheduled runs only send at the hour and on the days chosen in the dashboard.
// Manual runs (Run workflow) always send, so you can test.
if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
  const rm = d.reminders || {};
  const hourNow = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bucharest", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  const isoDay = (weekday(ymd) + 6) % 7 + 1; // Monday = 1 ... Sunday = 7
  if (!rm.on) { console.log("Reminders are off."); process.exit(0); }
  if (hourNow !== Number(rm.hour)) { console.log("Not the reminder hour."); process.exit(0); }
  if (!(rm.days || []).map(Number).includes(isoDay)) { console.log("Not a reminder day."); process.exit(0); }
}

const courseName = (id) => { const c = (d.courses || []).find((x) => x.id === id); return c ? c.name : ""; };
const typeLabel = { homework: "Homework", test: "Test", project: "Project", listening: "Listening" };

function eventHits(ev, ds) {
  if (!ev.date || ds < ev.date) return false;
  if ((ev.skip || []).includes(ds)) return false;
  if (ev.repeat === "weekly") return weekday(ds) === weekday(ev.date);
  if (ev.repeat === "monthly") return ds.slice(8) === ev.date.slice(8);
  if (ev.repeat === "yearly") return ds.slice(5) === ev.date.slice(5);
  return ds <= (ev.end || ev.date);
}

const lines = [];
for (const [label, ds] of days) {
  const items = [];
  for (const t of d.tasks || []) {
    if (!t.done && t.due === ds) items.push(`${typeLabel[t.type] || "Assignment"}: ${t.title}${courseName(t.course) ? " (" + courseName(t.course) + ")" : ""}`);
  }
  for (const ev of d.events || []) {
    if (eventHits(ev, ds)) items.push(`Event: ${ev.title}${ev.time ? " at " + ev.time : ""}`);
  }
  for (const b of d.birthdays || []) {
    if (b.date && b.date.slice(5) === ds.slice(5) && !(b.skip || []).includes(ds)) items.push(`Birthday: ${b.name}`);
  }
  for (const c of d.counts || []) {
    if (c.start === ds) items.push(`${c.title} starts`);
    if (c.end === ds) items.push(`${c.title} ends`);
  }
  if (items.length) lines.push(`${label} (${ds}):`, ...items.map((i) => "- " + i), "");
}

if (!lines.length) {
  console.log("Nothing to remind today.");
} else {
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers: { Title: "School dashboard", Tags: "calendar" },
    body: lines.join("\n").trim(),
  });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
  console.log("Reminder sent.");
}
