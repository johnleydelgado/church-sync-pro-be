// Browser half of the end-to-end run. Driven by scripts/staging-e2e/run.sh, which sets `phase` in
// the state file before each call and runs the backend helpers in between. Runs inside
// ego-browser's Node runtime (`ego-browser nodejs < browser.mjs`), so the task space is visible
// live in Ego Lite. Deliberately paced so a person can follow it.
//
// Selectors come from the frontend (church-sync-pro): the sidebar ChurchSwitcher, the Churches
// page (src/pages/Main/churches/) and the People tab (settings/component/People.tsx,
// InvitePersonModal.tsx). Buttons are clicked at their on-screen centre, the visible match only:
// the Churches page renders every row twice (table, and cards for narrow screens).
const fs = await import("node:fs/promises");
const STATE = "/tmp/csp-staging-e2e/state.json";
const st = JSON.parse(await fs.readFile(STATE, "utf8"));
const save = () => fs.writeFile(STATE, JSON.stringify(st, null, 2));

const KEY = "church-sync-pro-personal-token";
const LOGIN_EMAIL = 'input[placeholder="johndoe@gmail.com"]';
const SWITCHER = 'aside [aria-haspopup="dialog"]';
const PANEL = '[role="dialog"][aria-label="Switch church"]';
const DIALOG = '[role="dialog"]';
const NO_CHURCH = "No church yet. Add a church or manage churches";
const PACE = 1500;

let task;
try {
  task = st.spaceId ? await taskSpace(st.spaceId) : await taskSpace(st.space);
} catch {
  // A finished space (an earlier run's last stage) can't be resumed; its name is free again.
  task = await taskSpace(st.space);
}
st.spaceId = task.spaceId;
const page = task.page("p1");

