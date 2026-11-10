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

// Date, hour and minute in Romania's time zone
const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).formatToParts(new Date()).map((p) => [p.type, p.value]));
const ymd = `${parts.year}-${parts.month}-${parts.day}`;
const nowMin = Number(parts.hour) * 60 + Number(parts.minute);
const addDays = (s, n) => { const [y, m, dd] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const weekday = (s) => { const [y, m, dd] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); };
const isoDay = (weekday(ymd) + 6) % 7 + 1; // Monday = 1 ... Sunday = 7

const ALL = { task: true, event: true, bday: true, cd: true };
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

// Builds the summary for the chosen types and assignment windows (days from today)
function build(types, taskWins) {
  const blocks = [[0, "Today"], [1, "Tomorrow"], [3, "In 3 days"], [7, "In 7 days"]];
  const lines = [];
  for (const [w, label] of blocks) {
    const ds = addDays(ymd, w);
    const items = [];
    if (types.task && taskWins.includes(w)) for (const t of d.tasks || []) {
      if (!t.done && t.due === ds) items.push(`${typeLabel[t.type] || "Assignment"}: ${t.title}${courseName(t.course) ? " (" + courseName(t.course) + ")" : ""}`);
    }
    // Events, birthdays and countdowns are reported for today and tomorrow only
    if (w <= 1) {
      if (types.event) for (const ev of d.events || []) {
        if (eventHits(ev, ds)) items.push(`Event: ${ev.title}${ev.time ? " at " + ev.time : ""}`);
      }
      if (types.bday) for (const b of d.birthdays || []) {
        if (b.date && b.date.slice(5) === ds.slice(5) && !(b.skip || []).includes(ds)) items.push(`Birthday: ${b.name}`);
      }
      if (types.cd) for (const c of d.counts || []) {
        if (c.start === ds) items.push(`${c.title} starts`);
        if (c.end === ds) items.push(`${c.title} ends`);
      }
    }
    if (items.length) lines.push(`${label} (${ds}):`, ...items.map((i) => "- " + i), "");
  }
  return lines.join("\n").trim();
}

async function send(body, tag) {
  const headers = { Title: "School dashboard", Tags: ["calendar", ...(tag ? [tag] : [])].join(",") };
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
}

// Manual run: send everything once, for testing
if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
  const body = build(ALL, [0, 1, 3, 7]);
  if (!body) console.log("Nothing to remind about.");
  else { await send(body); console.log("Test reminder sent."); }
  process.exit(0);
}

const rm = d.reminders || {};
if (!rm.on) { console.log("Reminders are off."); process.exit(0); }

// Reminder times that are due now, grouped by hour
const due = {};
for (const x of rm.rules || []) {
  const h = Number(x.hour), start = h * 60;
  const days = (x.days || []).map(Number);
  if (!days.includes(isoDay)) continue;
  if (nowMin < start || nowMin >= start + 180) continue;
  (due[h] = due[h] || []).push(x);
}
if (!Object.keys(due).length) { console.log("No reminder due now."); process.exit(0); }

// Which reminders were already sent today (ntfy keeps recent messages for a while)
const pollRes = await fetch(`https://ntfy.sh/${NTFY_TOPIC}/json?poll=1&since=12h`);
if (!pollRes.ok) throw new Error(`ntfy poll answered ${pollRes.status}`);
const sentTags = new Set();
for (const line of (await pollRes.text()).split("\n")) {
  if (!line.trim()) continue;
  try { for (const t of JSON.parse(line).tags || []) sentTags.add(t); } catch { /* ignore */ }
}

for (const [h, rules] of Object.entries(due)) {
  const tag = `rm-${ymd}-${h}`;
  if (sentTags.has(tag)) { console.log(`Already sent for ${h}:00.`); continue; }
  const types = { task: false, event: false, bday: false, cd: false };
  const taskWins = [];
  for (const x of rules) {
    for (const k of Object.keys(types)) if (x.types && x.types[k]) types[k] = true;
    if (x.types && x.types.task) for (const w of x.taskWindows || []) if (!taskWins.includes(Number(w))) taskWins.push(Number(w));
  }
  if (!Object.values(types).some(Boolean)) { console.log(`No types selected for ${h}:00.`); continue; }
  const body = build(types, taskWins);
  if (!body) { console.log(`Nothing to remind about for ${h}:00.`); continue; }
  await send(body, tag);
  console.log(`Reminder sent for ${h}:00.`);
}
