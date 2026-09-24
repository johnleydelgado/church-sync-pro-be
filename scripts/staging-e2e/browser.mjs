// Browser half of the staging end-to-end run. Driven by scripts/staging-e2e/run.sh, which
// sets `phase` in the state file before each call and runs the backend helpers in between.
// Runs inside ego-browser's Node runtime (`ego-browser nodejs < browser.mjs`), so the
// task space is visible live in Ego Lite. Deliberately paced so a person can follow it.
const fs = await import("node:fs/promises");
const STATE = "/tmp/csp-staging-e2e/state.json";
const st = JSON.parse(await fs.readFile(STATE, "utf8"));
const save = () => fs.writeFile(STATE, JSON.stringify(st, null, 2));

const KEY = "church-sync-pro-personal-token";
const LOGIN_EMAIL = 'input[placeholder="johndoe@gmail.com"]';
const PACE = 1500;

const task = st.spaceId ? await taskSpace(st.spaceId) : await taskSpace(`CSP staging E2E ${st.run}`);
st.spaceId = task.spaceId;
const page = task.page("p1");

const text = async () => (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
const token = () => page.evaluate((k) => localStorage.getItem(k), KEY);
const path = async () => new URL(await page.url()).pathname;
const watch = (ms = PACE) => page.waitForTimeout(ms);
const check = (name, ok, detail = "") => {
  st.results.push({ phase: st.phase, name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

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
  await page.click("loc=role:button[name='LOGIN']", { label: `log in as ${email.split("+")[1] ?? email}` });
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
  await page.waitForURL(/check-your-inbox|quick-start-guide|daily/, { timeout: 30000 });
  await watch();
  return { path: await path(), token: await token(), text: await text() };
};

const openVerifyLink = async (link) => {
  await page.goto(link);
  await page.waitForFunction(() => /confirmed|expired|wrong/i.test(document.body.innerText), undefined, { timeout: 20000 });
  await watch();
  return text();
};

const addChurch = async (name) => {
  await page.click("loc=role:button[name='NEW CLIENT']", { label: "open New Client" });
  await page.waitForSelector("input[name=churchName]", { timeout: 15000 });
  await watch(800);
  await page.fill("input[name=churchName]", name);
  await page.click("loc=role:button[name='UPDATE']", { label: `add church ${name}` });
  // Either the modal closes (success) or a toast explains why not - read whichever comes.
  await page.waitForFunction(() => !document.querySelector("[role=dialog]") || !!document.querySelector(".Toastify__toast"), undefined, { timeout: 30000 });
  await page.waitForTimeout(800);
  const toast = await page.evaluate(() => document.querySelector(".Toastify__toast")?.innerText?.trim() ?? "");
  const dialogOpen = await page.evaluate(() => !!document.querySelector("[role=dialog]"));
  if (dialogOpen) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
  }
  await watch();
  return toast || (dialogOpen ? "(modal stayed open, no toast)" : "Client created successfully!");
};

try {
  switch (st.phase) {
    case "A": {
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
      const v = await openVerifyLink(st.clientLink);
      check("verification link confirms the client", /Email confirmed/.test(v));
      const l = await login(st.client);
      check("verified client lands in the app", l.path === "/quick-start-guide", l.path);
      check("app token is 'client'", l.token === "client", String(l.token));

      const r = await signUp({ type: "bookkeeper", email: st.bk });
      check("bookkeeper sign-up stops at check-your-inbox", r.path === "/check-your-inbox", r.path);
      break;
    }
    case "C": {
      const v = await openVerifyLink(st.bkLink);
      check("verification link confirms the bookkeeper", /Email confirmed/.test(v));
      const l = await login(st.bk);
      check("verified bookkeeper lands in the app", l.path === "/quick-start-guide", l.path);
      check("app token is 'bookkeeper'", l.token === "bookkeeper", String(l.token));

      await page.goto(st.base + "/client-management/client-list");
      await page.waitForSelector("loc=role:button[name='NEW CLIENT']", { timeout: 20000 });
      await watch();
      await addChurch(st.church + " (via Clients page)");
      await page.reload();
      await page.waitForTimeout(5000);
      const rowsNow = await page.evaluate(() => [...document.querySelectorAll("table tr")].slice(1).map((r) => r.innerText.replace(/\s+/g, " ").trim()));
      check("church appears in the Clients list", rowsNow.some((r) => r.includes(st.church + " (via Clients page)")), rowsNow.join(" | "));
      check("bookkeeper is still themselves after adding a church", (await token()) === "bookkeeper" && (await text()).includes("Bookkeeper account"));
      const dup = await addChurch(st.church + " (via Clients page)");
      check("adding the same church again is refused", dup === "A church with this name already exists", dup);
      break;
    }
    case "D": {
      const l = await login(st.client);
      check("client logs in for the invite", l.path === "/quick-start-guide", l.path);
      await page.goto(st.base + "/settings?tab=bookkeeper");
      await page.waitForSelector("loc=role:button[name='ADD NEW BOOKKEEPER']", { timeout: 20000 });
      await watch();
      await page.click("loc=role:button[name='ADD NEW BOOKKEEPER']", { label: "open invite" });
      await page.waitForSelector('input[placeholder="type your e-mail here"]', { timeout: 15000 });
      await page.fill('input[placeholder="type your e-mail here"]', st.invitee);
      await watch(600);
      await page.click("loc=role:button[name='SEND']", { label: "send invitation" });
      await page.waitForTimeout(5000);
      check("invitation sent without an error toast", !/error|failed/i.test((await text()).slice(-200)));
      break;
    }
    case "E": {
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
      await page.waitForFunction(() => !!localStorage.getItem("church-sync-pro-personal-token") || /oops|wrong|check your inbox/i.test(document.body.innerText), undefined, { timeout: 40000 });
      await watch(3000);
      check("invitee is not stopped at check-your-inbox", (await path()) !== "/check-your-inbox" && (await token()) === "bookkeeper", `${await path()} token=${await token()}`);
      await page.click("text=Click to continue", { label: "continue into the app" });
      await page.waitForTimeout(5000);
      const t = await text();
      check("invitee lands in the app on the inviting church", (await path()) === "/daily" && t.includes(st.church), t.slice(0, 90));
      await page.screenshot({ path: "/tmp/csp-staging-e2e/invitee-in-app.png", scale: "css" });
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
if (st.phase === "E") await task.finish({ keep: [] });