const text = async () => (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
const token = () => page.evaluate((k) => localStorage.getItem(k), KEY);
const path = async () => new URL(await page.url()).pathname;
const watch = (ms = PACE) => page.waitForTimeout(ms);
const who = (email) => email.split("+")[1]?.split("@")[0] ?? email;
const check = (name, ok, detail = "") => {
  st.results.push({ phase: st.phase, name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
/** The switcher's label for the selected church: `Switch church. Current: <name>, <role>[, Inactive]`. */
const current = (name, ...detail) => `Switch church. Current: ${[name, ...detail].join(", ")}`;

/** Polls `fn` until `ok(value)`, then returns the value; returns the last value on timeout (for the check's detail). */
const settle = async (fn, ok, timeout = 20000) => {
  const end = Date.now() + timeout;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await page.waitForTimeout(300);
    v = await fn();
  }
  return v;
};
/** Like settle, but a step the run can't go on without: throws on timeout. */
const until = async (what, fn, timeout = 20000) => {
  const v = await settle(fn, Boolean, timeout);
  if (!v) throw new Error(`timed out waiting for ${what}`);
  return v;
};

/** The first visible element matching `css` (inside `within`, with exactly `text`), scrolled into view. */
const locate = (spec) =>
  page.evaluate(({ css, text, within }) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[inert]");
    };
    document.querySelectorAll("[data-e2e-target]").forEach((el) => el.removeAttribute("data-e2e-target"));
    const roots = within ? [...document.querySelectorAll(within)] : [document];
    for (const root of roots) {
      for (const el of root.querySelectorAll(css)) {
        if (!shown(el) || (text != null && norm(el.innerText) !== norm(text))) continue;
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        el.setAttribute("data-e2e-target", "1");
        return { x, y, covered: !hit || !(hit === el || el.contains(hit)), disabled: !!el.disabled };
      }
    }
    return null;
  }, spec);

/** Clicks what `spec` names, where a person would. Something drawn over it (a toast): a DOM click. */
const tap = async (spec, label, timeout = 20000) => {
  const t = await until(label, async () => {
    const found = await locate(spec);
    return found && !found.disabled ? found : null;
  }, timeout);
  if (t.covered) {
    await page.evaluate(() => document.querySelector("[data-e2e-target]")?.click());
  } else {
    await page.mouse.click(t.x, t.y, { label });
  }
  await page.evaluate(() => document.querySelectorAll("[data-e2e-target]").forEach((el) => el.removeAttribute("data-e2e-target")));
};
const gone = (what, css, timeout = 20000) =>
  until(what, () => page.evaluate((c) => !document.querySelector(c), css), timeout);

const assertOnSite = (link) => {
  // Never follow a link to another site: a local run must not end up signing up on staging.
  if (!link || !link.startsWith(`${st.base}/`)) throw new Error(`link is not on ${st.base}: ${link}`);
};
const verifyLink = (t) => `${st.base}/auth/verify-email?token=${t}&rid=emailverification`;
/** Whether a freshly minted verification link confirmed the address; the check's detail says why not. */
const confirmedDetail = (v) =>
  v === null
    ? "already verified (resumed run)"
    : /Email confirmed/.test(v)
    ? ""
    : /This link has expired/.test(v)
    ? "read 'expired': on `npm start` React StrictMode runs the verify effect twice, so test a production build"
    : v.slice(0, 120);

const freshSession = async () => {
  await page.goto(st.base + "/");
  await page.fetch(st.be + "/auth/signout", { method: "POST", headers: { rid: "session" }, credentials: "include" }).catch(() => {});
  await page.evaluate(() => { Object.keys(localStorage).forEach((k) => localStorage.removeItem(k)); });
  await page.reload();
};

const login = async (email) => {
  await freshSession();
  await page.waitForSelector(LOGIN_EMAIL, { timeout: 20000 });
  await watch(800);
  await page.fill(LOGIN_EMAIL, email);
  await page.fill("input[name=password]", st.password);
  await watch(600);
  await page.click("loc=role:button[name='LOGIN']", { label: `log in as ${who(email)}` });
  await page.waitForFunction(() => location.pathname !== "/" || /Oops|check email/i.test(document.body.innerText), undefined, { timeout: 30000 });
  await watch();
  return { path: await path(), token: await token(), text: await text() };
};

const signUp = async ({ type, email, churchName }) => {
  await freshSession();
  await page.goto(st.base + "/signup");
  await page.waitForSelector("text=Create an account", { timeout: 20000 });
  await watch(800);
  if (type === "bookkeeper") await page.click("loc=role:button[name='Bookkeeper']", { label: "choose bookkeeper account" });
  if (type === "client") await page.fill("input[name=churchName]", churchName);
  await page.fill("input[name=firstName]", "E2E");
  await page.fill("input[name=lastName]", type === "client" ? "Client" : "Bookkeeper");
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", st.password);
  await watch(600);
  await page.click("loc=role:button[name='Create account']", { label: `create ${type} account` });
  await page.waitForURL(/check-your-inbox|quick-start-guide|daily|transaction/, { timeout: 30000 });
  await watch();
  return { path: await path(), token: await token(), text: await text() };
};

const openVerifyLink = async (link) => {
  assertOnSite(link);
  await page.goto(link);
  await page.waitForFunction(() => /confirmed|expired|wrong/i.test(document.body.innerText), undefined, { timeout: 20000 });
  await watch();
  return text();
};

// ── The church switcher (sidebar) ──
const switcherLabel = () => page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-label") ?? null, SWITCHER);
/** Waits for the switcher to finish loading (it shows a placeholder until the church list arrives). */
const settledSwitcher = () => settle(switcherLabel, (l) => !!l && (l.startsWith("Switch church. Current:") || l === NO_CHURCH));
/** The selected church as redux-persist saved it: a full page load reads it back from there. */
const persistedName = () =>
  page.evaluate(() => {
    try {
      return JSON.parse(JSON.parse(localStorage.getItem("persist:root")).common).selectedChurch?.name ?? null;
    } catch {
      return null;
    }
  });
const openSwitcher = async () => {
  await tap({ css: SWITCHER }, "open the church switcher");
  await page.waitForSelector(PANEL, { timeout: 10000 });
  await watch(800);
};
const closeSwitcher = async () => {
  await page.keyboard.press("Escape");
  await gone("the switcher to close", PANEL, 10000);
};
/** Each church in the open switcher, as read aloud: `<name>, <role>[, Inactive]`. */
const switcherItems = () =>
  page.evaluate((p) =>
    [...document.querySelectorAll(`${p} li [data-switcher-item][aria-label]`)].map((b) => b.getAttribute("aria-label")), PANEL);
const chooseChurch = async (name, role) => {
  const label = await settledSwitcher();
  if (label?.startsWith(current(name) + ",")) return label;
  await openSwitcher();
  const items = await switcherItems();
  const item = items.find((i) => i.startsWith(`${name}, `));
  if (!item) throw new Error(`${name} is not in the switcher: ${items.join(" | ")}`);
  await tap({ within: PANEL, css: `[data-switcher-item][aria-label="${item}"]` }, `switch to ${name}`);
  const now = await until(`the switcher to show ${name}`, async () => {
    const l = await switcherLabel();
    return l?.startsWith(current(name, role)) ? l : null;
  });
  await until(`${name} to be saved as the selected church`, async () => (await persistedName()) === name);
  await watch();
  return now;
};
const addChurchFromSwitcher = async (name) => {
  await settledSwitcher();
  await openSwitcher();
  await tap({ within: PANEL, css: "button", text: "Add church" }, "Add church");
  await page.waitForSelector("#add-church-name", { timeout: 10000 });
  await watch(600);
  await page.fill("#add-church-name", name);
  await watch(600);
  await tap({ within: DIALOG, css: 'button[type="submit"]' }, `add ${name}`);
  await gone("the Add church dialog to close", "#add-church-name", 30000);
};

// ── The Churches page ──
const gotoChurches = async () => {
  await page.goto(st.base + "/churches");
  await until("the churches list", () => locate({ css: "[aria-label^='Open ']" }));
  await watch();
};
const renameChurch = async (from, to) => {
  await gotoChurches();
  await tap({ css: `[aria-label="Rename ${from}"]` }, `rename ${from}`);
  await page.waitForSelector("#rename-church-name", { timeout: 10000 });
  await page.fill("#rename-church-name", to);
  const typed = await page.evaluate(() => document.querySelector("#rename-church-name").value);
  if (typed !== to) throw new Error(`rename field reads "${typed}"`);
  await watch(600);
  await tap({ within: DIALOG, css: 'button[type="submit"]' }, "save the new name");
  await gone("the Rename dialog to close", "#rename-church-name", 30000);
};
const deactivateChurch = async (name) => {
  await gotoChurches();
  await tap({ css: `[aria-label="Deactivate ${name}"]` }, `deactivate ${name}`);
  const title = await until("the deactivate dialog", () => page.evaluate((d) => document.querySelector(`${d} h3`)?.innerText?.trim(), DIALOG));
  await watch(800);
  await tap({ within: DIALOG, css: "button", text: "Deactivate" }, "confirm deactivate");
  await gone("the deactivate dialog to close", DIALOG, 30000);
  return title;
};

// ── Settings: tabs and the People tab ──
const tabs = () => page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((t) => t.innerText.trim().toLowerCase()));
/** Opens People on the selected church; waits until the tabs and the list for `church` are drawn. */
const gotoPeople = async (church) => {
  await page.goto(st.base + "/settings?tab=people");
  await until(`People on ${church}`, () =>
    page.evaluate((name) => {
      const h = [...document.querySelectorAll("h2")].find((e) => e.innerText.trim() === `People on ${name}`);
      return !!h && !!document.querySelector("table tbody tr");
    }, church), 30000);
  await watch();
  // The People section only (the heading's container that holds the list), not the sidebar.
  const section = await page.evaluate(() => {
    let el = [...document.querySelectorAll("h2")].find((e) => e.innerText.trim().startsWith("People on "));
    while (el && !el.querySelector("table")) el = el.parentElement;
    return el ? el.innerText.replace(/\s+/g, " ").trim() : "";
  });
  return { tabs: await tabs(), text: section };
};
/** The People row for an address: its text, its access switch and its Remove button. */
const personRow = (email) =>
  page.evaluate((e) => {
    const tr = [...document.querySelectorAll("table tbody tr")].find((r) => r.innerText.toLowerCase().includes(e.toLowerCase()));
    if (!tr) return null;
    const sw = tr.querySelector('[role="switch"]');
    const rm = [...tr.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label").startsWith("Remove"));
    return {
      text: tr.innerText.replace(/\s+/g, " ").trim(),
      switchLabel: sw?.getAttribute("aria-label") ?? null,
      switchOn: sw ? sw.getAttribute("aria-checked") === "true" : null,
      switchBusy: sw ? sw.disabled : null,
      removeLabel: rm?.getAttribute("aria-label") ?? null,
    };
  }, email);
/** Invite someone from the People tab; returns the dialog's answer and closes it. */
const invite = async (email) => {
  await tap({ css: "button", text: "Invite someone" }, "open Invite someone");
  await page.waitForSelector("#invite-email", { timeout: 10000 });
  await watch(600);
  await page.fill("#invite-email", email);
  await watch(600);
  await tap({ within: DIALOG, css: 'button[type="submit"]' }, `invite ${who(email)}`);
  const answer = await until("the invite answer", () =>
    page.evaluate((d) => {
      const dialog = document.querySelector(d);
      const error = document.querySelector("#invite-email-error")?.innerText?.trim();
      if (error) return { title: "error", body: error, link: null };
      const title = dialog?.querySelector("h3")?.innerText?.trim();
      if (title !== "Added" && title !== "Invite ready") return null;
      return { title, body: dialog.innerText.replace(/\s+/g, " ").trim(), link: dialog.querySelector('[aria-label="Invite link"]')?.value ?? null };
    }, DIALOG), 30000);
  await watch();
  if (answer.title === "error") await page.keyboard.press("Escape");
  else await tap({ within: DIALOG, css: "button", text: "Done" }, "close the invite dialog");
  await gone("the invite dialog to close", DIALOG);
  return answer;
};
/** Flips a person's "can connect QuickBooks & Planning Center" switch to `on`; returns their row once saved. */
const setAccess = async (email, on) => {
  const row = await until(`${email} on People`, () => personRow(email));
  if (row.switchOn !== on) {
    await tap({ css: `[role="switch"][aria-label="${row.switchLabel}"]` }, `${on ? "allow" : "stop"} connecting for ${who(email)}`);
  }
  const after = await settle(() => personRow(email), (r) => r?.switchOn === on && !r.switchBusy);
  await watch();
  return after;
};
const removePerson = async (email) => {
  const row = await until(`${email} on People`, () => personRow(email));
  await tap({ css: `button[aria-label="${row.removeLabel}"]` }, `remove ${who(email)}`);
  const title = await until("the remove dialog", () => page.evaluate((d) => document.querySelector(`${d} h3`)?.innerText?.trim(), DIALOG));
  await watch(800);
  await tap({ within: DIALOG, css: "button", text: "Remove" }, "confirm remove");
  await gone("the remove dialog to close", DIALOG, 30000);
  const after = await settle(() => personRow(email), (r) => r === null);
  await watch();
  return { title, row, stillListed: after !== null };
};

/** A church endpoint called as the signed-in person, through the app's own (session-aware) fetch. */
const api = (method, url, body) =>
  page.evaluate(async ({ method, url, body }) => {
    const r = await fetch(url, {
      method,
      credentials: "include",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.status;
  }, { method, url, body });
const peopleStatus = (churchId) => api("GET", `${st.be}/csp/church/people?churchId=${churchId}`);

try {
  switch (st.phase) {
    case "A": {
      // The profile may hold a session from earlier work on this site; the verify page must not see it.
      await freshSession();
      const bogus = await openVerifyLink(`${st.base}/auth/verify-email?token=bogus&rid=emailverification`);
      check("bogus verification link shows the expired page", /This link has expired/.test(bogus));

      const r = await signUp({ type: "client", email: st.client, churchName: st.church });
      check("client sign-up stops at check-your-inbox", r.path === "/check-your-inbox", r.path);
      check("no app token after sign-up", r.token === null);
      check("inbox page names the address", r.text.includes(st.client));

      await page.goto(st.base + "/daily");
      await watch(2500);
      check("private route bounces to login while unverified", (await path()) === "/", await path());

      const l = await login(st.client);
      check("login while unverified goes back to check-your-inbox", l.path === "/check-your-inbox", l.path);
      check("still no app token", l.token === null);
      break;
    }
    case "B": {
      // A resumed run re-mints for an already-verified account and gets no token back.
      const v = st.clientToken ? await openVerifyLink(verifyLink(st.clientToken)) : null;
      check("verification link confirms the client", v === null || /Email confirmed/.test(v), confirmedDetail(v));
      const l = await login(st.client);
      check("verified client lands in the app", l.path === "/quick-start-guide", l.path);
      check("app token is 'client'", l.token === "client", String(l.token));
      const own = await settle(switcherLabel, (x) => x === current(st.church, "Owner"));
      check("the client's own church is selected in the switcher, role Owner", own === current(st.church, "Owner"), String(own));

      const r = await signUp({ type: "bookkeeper", email: st.bk });
      check("bookkeeper sign-up stops at check-your-inbox", r.path === "/check-your-inbox", r.path);
      break;
    }
    case "C": {
      const v = st.bkToken ? await openVerifyLink(verifyLink(st.bkToken)) : null;
      check("verification link confirms the bookkeeper", v === null || /Email confirmed/.test(v), confirmedDetail(v));
      const l = await login(st.bk);
      check("verified bookkeeper lands in the app", l.path === "/quick-start-guide", l.path);
      check("app token is 'bookkeeper'", l.token === "bookkeeper", String(l.token));
      const none = await settledSwitcher();
      check("a bookkeeper on no church sees 'No church yet' in the switcher", none === NO_CHURCH, String(none));

      await login(st.client);
      await addChurchFromSwitcher(st.church2);
      const added = await settle(switcherLabel, (x) => x === current(st.church2, "Owner"));
      check("church added from the switcher's Add church is selected, role Owner", added === current(st.church2, "Owner"), String(added));
      await openSwitcher();
      const items = await switcherItems();
      await closeSwitcher();
      check("the switcher lists both churches, Owner of each",
        items.length === 2 && items.includes(`${st.church}, Owner`) && items.includes(`${st.church2}, Owner`), items.join(" | "));

      await until(`${st.church2} to be saved as the selected church`, async () => (await persistedName()) === st.church2);
      await renameChurch(st.church2, st.church2New);
      const renamed = await settle(switcherLabel, (x) => x === current(st.church2New, "Owner"));
      check("renamed on the Churches page: the switcher shows the new name", renamed === current(st.church2New, "Owner"), String(renamed));

      await until(`${st.church2New} to be saved as the selected church`, async () => (await persistedName()) === st.church2New);
      const people = await gotoPeople(st.church2New);
      check("the owner sees Invite someone on People", !!(await locate({ css: "button", text: "Invite someone" })), people.text.slice(0, 120));

      const a = await invite(st.bk);
      check("inviting an existing login adds them straight away", a.title === "Added" && /already has a Church Sync Pro login/i.test(a.body), `${a.title}: ${a.body}`);
      const bkRow = await settle(() => personRow(st.bk), (r) => !!r && / Active /.test(` ${r.text} `));
      check("the bookkeeper is listed as an active Bookkeeper who can't connect yet",
        !!bkRow && /Bookkeeper/.test(bkRow.text) && / Active /.test(` ${bkRow.text} `) && bkRow.switchOn === false, JSON.stringify(bkRow));

      const b = await invite(st.invitee);
      st.inviteLink = b.link;
      check("inviting a new address shows an invite link to send", b.title === "Invite ready" && !!b.link && b.link.startsWith(`${st.base}/invite-bookkeeper?`),
        `${b.title}: ${b.link ?? b.body}`);
      const invRow = await settle(() => personRow(st.invitee), (r) => !!r && /hasn.t joined yet/i.test(r.text));
      check("the invitee is listed as invited, not joined yet", !!invRow && /hasn.t joined yet/i.test(invRow.text), invRow?.text ?? "not listed");
      break;
    }
    case "D": {
      assertOnSite(st.inviteLink);
      await freshSession();
      await page.goto(st.inviteLink);
      await page.waitForSelector("input[name=firstName]", { timeout: 20000 });
      await watch();
      check("invite link opens the sign-up form with the address filled", (await page.evaluate(() => document.querySelector("input[name=email]")?.value)) === st.invitee);
      await page.fill("input[name=firstName]", "E2E");
      await page.fill("input[name=lastName]", "Invitee");
      await page.fill("input[name=password]", st.password);
      await watch(600);
      await page.click("loc=role:button[name='Create account']", { label: "accept invitation" });
      await page.waitForFunction((k) => !!localStorage.getItem(k) || /oops|wrong|check your inbox/i.test(document.body.innerText), KEY, { timeout: 40000 });
      await watch(3000);
      check("invitee is not stopped at check-your-inbox", (await path()) !== "/check-your-inbox" && (await token()) === "bookkeeper", `${await path()} token=${await token()}`);
      await tap({ css: "a", text: "Click to continue" }, "continue into the app");
      const lbl = await settle(switcherLabel, (x) => x === current(st.church2New, "Bookkeeper"));
      check("invitee lands in the app on the inviting church, role Bookkeeper", lbl === current(st.church2New, "Bookkeeper"), `${await path()} ${lbl}`);
      await page.screenshot({ path: "/tmp/csp-staging-e2e/invitee-in-app.png", scale: "css" });
      break;
    }
    case "E": {
      await login(st.bk);
      const label = await settle(switcherLabel, (x) => x === current(st.church2New, "Bookkeeper"));
      await openSwitcher();
      const items = await switcherItems();
      await closeSwitcher();
      check("the bookkeeper's switcher lists the church, role Bookkeeper (and nothing else)",
        label === current(st.church2New, "Bookkeeper") && items.length === 1 && items[0] === `${st.church2New}, Bookkeeper`, `${label} | ${items.join(" | ")}`);

      const people = await gotoPeople(st.church2New);
      const note = `Only an owner of ${st.church2New} can invite or remove people.`;
      check("People shows the bookkeeper the owner-only note and no Invite button",
        people.text.includes(note) && !(await locate({ css: "button", text: "Invite someone" })), people.text.slice(0, 160));
      check("no Integrations tab for a bookkeeper who may not connect", people.tabs.includes("people") && !people.tabs.includes("integrations"), people.tabs.join(", "));

      const other = await peopleStatus(st.ownChurchId);
      check("a church they're not on answers 403 (GET /csp/church/people)", other === 403, `church ${st.ownChurchId}: ${other}`);
      const mine = await peopleStatus(st.churchId);
      check("their own church answers 200 (same endpoint)", mine === 200, `church ${st.churchId}: ${mine}`);
      const inv = await api("POST", `${st.be}/csp/church/people/invite`, { churchId: st.churchId, email: st.nobody });
      check("a bookkeeper can't invite: owner-only endpoint answers 403", inv === 403, `POST /csp/church/people/invite: ${inv}`);

      await login(st.client);
      await chooseChurch(st.church2New, "Owner");
      await gotoPeople(st.church2New);
      const on = await setAccess(st.bk, true);
      check("owner switches 'E2E Bookkeeper can connect QuickBooks & Planning Center' on",
        on?.switchOn === true && on.switchLabel === "E2E Bookkeeper can connect QuickBooks & Planning Center", JSON.stringify(on));
      break;
    }
    case "F": {
      await login(st.bk);
      await settle(switcherLabel, (x) => x === current(st.church2New, "Bookkeeper"));
      const people = await gotoPeople(st.church2New);
      check("with access on, the bookkeeper sees the Integrations tab", people.tabs.includes("integrations"), people.tabs.join(", "));

      await login(st.client);
      await chooseChurch(st.church2New, "Owner");
      await gotoPeople(st.church2New);
      const off = await setAccess(st.bk, false);
      check("owner switches it off again", off?.switchOn === false, JSON.stringify(off));
      break;
    }
    case "G": {
      await login(st.bk);
      await settle(switcherLabel, (x) => x === current(st.church2New, "Bookkeeper"));
      const before = await gotoPeople(st.church2New);
      check("with access off, the Integrations tab is gone again", !before.tabs.includes("integrations"), before.tabs.join(", "));

      await login(st.client);
      await chooseChurch(st.church2New, "Owner");
      await gotoPeople(st.church2New);
      const r = await removePerson(st.bk);
      check("owner removes the bookkeeper (confirm dialog), gone from People",
        r.title === `Remove E2E Bookkeeper from ${st.church2New}?` && r.row.removeLabel === "Remove E2E Bookkeeper" && !r.stillListed, JSON.stringify(r));

      const title = await deactivateChurch(st.church2New);
      const lbl = await settle(switcherLabel, (x) => x === current(st.church2New, "Owner", "Inactive"));
      check("owner deactivates the church: the switcher shows it Inactive",
        title === `Deactivate ${st.church2New}?` && lbl === current(st.church2New, "Owner", "Inactive"), `${title} | ${lbl}`);

      await login(st.bk);
      const none = await settledSwitcher();
      const status = await peopleStatus(st.churchId);
      check("the removed bookkeeper has no church left, and it answers 403", none === NO_CHURCH && status === 403, `${none} | church ${st.churchId}: ${status}`);
      break;
    }
    default:
      throw new Error(`unknown phase ${st.phase}`);
  }
} catch (e) {
  check(`phase ${st.phase} aborted`, false, e?.message ?? String(e));
  await save();
  process.exit(1);
}

await save();
if (st.phase === "G") await task.finish({ keep: [] });
