// Reminder job: runs hourly, reads homeroom.json from your gist, and sends one summary to ntfy
// for the reminder times that match the current hour and day (set in the dashboard's Customize tab).
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

// Dates and hour in Romania's time zone
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const hourNow = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bucharest", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
const addDays = (s, n) => { const [y, m, dd] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const weekday = (s) => { const [y, m, dd] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); };
const isoDay = (weekday(ymd) + 6) % 7 + 1; // Monday = 1 ... Sunday = 7

// Which types to send: manual runs send everything; scheduled runs send the types of matching times
const ALL = { task: true, event: true, bday: true, cd: true };
const rm = d.reminders || {};
let types, taskWins;
if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
  types = ALL;
  taskWins = [0, 1, 3, 7];
} else {
  if (!rm.on) { console.log("Reminders are off."); process.exit(0); }
  const matching = (rm.rules || []).filter((x) => Number(x.hour) === hourNow && (x.days || []).map(Number).includes(isoDay));
  if (!matching.length) { console.log("No reminder time now."); process.exit(0); }
  types = { task: false, event: false, bday: false, cd: false };
  taskWins = [];
  for (const x of matching) {
    for (const k of Object.keys(types)) if (x.types && x.types[k]) types[k] = true;
    if (x.types && x.types.task) for (const w of x.taskWindows || []) if (!taskWins.includes(Number(w))) taskWins.push(Number(w));
  }
  if (!Object.values(types).some(Boolean)) { console.log("No types selected for this time."); process.exit(0); }
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

if (!lines.length) {
  console.log("Nothing to remind about.");
} else {
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers: { Title: "School dashboard", Tags: "calendar" },
    body: lines.join("\n").trim(),
  });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
  console.log("Reminder sent.");
}
